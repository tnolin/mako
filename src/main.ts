import { connect, migrate } from "./db"
import { createNotify } from "./delivery/notices"
import { initCursor, nftCutoff, startPoller } from "./delivery/poller"
import { startRetention } from "./delivery/retention"
import { startSender } from "./delivery/sender"
import { createViewer } from "./delivery/viewer"
import { createHealth } from "./health"
import { createHeartbeat } from "./heartbeat"
import { cursorBlock } from "./history"
import { referralLink, tradeLink } from "./launchpads"
import { createLinkServer, logNftClick, logTradeClick } from "./links"
import { log } from "./log"
import { ABOUT, GROUP_COMMANDS, PRIVATE_COMMANDS, SHORT_ABOUT } from "./menus/main"
import { createItemReader } from "./nft/opensea"
import { startReminders } from "./nft/reminders"
import type { NftState } from "./nft/state"
import { createBot } from "./platforms/telegram/bot"
import { createImages, sqlImageCache } from "./platforms/telegram/images"
import { createSend } from "./platforms/telegram/send"
import { setButtonColours } from "./platforms/telegram/ui"
import { rpcSqrtPrice } from "./pool"
import { createPrices } from "./prices"
import { DEFAULT_RPC, readDevHolds, rpcBalanceOf, rpcBlockNumber } from "./rpc"
import { initSentry } from "./sentry"

const env = process.env
const need = (k: string): string => {
  const v = env[k]
  if (!v) {
    console.error(`${k} is not set`)
    process.exit(2)
  }
  return v
}
const databaseUrl = need("DATABASE_URL")
const token = need("TELEGRAM_BOT_TOKEN")
const linksBase = need("LINKS_BASE_URL").replace(/\/$/, "")
const i = process.argv.indexOf("--from-id")
const fromId = i >= 0 ? process.argv[i + 1] : undefined
if (i >= 0 && !/^\d+$/.test(fromId ?? "")) {
  console.error("usage: main.ts [--from-id <numeric event id>]")
  process.exit(2)
}

setButtonColours(env.BUTTON_COLOURS !== "0")
const reporter = initSentry(env)
const report = (err: unknown, extra?: Record<string, unknown>) => reporter.capture(err, extra)
process.on("unhandledRejection", (err) => {
  log("error", "unhandled rejection", { error: String(err) })
  report(err)
})

const sql = connect(databaseUrl)
await migrate(sql)
await initCursor(sql, fromId)
const nftSince = env.NFT_ALERTS_SINCE
if (nftSince && !/^\d+$/.test(nftSince)) {
  console.error("NFT_ALERTS_SINCE must be unix seconds")
  process.exit(2)
}
const nftAlertsSince = nftSince ? Number(nftSince) : undefined
// Stores the first start time now, so the cutoff is not set by the first NFT event that arrives.
await nftCutoff(sql, nftAlertsSince)

// One NFT collection state, kept by the poller and read by the bot and the reminder scheduler.
const nftState: { current?: NftState } = {}
const prices = createPrices({ log, report: (m) => reporter.message(m) })
const stopPrices = prices.start()
const images = createImages({ fetch, cache: sqlImageCache(sql), log })
const readSqrtPrice = rpcSqrtPrice(env.INK_RPC_URL || DEFAULT_RPC)
// Without a key the NFT card and Trending say details are unavailable.
const items = env.OPENSEA_API_KEY
  ? createItemReader({ key: env.OPENSEA_API_KEY, sql, log })
  : undefined
const bot = createBot({
  token,
  sql,
  prices,
  log,
  report,
  linksBase,
  images,
  readSqrtPrice,
  nft: () => nftState.current,
  ...(items ? { items } : {}),
})
await bot.init()
const botUsername = bot.botInfo.username

await Promise.all([
  bot.api.setMyCommands(PRIVATE_COMMANDS, { scope: { type: "all_private_chats" } }),
  bot.api.setMyCommands(GROUP_COMMANDS, { scope: { type: "all_group_chats" } }),
  bot.api.setMyDescription(ABOUT),
  bot.api.setMyShortDescription(SHORT_ABOUT),
]).catch((err) => log("warn", "could not set commands or description", { error: String(err) }))

const balanceOf = rpcBalanceOf(env.INK_RPC_URL || DEFAULT_RPC)
const stopPoller = startPoller({
  sql,
  prices,
  log,
  report,
  readHolds: (r) => readDevHolds(balanceOf, r),
  nftAlertsSince,
  nftState,
})
const stopReminders = startReminders({ sql, nft: () => nftState.current, log })
const notify = createNotify({ sql, api: bot.api, botUsername, log })
const stopSender = startSender({
  sql,
  send: createSend(bot.api, { linksBase, botUsername, images, viewer: createViewer(sql) }),
  notify,
  log,
  report,
})

const server = createLinkServer({
  target: (ca) => tradeLink("inkypump", ca),
  join: () => referralLink("inkypump"),
  onClick: (ca, d) => logTradeClick(sql, ca, d),
  onNftClick: (target, d) => logNftClick(sql, target, d),
  log,
})
server.listen(Number(env.LINKS_PORT || 8080), "127.0.0.1")

const heartbeat = createHeartbeat({
  readBlock: () => cursorBlock(sql),
  checkIn: (s) => reporter.checkIn(s),
})
const heartbeatTimer = setInterval(() => void heartbeat.tick(), 60_000)
void heartbeat.tick()
const health = createHealth({
  sql,
  chainHead: rpcBlockNumber(env.INK_RPC_URL || DEFAULT_RPC),
  verdictOf: (c) => nftState.current?.get(c)?.col?.verdict,
  report: (e) => {
    log(e.level === "error" ? "error" : "info", "health", { message: e.message.split("\n")[0] })
    reporter.event(e)
  },
})
const healthTick = () =>
  void health.tick().catch((err) => log("warn", "health check failed", { error: String(err) }))
const healthTimer = setInterval(healthTick, 5 * 60_000)
healthTick()
const stopRetention = startRetention(sql, log, report)

let stopping = false
// shortcut: grammY handles updates one at a time, so a slow handler (linkChannel can wait up to 5 s for
// rights) delays the updates behind it. Upgrade path: run updates concurrently with @grammyjs/runner.
// If long polling dies (for example 409: another instance polls this token), exit so systemd restarts
// the whole process. The poller and sender must not keep running while menus are dead.
bot
  .start({
    allowed_updates: ["message", "callback_query", "my_chat_member"],
    onStart: () => log("info", "mako started", { bot: botUsername, linksBase }),
  })
  .then(() => {
    if (!stopping) throw new Error("Telegram long polling stopped")
  })
  .catch(async (err) => {
    if (stopping) return
    stopping = true
    log("error", "Telegram long polling stopped, exiting for a restart", { error: String(err) })
    reporter.capture(err)
    await reporter.flush(2000)
    process.exit(1)
  })

const shutdown = async () => {
  if (stopping) return
  stopping = true
  log("info", "shutting down")
  stopPoller()
  stopReminders()
  stopSender()
  stopPrices()
  stopRetention()
  clearInterval(heartbeatTimer)
  clearInterval(healthTimer)
  await bot.stop().catch(() => {})
  server.closeAllConnections()
  server.close()
  await sql.end({ timeout: 5 })
  await reporter.flush(2000)
  process.exit(0)
}
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())

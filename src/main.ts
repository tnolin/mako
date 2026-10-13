import { connect, migrate } from "./db"
import { createNotify } from "./delivery/notices"
import { initCursor, startPoller } from "./delivery/poller"
import { startRetention } from "./delivery/retention"
import { startSender } from "./delivery/sender"
import { createHeartbeat } from "./heartbeat"
import { cursorBlock } from "./history"
import { tradeLink } from "./launchpads"
import { createLinkServer, logTradeClick } from "./links"
import { log } from "./log"
import { createBot } from "./platforms/telegram/bot"
import { createSend } from "./platforms/telegram/send"
import { createPrices } from "./prices"
import { DEFAULT_RPC, readDevHolds, rpcBalanceOf } from "./rpc"
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

const reporter = initSentry(env)
const report = (err: unknown, extra?: Record<string, unknown>) => reporter.capture(err, extra)
process.on("unhandledRejection", (err) => {
  log("error", "unhandled rejection", { error: String(err) })
  report(err)
})

const sql = connect(databaseUrl)
await migrate(sql)
await initCursor(sql, fromId)

const prices = createPrices({ log, report: (m) => reporter.message(m) })
const stopPrices = prices.start()
const bot = createBot({ token, sql, prices, log, report, linksBase })
await bot.init()
const botUsername = bot.botInfo.username

const ABOUT = "Real-time alerts for memecoins, NFTs and DeFi on Ink. Open source."
await Promise.all([
  bot.api.setMyCommands(
    [
      { command: "start", description: "Start MAKO" },
      { command: "menu", description: "Main menu" },
      { command: "t", description: "Look up a token: /t <address>" },
      { command: "watch", description: "Watch a token: /watch <address>" },
      { command: "alerts", description: "My alerts" },
      { command: "help", description: "Help" },
      { command: "deletedata", description: "Delete my data" },
    ],
    { scope: { type: "all_private_chats" } },
  ),
  bot.api.setMyCommands(
    [
      { command: "t", description: "Look up a token: /t <address>" },
      { command: "setup", description: "Post MAKO alerts in this topic" },
      { command: "route", description: "Send chosen alerts to this topic" },
      { command: "help", description: "Help" },
    ],
    { scope: { type: "all_group_chats" } },
  ),
  bot.api.setMyDescription(ABOUT),
  bot.api.setMyShortDescription(ABOUT),
]).catch((err) => log("warn", "could not set commands or description", { error: String(err) }))

const balanceOf = rpcBalanceOf(env.INK_RPC_URL || DEFAULT_RPC)
const stopPoller = startPoller({
  sql,
  prices,
  log,
  report,
  readHolds: (r) => readDevHolds(balanceOf, r),
})
const notify = createNotify({ sql, api: bot.api, botUsername, log })
const stopSender = startSender({
  sql,
  send: createSend(bot.api, { linksBase, botUsername }),
  notify,
  log,
  report,
})

const server = createLinkServer({
  target: (ca) => tradeLink("inkypump", ca),
  onClick: (ca, d) => logTradeClick(sql, ca, d),
  log,
})
server.listen(Number(env.LINKS_PORT || 8080), "127.0.0.1")

const heartbeat = createHeartbeat({
  readBlock: () => cursorBlock(sql),
  checkIn: (s) => reporter.checkIn(s),
})
const heartbeatTimer = setInterval(() => void heartbeat.tick(), 60_000)
void heartbeat.tick()
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
  stopSender()
  stopPrices()
  stopRetention()
  clearInterval(heartbeatTimer)
  await bot.stop().catch(() => {})
  server.closeAllConnections()
  server.close()
  await sql.end({ timeout: 5 })
  await reporter.flush(2000)
  process.exit(0)
}
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())

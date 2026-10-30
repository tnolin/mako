// Queues alerts for past events without sending them, for local acceptance replays. Local databases only.
//   pnpm tsx --env-file=.env scripts/queue-from.ts <fromId> [toId] [--now block|<unix seconds>]
// MCAP TARGET fires only on events from the last 30 minutes. `--now block` runs each event's rules as if it had just
// happened, so a replay of older history can fire it; `--now <unix seconds>` sets one fixed clock instead.
// Then make the queued alerts current and skip the later history, and start the bot:
//   update bot.deliveries set event_ts = now() where status = 'pending';
//   update bot.state set value = (select max(id)::text from indexer.events) where key = 'events_cursor';
//   pnpm start
import { connect } from "../src/db"
import { initCursor, pollOnce } from "../src/delivery/poller"
import { log } from "../src/log"
import { createPrices } from "../src/prices"
import { DEFAULT_RPC, readDevHolds, rpcBalanceOf } from "../src/rpc"
import { rulesFor } from "../src/rules/index"
import { PumpArm } from "../src/rules/pump-arm"

const USAGE = "usage: queue-from.ts <fromId> [toId] [--now block|<unix seconds>]"
const fail = (msg: string): never => {
  console.error(msg)
  process.exit(2)
}

/** Replays rewrite the cursor and insert deliveries, so only a local database is acceptable. */
function isLocal(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host.endsWith(".localhost") ||
      host.endsWith(".test")
    )
  } catch {
    return false
  }
}

const args = process.argv.slice(2)
const nowAt = args.indexOf("--now")
const nowArg = nowAt >= 0 ? args.splice(nowAt, 2)[1] : undefined
if (nowAt >= 0 && (nowArg === undefined || (nowArg !== "block" && !/^\d+$/.test(nowArg))))
  fail(USAGE)
const [from, to] = args
const url = process.env.DATABASE_URL
if (!from || !/^\d+$/.test(from) || (to !== undefined && !/^\d+$/.test(to)) || !url) fail(USAGE)
if (to !== undefined && BigInt(to) < BigInt(from!)) fail(USAGE)
if (!isLocal(url!)) fail("refusing to run: DATABASE_URL must point at localhost")

const sql = connect(url!)
const prices = createPrices({ log })
await prices.refresh()
await initCursor(sql, from!)
const balanceOf = rpcBalanceOf(process.env.INK_RPC_URL || DEFAULT_RPC)
// One re-arm state for the whole replay, as the running bot keeps one, so a pump spanning two batches sends once.
const pumpArm = new PumpArm()
const fixedNow = nowArg !== undefined && nowArg !== "block" ? Number(nowArg) : undefined
const clock =
  nowArg === "block"
    ? {
        rules: ((ev, ctx, prev) =>
          rulesFor(ev, { ...ctx, now: () => ev.p.blockTimestamp }, prev)) as typeof rulesFor,
      }
    : fixedNow !== undefined
      ? { now: () => fixedNow }
      : {}
for (;;) {
  const n = await pollOnce({
    sql,
    prices,
    log,
    report: () => {},
    readHolds: (r) => readDevHolds(balanceOf, r),
    maxId: to,
    // A local database is filled long after the blocks, so every trade would count as written late.
    keepLateWrites: true,
    pumpArm,
    ...clock,
  })
  const [c] = await sql<
    { value: string }[]
  >`select value from bot.state where key = 'events_cursor'`
  console.log(`read ${n} events, cursor ${c!.value}`)
  if (n === 0) break
}
console.log(
  await sql`select alert, count(*)::int from bot.deliveries where status = 'pending' group by 1 order by 1`,
)
await sql.end()

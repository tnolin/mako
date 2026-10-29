// Queues alerts for past events without sending them, for local acceptance replays. Local databases only.
//   pnpm tsx --env-file=.env scripts/queue-from.ts <fromId> [toId]
// Then make the queued alerts current and skip the later history, and start the bot:
//   update bot.deliveries set event_ts = now() where status = 'pending';
//   update bot.state set value = (select max(id)::text from indexer.events) where key = 'events_cursor';
//   pnpm start
import { connect } from "../src/db"
import { initCursor, pollOnce } from "../src/delivery/poller"
import { log } from "../src/log"
import { createPrices } from "../src/prices"
import { DEFAULT_RPC, readDevHolds, rpcBalanceOf } from "../src/rpc"
import { PumpArm } from "../src/rules/pump-arm"

const USAGE = "usage: queue-from.ts <fromId> [toId]"
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

const [from, to] = process.argv.slice(2)
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

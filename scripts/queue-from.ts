// Queues alerts for past events without sending them, for local acceptance replays:
//   pnpm tsx --env-file=.env scripts/queue-from.ts <fromId> [toId]
// Then reset event_ts to now() for pending rows, move the cursor to the newest event, and `pnpm start`
// (the local acceptance steps list the commands).
import { connect } from "../src/db"
import { initCursor, pollOnce } from "../src/delivery/poller"
import { log } from "../src/log"
import { createPrices } from "../src/prices"
import { DEFAULT_RPC, readDevHolds, rpcBalanceOf } from "../src/rpc"

const USAGE = "usage: queue-from.ts <fromId> [toId]"
const [from, to] = process.argv.slice(2)
const url = process.env.DATABASE_URL
if (!from || !/^\d+$/.test(from) || (to !== undefined && !/^\d+$/.test(to)) || !url) {
  console.error(USAGE)
  process.exit(2)
}
const sql = connect(url)
const prices = createPrices({ log })
await prices.refresh()
await initCursor(sql, from)
const balanceOf = rpcBalanceOf(process.env.INK_RPC_URL || DEFAULT_RPC)
for (;;) {
  const n = await pollOnce({
    sql,
    prices,
    log,
    report: () => {},
    readHolds: (r) => readDevHolds(balanceOf, r),
  })
  const [c] = await sql<
    { value: string }[]
  >`select value from bot.state where key = 'events_cursor'`
  if (n === 0 || (to !== undefined && BigInt(c!.value) >= BigInt(to))) break
}
console.log(
  await sql`select alert, count(*)::int from bot.deliveries where status = 'pending' group by 1 order by 1`,
)
await sql.end()

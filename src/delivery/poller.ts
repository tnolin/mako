import type postgres from "postgres"
import type { Sql } from "../db"
import { eventsAfter, maxEventId } from "../history"
import type { Logger } from "../log"
import type { Prices } from "../prices"
import type { DevHolds, HoldsReq } from "../rpc"
import { type Candidate, rulesFor, withDevHolds } from "../rules/index"
import { createFailureLimiter } from "./limit"
import { type Delivery, loadAudience, route } from "./recipients"

export type PollerDeps = {
  sql: Sql
  prices: Prices
  log: Logger
  report: (err: unknown, extra?: Record<string, unknown>) => void
  readHolds: (r: HoldsReq) => Promise<DevHolds>
  rules?: typeof rulesFor
  /** Shared by startPoller so rule-failure reports are rate-limited across batches. */
  limiter?: ReturnType<typeof createFailureLimiter>
  /** Upper bound (inclusive) on the event ids read. Set only by the replay script; unset in production. */
  maxId?: string
}

/** postgres.js and Node network errors carry a string `code`; a rule's own bugs do not. */
function isInfraError(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string"
  )
}

async function setCursor(sql: Sql, value: string): Promise<void> {
  await sql`
    insert into bot.state (key, value) values ('events_cursor', ${value})
    on conflict (key) do update set value = excluded.value`
}

/** Sets the cursor to `fromId` when given; on first start, to the newest event id (no replay). */
export async function initCursor(sql: Sql, fromId?: string): Promise<string> {
  if (fromId !== undefined) {
    await setCursor(sql, fromId)
    return fromId
  }
  const [row] = await sql<
    { value: string }[]
  >`select value from bot.state where key = 'events_cursor'`
  if (row) return row.value
  const max = await maxEventId(sql)
  await setCursor(sql, max)
  return max
}

/** Inserts deliveries and moves the cursor in one short transaction. No network calls inside. */
async function write(sql: Sql, all: Delivery[], cursor: string): Promise<void> {
  await sql.begin(async (tx) => {
    // The audience was read before this write (DEV SELL waits on RPC), so a user may have deleted their
    // data since. A DM row needs a live user; the share lock makes Delete my data wait for this commit
    // and then remove the row it just wrote.
    const dmIds = [...new Set(all.filter((r) => r.chatType === "private").map((r) => r.chatId))]
    const live =
      dmIds.length === 0
        ? new Set<string>()
        : new Set(
            (
              await tx<{ id: string }[]>`
                select platform_user_id::text as id from bot.users
                where platform_user_id = any(${dmIds}::bigint[]) for share`
            ).map((u) => u.id),
          )
    const rows = all.filter((r) => r.chatType !== "private" || live.has(r.chatId))
    // 9 columns per row; 1,000 rows stays well under Postgres' 65,535 parameters.
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000).map((r) => ({
        chat_id: r.chatId,
        chat_type: r.chatType,
        thread_id: r.threadId,
        alert: r.alert,
        token: r.token,
        dedupe_key: r.dedupeKey,
        priority: r.priority,
        event_ts: new Date(r.eventTs * 1000),
        card: tx.json(r.payload as unknown as postgres.JSONValue),
      }))
      await tx`insert into bot.deliveries ${tx(chunk)} on conflict (chat_id, dedupe_key) do nothing`
    }
    for (const r of rows.filter((r) => r.supersedesBonding)) {
      await tx`
        update bot.deliveries set status = 'superseded'
        where chat_id = ${r.chatId} and token = ${r.token} and alert = 'bonding' and status = 'pending'`
    }
    await tx`
      insert into bot.state (key, value) values ('events_cursor', ${cursor})
      on conflict (key) do update set value = excluded.value`
  })
}

// shortcut: a fixed batch of 500 events per pass (a full batch runs again at once), and an event whose
// rule throws a non-database error is logged and skipped, so its alerts are lost. Upgrade path: make the
// batch size configurable, and park failed events in a table for replay.
/** Processes one batch of up to 500 confirmed events. Returns how many events it read. */
export async function pollOnce(deps: PollerDeps): Promise<number> {
  const { sql, log } = deps
  const cursor = await initCursor(sql)
  const events = await eventsAfter(sql, cursor, 500, deps.maxId)
  if (events.length === 0) return 0
  const rules = deps.rules ?? rulesFor
  const limiter = deps.limiter ?? createFailureLimiter({ report: deps.report, log })
  const cands: Candidate[] = []
  let skipped = 0
  for (const ev of events) {
    try {
      cands.push(...(await rules(ev, { sql, prices: deps.prices, log })))
    } catch (err) {
      // Database and connection errors fail the whole batch: the cursor stays and the loop retries.
      // Anything else is a bad event; skip it so one poison event cannot stall every chat.
      if (isInfraError(err)) throw err
      skipped++
      log("error", "rule failed, event skipped", { id: ev.id, error: String(err) })
      limiter.fail("rule", err)
    }
  }
  if (skipped === 0) limiter.ok("rule")
  const deliveries = route(cands, await loadAudience(sql, [...new Set(cands.map((c) => c.token))]))
  const lastId = events.at(-1)!.id
  const dev = deliveries.filter((d) => d.alert === "devsell")
  const rest = deliveries.filter((d) => d.alert !== "devsell")
  // Start the dev holds reads first; the other alerts are written while they run.
  const reads = new Map<string, Promise<DevHolds>>()
  for (const d of dev) {
    if (d.holds && !reads.has(d.eventId))
      reads.set(
        d.eventId,
        deps.readHolds(d.holds).catch(() => null),
      )
  }
  const firstDev = dev.reduce<bigint | null>((m, d) => {
    const id = BigInt(d.eventId)
    return m === null || id < m ? id : m
  }, null)
  await write(sql, rest, firstDev === null ? lastId : String(firstDev - 1n))
  if (dev.length > 0) {
    const holds = new Map<string, DevHolds>()
    for (const [id, p] of reads) holds.set(id, await p)
    const filled = dev.map((d) =>
      d.payload.type === "card"
        ? {
            ...d,
            payload: {
              ...d.payload,
              card: withDevHolds(d.payload.card, holds.get(d.eventId) ?? null),
            },
          }
        : d,
    )
    await write(sql, filled, lastId)
  }
  log("debug", "poller batch", {
    events: events.length,
    deliveries: deliveries.length,
    cursor: lastId,
  })
  return events.length
}

/** Polls every second, straight away again after a full batch. Returns a stop function. */
export function startPoller(deps: PollerDeps): () => void {
  const limiter = createFailureLimiter({ report: deps.report, log: deps.log })
  const shared = { ...deps, limiter }
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const loop = async () => {
    let wait = 1000
    try {
      if ((await pollOnce(shared)) === 500) wait = 0
      limiter.ok("poller")
    } catch (err) {
      wait = 5000
      try {
        limiter.fail("poller", err)
      } catch {
        // Reporting must never end the loop; the next pass retries.
      }
    }
    if (!stopped) timer = setTimeout(loop, wait)
  }
  void loop()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

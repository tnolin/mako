import type {
  IndexerEvent,
  LaunchEvent,
  NftCollectionEvent,
  NftDropEvent,
  NftEvent,
} from "@ink-indexer/events"
import type postgres from "postgres"
import type { Sql } from "../db"
import { eventsAfter, launchesAround, maxEventId, type Row } from "../history"
import type { Logger } from "../log"
import { loadNftState, type NftState } from "../nft/state"
import type { Prices } from "../prices"
import type { DevHolds, HoldsReq } from "../rpc"
import { type Candidate, rulesFor, withDevHolds } from "../rules/index"
import { PRIORITY } from "../settings"
import {
  FLOOD_WINDOW_S,
  type FloodRow,
  floodRows,
  floodStarts,
  MAX_LOOKBACK_S,
  uncertainStarts,
} from "./flood"
import { createFailureLimiter } from "./limit"
import { type Delivery, loadAudience, newTokenChats, route } from "./recipients"

export type PollerDeps = {
  sql: Sql
  prices: Prices
  log: Logger
  report: (err: unknown, extra?: Record<string, unknown>) => void
  readHolds: (r: HoldsReq) => Promise<DevHolds>
  rules?: typeof rulesFor
  /** Shared by startPoller so rule-failure reports are rate-limited across batches. */
  limiter?: ReturnType<typeof createFailureLimiter>
  /**
   * Holds the NFT collection state between passes, so it is rebuilt from the cursor only once (startPoller
   * sets it). Unset, every pass rebuilds it, which is what a test calling pollOnce wants.
   */
  nftState?: { current?: NftState }
  /** Unix seconds. NFT_ALERTS_SINCE, when set: it replaces the stored start time below. */
  nftAlertsSince?: number
  /** Unix seconds; tests set it. */
  now?: () => number
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

const nowS = () => Math.floor(Date.now() / 1000)

/**
 * The time before which nft.* events never alert (unix seconds): `override` (NFT_ALERTS_SINCE) when set,
 * else the time the bot first ran with NFT rules, stored once so a restart reuses it. The indexer's NFT
 * backfill writes old events as new rows; their `blockTimestamp` is below this time. Events from while the
 * bot was down are above it and still get the rules' normal late windows.
 */
export async function nftCutoff(sql: Sql, override?: number, now = nowS): Promise<number> {
  if (override !== undefined) return override
  const read = async () =>
    (await sql<{ value: string }[]>`select value from bot.state where key = 'nft_alerts_since'`)[0]
  const [ins] = await sql<{ value: string }[]>`
    insert into bot.state (key, value) values ('nft_alerts_since', ${String(now())})
    on conflict (key) do nothing returning value`
  return Number((ins ?? (await read()))!.value)
}

/** Inserts deliveries and moves the cursor in one short transaction. No network calls inside. */
async function write(
  sql: Sql,
  all: Delivery[],
  cursor: string,
  floods: FloodRow[] = [],
): Promise<void> {
  await sql.begin(async (tx) => {
    // The audience was read before this write (DEV SELL waits on RPC), so a user may have deleted their
    // data since. A DM row needs a live user; the share lock makes Delete my data wait for this commit
    // and then remove the row it just wrote.
    const dmIds = [
      ...new Set([...all, ...floods].filter((r) => r.chatType === "private").map((r) => r.chatId)),
    ]
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
    const floodLive = floods.filter((r) => r.chatType !== "private" || live.has(r.chatId))
    const asRow = (r: FloodRow) => ({
      chat_id: r.chatId,
      chat_type: r.chatType,
      thread_id: r.threadId,
      alert: "new",
      token: null,
      dedupe_key: r.dedupeKey,
      priority: PRIORITY.new,
      event_ts: new Date(r.eventTs * 1000),
      send_after: r.sendAfter === null ? null : new Date(r.sendAfter * 1000),
      card: tx.json(r.payload as unknown as postgres.JSONValue),
    })
    const notices = floodLive.filter((r) => r.payload.type !== "newtokens").map(asRow)
    const cards = floodLive.filter((r) => r.payload.type === "newtokens").map(asRow)
    // 10 columns per row; 1,000 rows stays well under Postgres' 65,535 parameters.
    for (let i = 0; i < notices.length; i += 1000) {
      await tx`insert into bot.deliveries ${tx(notices.slice(i, i + 1000))} on conflict (chat_id, dedupe_key) do nothing`
    }
    // A card gains the entries it doesn't hold yet, so a re-run or a minute split across batches adds each
    // launch once. Keys are unique within a pass, so one statement can upsert many cards.
    // shortcut: a launch read after its minute's card was sent (indexer lag past BATCH_GRACE_S) is in no
    // card, and one that lands while the sender is sending the card stays in the row but not the message.
    // Upgrade path: append late launches to the next open card.
    for (let i = 0; i < cards.length; i += 1000) {
      await tx`
        insert into bot.deliveries ${tx(cards.slice(i, i + 1000))}
        on conflict (chat_id, dedupe_key) do update
          set card = jsonb_set(bot.deliveries.card, '{entries}',
            (bot.deliveries.card->'entries') || coalesce((
              select jsonb_agg(e) from jsonb_array_elements(excluded.card->'entries') e
              where not (bot.deliveries.card->'entries' @> jsonb_build_array(jsonb_build_object('token', e->>'token')))
            ), '[]'::jsonb))
          where bot.deliveries.status = 'pending'`
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
  const { sql } = deps
  const cursor = await initCursor(sql)
  const holder = deps.nftState ?? {}
  // Loaded even when idle: the reminder scheduler reads it too.
  holder.current ??= await loadNftState(sql, cursor)
  const events = await eventsAfter(sql, cursor, 500, deps.maxId)
  if (events.length === 0) return 0
  try {
    return await processBatch(deps, events, holder.current)
  } catch (err) {
    // The state may hold events of a batch that was not written; the next pass rebuilds it from the cursor.
    holder.current = undefined
    throw err
  }
}

async function processBatch(
  deps: PollerDeps,
  events: Row<IndexerEvent>[],
  nft: NftState,
): Promise<number> {
  const { sql, log } = deps
  const lastId = events.at(-1)!.id
  // Launch floods: decided from launch events alone, so a re-run or replay classifies the same way.
  const launches = events.filter((e) => e.p.type === "launchpad.launch") as Row<LaunchEvent>[]
  let starts = new Map<string, string>()
  if (launches.length > 0) {
    const minTs = launches.reduce(
      (m, l) => Math.min(m, l.p.blockTimestamp),
      Number.POSITIVE_INFINITY,
    )
    // A long flood's start lies further back than one window: widen the history until it is certain.
    for (let back = 2 * FLOOD_WINDOW_S; ; back *= 2) {
      const from = minTs - back
      const history = await launchesAround(sql, from, lastId)
      starts = floodStarts(history)
      const unsure = uncertainStarts(history, from, starts)
      if (back >= MAX_LOOKBACK_S || !launches.some((l) => unsure.has(starts.get(l.id) ?? ""))) break
    }
  }
  const rules = deps.rules ?? rulesFor
  const now = deps.now ?? nowS
  const limiter = deps.limiter ?? createFailureLimiter({ report: deps.report, log })
  const cands: Candidate[] = []
  let skipped = 0
  const cutoff = events.some((e) => e.p.type.startsWith("nft."))
    ? await nftCutoff(sql, deps.nftAlertsSince, deps.now)
    : 0
  for (const ev of events) {
    // A launch in flood would only yield the NEW TOKEN alert that flood mode replaces.
    if (starts.has(ev.id)) continue
    // The state sees every NFT event, old or new, before the cutoff: it must hold the history.
    let prev: NftCollectionEvent | NftDropEvent | null = null
    if (ev.p.type.startsWith("nft.")) prev = nft.apply(ev as Row<NftEvent>)
    // Backfilled NFT history: the cursor moves past it and nothing is sent.
    if (ev.p.type.startsWith("nft.") && ev.p.blockTimestamp < cutoff) continue
    try {
      cands.push(
        ...(await rules(ev, { sql, prices: deps.prices, log, nft, now, nftSince: cutoff }, prev)),
      )
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
  const flooded = launches.filter((l) => starts.has(l.id))
  const aud = await loadAudience(sql, [...new Set(cands.map((c) => c.target))], now())
  const deliveries = route(cands, aud)
  const floods = flooded.length === 0 ? [] : floodRows(flooded, starts, newTokenChats(aud))
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
  await write(sql, rest, firstDev === null ? lastId : String(firstDev - 1n), floods)
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
  const shared = { ...deps, limiter, nftState: deps.nftState ?? {} }
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

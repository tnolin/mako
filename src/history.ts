import type {
  BondEvent,
  IndexerEvent,
  LaunchEvent,
  StoredEvent,
  SwapEvent,
  TradeEvent,
} from "@ink-indexer/events"
import type { Sql } from "./db"
import type { LaunchMark } from "./delivery/flood"
import { current } from "./events"

/** An indexer event and its table id (a decimal string). */
export type Row<T> = { id: string; p: T }

/** Stored rows in their current shapes. `T` is the shape the query's `type` filter selects. */
const upgrade = <T extends IndexerEvent>(rows: Row<StoredEvent>[]): Row<T>[] =>
  rows.map((r) => ({ id: r.id, p: current(r.p) as T }))

// Every read of the indexer lives here. Production grants allow indexer.events and indexer.cursors only.
// Selecting `id::text` makes a bare `order by id` sort the text, so these orders use `events.id`.

/** An event as the poller reads it, with the time the indexer wrote it (unix seconds). */
export type Written<T> = Row<T> & { writtenTs: number }

/** Confirmed events after `cursor`, up to and including `maxId` when given (replay tooling only). */
export async function eventsAfter(
  sql: Sql,
  cursor: string,
  limit = 500,
  maxId?: string,
): Promise<Written<IndexerEvent>[]> {
  const rows = await sql<Written<StoredEvent>[]>`
    select id::text, payload as p, extract(epoch from created_at)::int as "writtenTs"
    from indexer.events
    where confirmed and id > ${cursor} ${maxId === undefined ? sql`` : sql`and id <= ${maxId}`}
    order by events.id limit ${limit}`
  return rows.map((r) => ({ id: r.id, p: current(r.p), writtenTs: r.writtenTs }))
}

/** The newest confirmed event id. Unconfirmed rows are skipped, so they are read once they confirm. */
export async function maxEventId(sql: Sql): Promise<string> {
  const [r] = await sql<
    { id: string }[]
  >`select coalesce(max(id), 0)::text as id from indexer.events where confirmed`
  return r!.id
}

export async function launchOf(sql: Sql, token: string): Promise<Row<LaunchEvent> | null> {
  const [r] = upgrade<LaunchEvent>(
    await sql<Row<StoredEvent>[]>`
      select id::text, payload as p from indexer.events
      where entity = ${token} and type = 'launchpad.launch' order by events.id limit 1`,
  )
  return r ?? null
}

/** A token's curve trades in id order, up to and including `uptoId` when given. */
export async function tradesOf(
  sql: Sql,
  token: string,
  uptoId?: string,
): Promise<Row<TradeEvent>[]> {
  return upgrade(
    await sql<Row<StoredEvent>[]>`
      select id::text, payload as p from indexer.events
      where entity = ${token} and type = 'launchpad.trade'
        ${uptoId === undefined ? sql`` : sql`and id <= ${uptoId}`}
      order by events.id`,
  )
}

/**
 * A token's pool swaps in id order, from `sinceTs` (blockTimestamp) up to and including `uptoId` when given. With
 * both, the scan is narrowed by block first, as in launchesAround: Ink makes about one block per second, so blocks
 * within 10× the time span are a safe superset.
 */
export async function swapsOf(
  sql: Sql,
  token: string,
  uptoId?: string,
  sinceTs = 0,
): Promise<Row<SwapEvent>[]> {
  let fromBlock: string | null = null
  if (uptoId !== undefined && sinceTs > 0) {
    const [to] = await sql<{ block: string; ts: number }[]>`
      select block::text, (payload->>'blockTimestamp')::float8 as ts from indexer.events where id = ${uptoId}`
    if (to) {
      const span = Math.max(0, to.ts - sinceTs)
      fromBlock = String(BigInt(to.block) - BigInt(Math.ceil(span * 10) + 100))
    }
  }
  return upgrade(
    await sql<Row<StoredEvent>[]>`
      select id::text, payload as p from indexer.events
      where entity = ${token} and type = 'launchpad.swap'
        ${uptoId === undefined ? sql`` : sql`and id <= ${uptoId}`}
        ${fromBlock === null ? sql`` : sql`and block >= ${fromBlock}::bigint`}
        and (payload->>'blockTimestamp')::bigint >= ${sinceTs}
      order by events.id`,
  )
}

/** The market cap, quote asset, ath and time of a token's newest curve trade or pool swap. */
export async function lastMarketOf(
  sql: Sql,
  token: string,
): Promise<{ marketCap: bigint; quote: string; ath: bigint; atTs: number } | null> {
  const [r] = await sql<{ p: StoredEvent }[]>`
    select payload as p from indexer.events
    where entity = ${token} and type in ('launchpad.trade', 'launchpad.swap')
    order by events.id desc limit 1`
  if (!r) return null
  const p = current(r.p) as TradeEvent | SwapEvent
  let ath = BigInt(p.athMarketCap)
  // A version 1 row carries no ath, and every trade before it is version 1 too: take their highest market cap.
  if (r.p.v === 1) {
    const [m] = await sql<{ ath: string }[]>`
      select max((payload->>'marketCap')::numeric)::text as ath from indexer.events
      where entity = ${token} and type = 'launchpad.trade'`
    ath = BigInt(m!.ath)
  }
  return { marketCap: BigInt(p.marketCap), quote: p.quoteAsset, ath, atTs: p.blockTimestamp }
}

/** The creator's curve trades and pool swaps of a token, in id order, up to and including `uptoId`. */
export async function devTradesOf(
  sql: Sql,
  token: string,
  trader: string,
  uptoId: string,
): Promise<{ trades: Row<TradeEvent>[]; swaps: Row<SwapEvent>[] }> {
  const rows = await sql<(Row<StoredEvent> & { type: string })[]>`
    select id::text, type, payload as p from indexer.events
    where entity = ${token} and type in ('launchpad.trade', 'launchpad.swap')
      and payload->>'trader' = ${trader} and id <= ${uptoId}
    order by events.id`
  return {
    trades: upgrade(rows.filter((r) => r.type === "launchpad.trade")),
    swaps: upgrade(rows.filter((r) => r.type === "launchpad.swap")),
  }
}

export async function bondOf(sql: Sql, token: string): Promise<Row<BondEvent> | null> {
  const [r] = upgrade<BondEvent>(
    await sql<Row<StoredEvent>[]>`
      select id::text, payload as p from indexer.events
      where entity = ${token} and type = 'launchpad.bond' order by events.id limit 1`,
  )
  return r ?? null
}

/** A token found by ticker or name. A token that started in a pool counts as bonded. */
export type TokenHit = {
  token: string
  ticker: string | null
  name: string | null
  bonded: boolean
  lastTradeTs: number | null
}

/**
 * Tokens whose ticker equals `ticker` or whose name equals one of `names`, ignoring case: bonded first, then by
 * the newest curve trade or pool swap, at most 8.
 */
export function tokensNamed(sql: Sql, ticker: string, names: string[]): Promise<TokenHit[]> {
  const lower = names.map((n) => n.toLowerCase())
  // shortcut: compares every launch's ticker and name; add an expression index past ~100K launches.
  return sql`
    select l.entity as token, l.payload->>'ticker' as ticker, l.payload->>'name' as name,
      -- A token that started in a pool trades there from launch, like a bonded one.
      exists (select 1 from indexer.events b where b.entity = l.entity and b.type = 'launchpad.bond')
        or coalesce((l.payload->>'startsInPool')::boolean, false) as bonded,
      (select (t.payload->>'blockTimestamp')::int from indexer.events t
        where t.entity = l.entity and t.type in ('launchpad.trade', 'launchpad.swap')
        order by t.id desc limit 1) as "lastTradeTs"
    from indexer.events l
    where l.type = 'launchpad.launch'
      and (lower(l.payload->>'ticker') = ${ticker.toLowerCase()} or lower(l.payload->>'name') = any(${lower}))
    order by bonded desc, "lastTradeTs" desc nulls last, l.id desc
    limit 8`
}

/** Every launched token with its launchpad key. Version 1 rows already carry `launchpad`. */
export async function tokenLaunchpads(sql: Sql): Promise<[string, string][]> {
  const rows = await sql<{ token: string; launchpad: string }[]>`
    select distinct entity as token, payload->>'launchpad' as launchpad
    from indexer.events where type = 'launchpad.launch'`
  return rows.map((r) => [r.token, r.launchpad])
}

/** Launches by a creator up to an id, and how many of them bonded. Uses events_launch_creator. */
export async function creatorStats(
  sql: Sql,
  creator: string,
  uptoId: string,
): Promise<{ launches: number; bonded: number }> {
  const [r] = await sql<{ launches: number; bonded: number }[]>`
    with l as (
      select entity from indexer.events
      where type = 'launchpad.launch' and payload->>'creator' = ${creator} and id <= ${uptoId}
    )
    select (select count(*) from l)::int as launches,
           (select count(*) from indexer.events b
             where b.entity in (select entity from l) and b.type = 'launchpad.bond' and b.id <= ${uptoId})::int as bonded`
  return r!
}

export async function launchesOf(sql: Sql, tokens: string[]): Promise<Map<string, LaunchEvent>> {
  if (tokens.length === 0) return new Map()
  const rows = await sql<{ p: StoredEvent }[]>`
    select payload as p from indexer.events where entity = any(${tokens}) and type = 'launchpad.launch'`
  return new Map(
    rows.map((r) => {
      const p = current(r.p) as LaunchEvent
      return [p.token, p]
    }),
  )
}

export async function cursorBlock(sql: Sql): Promise<string | null> {
  const [r] = await sql<{ block: string }[]>`
    select block::text from indexer.cursors where source = 'inkypump'`
  return r?.block ?? null
}

// shortcut: Ink makes one block per second, so the last day is the last 86,400 blocks.
// Switch to blockTimestamp ranges if the block time changes.
export const DAY_BLOCKS = 86_400
/** How far back the Near bonding and Recently bonded lists, and Hot now's fallback, look. */
export const LIST_DAYS = 7
const WEEK_BLOCKS = LIST_DAYS * DAY_BLOCKS

function hottest(sql: Sql, blocks: number): Promise<{ token: string; trades: number }[]> {
  return sql<{ token: string; trades: number }[]>`
    select entity as token, count(*)::int as trades from indexer.events
    where type = 'launchpad.trade'
      and block >= (select block - ${blocks} from indexer.cursors where source = 'inkypump')
    group by entity order by trades desc, max(id) desc limit 5`
}

/** Tokens by trade count over the last 24h, or over 7 days when nothing traded in 24h. */
export async function hotNow(
  sql: Sql,
): Promise<{ window: "24h" | "7d"; rows: { token: string; trades: number }[] }> {
  const day = await hottest(sql, DAY_BLOCKS)
  if (day.length > 0) return { window: "24h", rows: day }
  return { window: "7d", rows: await hottest(sql, WEEK_BLOCKS) }
}

/** Unbonded tokens traded in the last 7 days, at 10% or more of the curve, by latest progress. */
export function nearBonding(sql: Sql): Promise<{ token: string; soldBps: number }[]> {
  return sql<{ token: string; soldBps: number }[]>`
    select token, sold_bps as "soldBps" from (
      select distinct on (entity) entity as token, (payload->>'soldBps')::int as sold_bps
      from indexer.events
      where type = 'launchpad.trade'
        and block >= (select block - ${WEEK_BLOCKS} from indexer.cursors where source = 'inkypump')
      order by entity, id desc
    ) t
    where sold_bps >= 1000
      and not exists (select 1 from indexer.events b where b.entity = t.token and b.type = 'launchpad.bond')
    order by sold_bps desc, token limit 5`
}

/** Latest bonds of the last 7 days. Uses events_type_id. */
export async function justBonded(sql: Sql): Promise<Row<BondEvent>[]> {
  return upgrade(
    await sql<Row<StoredEvent>[]>`
      select id::text, payload as p from indexer.events
      where type = 'launchpad.bond'
        and block >= (select block - ${WEEK_BLOCKS} from indexer.cursors where source = 'inkypump')
      order by events.id desc limit 5`,
  )
}

/**
 * Confirmed launches from `fromTs` (blockTimestamp) up to event `toId`, in id order, for flood detection.
 * Narrowed by block first so it uses events_block: Ink makes about one block per second, so blocks within
 * 10× the time span are a safe superset.
 */
export async function launchesAround(
  sql: Sql,
  fromTs: number,
  toId: string,
): Promise<LaunchMark[]> {
  const [to] = await sql<{ block: string; ts: number }[]>`
    select block::text, (payload->>'blockTimestamp')::float8 as ts from indexer.events where id = ${toId}`
  if (!to) return []
  const span = Math.max(0, to.ts - fromTs)
  return sql<LaunchMark[]>`
    select id::text, payload->>'launchpad' as launchpad, (payload->>'blockTimestamp')::float8 as ts
    from indexer.events
    where type = 'launchpad.launch' and confirmed
      and block >= ${String(BigInt(to.block) - BigInt(Math.ceil(span * 10) + 100))}::bigint
      and events.id <= ${toId}
      and (payload->>'blockTimestamp')::bigint >= ${fromTs}
    order by events.id`
}

import type { BondEvent, IndexerEvent, LaunchEvent, TradeEvent } from "@ink-indexer/events"
import type { Sql } from "./db"

/** An indexer event and its table id (a decimal string). */
export type Row<T> = { id: string; p: T }

// Every read of the indexer lives here. Production grants allow indexer.events and indexer.cursors only.
// Selecting `id::text` makes a bare `order by id` sort the text, so these orders use `events.id`.

/** Confirmed events after `cursor`, up to and including `maxId` when given (replay tooling only). */
export function eventsAfter(
  sql: Sql,
  cursor: string,
  limit = 500,
  maxId?: string,
): Promise<Row<IndexerEvent>[]> {
  return sql<Row<IndexerEvent>[]>`
    select id::text, payload as p from indexer.events
    where confirmed and id > ${cursor} ${maxId === undefined ? sql`` : sql`and id <= ${maxId}`}
    order by events.id limit ${limit}`
}

/** The newest confirmed event id. Unconfirmed rows are skipped, so they are read once they confirm. */
export async function maxEventId(sql: Sql): Promise<string> {
  const [r] = await sql<
    { id: string }[]
  >`select coalesce(max(id), 0)::text as id from indexer.events where confirmed`
  return r!.id
}

export async function launchOf(sql: Sql, token: string): Promise<Row<LaunchEvent> | null> {
  const [r] = await sql<Row<LaunchEvent>[]>`
    select id::text, payload as p from indexer.events
    where entity = ${token} and type = 'launchpad.launch' order by events.id limit 1`
  return r ?? null
}

/** A token's curve trades in id order, up to and including `uptoId` when given. */
export function tradesOf(sql: Sql, token: string, uptoId?: string): Promise<Row<TradeEvent>[]> {
  return uptoId === undefined
    ? sql<Row<TradeEvent>[]>`
        select id::text, payload as p from indexer.events
        where entity = ${token} and type = 'launchpad.trade' order by events.id`
    : sql<Row<TradeEvent>[]>`
        select id::text, payload as p from indexer.events
        where entity = ${token} and type = 'launchpad.trade' and id <= ${uptoId} order by events.id`
}

export async function bondOf(sql: Sql, token: string): Promise<Row<BondEvent> | null> {
  const [r] = await sql<Row<BondEvent>[]>`
    select id::text, payload as p from indexer.events
    where entity = ${token} and type = 'launchpad.bond' order by events.id limit 1`
  return r ?? null
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
  const rows = await sql<{ p: LaunchEvent }[]>`
    select payload as p from indexer.events where entity = any(${tokens}) and type = 'launchpad.launch'`
  return new Map(rows.map((r) => [r.p.token, r.p]))
}

export async function cursorBlock(sql: Sql): Promise<string | null> {
  const [r] = await sql<{ block: string }[]>`
    select block::text from indexer.cursors where source = 'inkypump'`
  return r?.block ?? null
}

// shortcut: Ink makes one block per second, so the last day is the last 86,400 blocks.
// Switch to blockTimestamp ranges if the block time changes.
export const DAY_BLOCKS = 86_400
const WEEK_BLOCKS = 7 * DAY_BLOCKS

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

/** Latest bonds. Uses events_type_id. */
export function justBonded(sql: Sql): Promise<Row<BondEvent>[]> {
  return sql<Row<BondEvent>[]>`
    select id::text, payload as p from indexer.events
    where type = 'launchpad.bond' order by events.id desc limit 5`
}

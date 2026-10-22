import type { NftEvent, NftSaleEvent, NftStatsEvent } from "@ink-indexer/events"
import type { Sql } from "../db"
import type { Row } from "../history"

// Every read here is one collection's events of one type, so it goes through events_type_entity_id.
// Selecting `id::text` makes a bare `order by id` sort the text, so these orders use `events.id`.

type OfType<T extends NftEvent["type"]> = Extract<NftEvent, { type: T }>

/** The newest event of a type for a collection, up to and including `uptoId` when given. */
export async function latestNft<T extends NftEvent["type"]>(
  sql: Sql,
  type: T,
  contract: string,
  uptoId?: string,
): Promise<Row<OfType<T>> | null> {
  const [r] = await sql<Row<OfType<T>>[]>`
    select id::text, payload as p from indexer.events
    where type = ${type} and entity = ${contract} ${uptoId === undefined ? sql`` : sql`and id <= ${uptoId}`}
    order by events.id desc limit 1`
  return r ?? null
}

/** A collection's events of a type with `blockTimestamp >= sinceTs`, newest first. */
export function nftSince<T extends NftEvent["type"]>(
  sql: Sql,
  type: T,
  contract: string,
  sinceTs: number,
  limit: number,
): Promise<Row<OfType<T>>[]> {
  return sql<Row<OfType<T>>[]>`
    select id::text, payload as p from indexer.events
    where type = ${type} and entity = ${contract} and (payload->>'blockTimestamp')::bigint >= ${sinceTs}
    order by events.id desc limit ${limit}`
}

/** One buyer's sales in a collection since `sinceTs`, up to this event id, oldest first. */
export function salesByBuyer(
  sql: Sql,
  contract: string,
  buyer: string,
  sinceTs: number,
  uptoId: string,
): Promise<Row<NftSaleEvent>[]> {
  return sql<Row<NftSaleEvent>[]>`
    select id::text, payload as p from indexer.events
    where type = 'nft.sale' and entity = ${contract} and id <= ${uptoId}
      and payload->>'buyer' = ${buyer} and (payload->>'blockTimestamp')::bigint >= ${sinceTs}
    order by events.id`
}

/** The newest stats snapshot at or before `ts` (the floor the collection card compares against). */
export async function floorAt(
  sql: Sql,
  contract: string,
  ts: number,
): Promise<Row<NftStatsEvent> | null> {
  const [r] = await sql<Row<NftStatsEvent>[]>`
    select id::text, payload as p from indexer.events
    where type = 'nft.stats' and entity = ${contract} and (payload->>'blockTimestamp')::bigint <= ${ts}
    order by events.id desc limit 1`
  return r ?? null
}

/** How many sales a collection had since `sinceTs`, and their total price in wei. */
export async function salesSince(
  sql: Sql,
  contract: string,
  sinceTs: number,
): Promise<{ count: number; sumWei: bigint }> {
  const [r] = await sql<{ count: number; sum: string }[]>`
    select count(*)::int as count, coalesce(sum((payload->>'priceWei')::numeric), 0)::text as sum
    from indexer.events
    where type = 'nft.sale' and entity = ${contract} and (payload->>'blockTimestamp')::bigint >= ${sinceTs}`
  return { count: r!.count, sumWei: BigInt(r!.sum) }
}

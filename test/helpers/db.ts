import { readFileSync } from "node:fs"
import type { StoredEvent } from "@ink-indexer/events"
import type postgres from "postgres"
import { connect, migrate, type Sql } from "../../src/db"

const CONTRACT = readFileSync(new URL("../indexer-contract.sql", import.meta.url), "utf8")

/** Drops and recreates the `indexer` contract tables and the `bot` schema. Tests only. */
export async function resetDb(url: string): Promise<Sql> {
  const sql = connect(url)
  await sql`drop schema if exists bot cascade`
  await sql`drop schema if exists indexer cascade`
  await sql.unsafe(CONTRACT)
  await migrate(sql)
  return sql
}

/**
 * Inserts events as the indexer would, in order. Returns their ids. Each row's `created_at` is its block time, as
 * when the indexer keeps up with the chain; `writtenAt` (unix seconds) sets it instead, as for a backfill.
 */
export async function insertEvents(
  sql: Sql,
  events: StoredEvent[],
  opts: { confirmed?: boolean; subs?: string[]; writtenAt?: number } = {},
): Promise<string[]> {
  const ids: string[] = []
  for (const [i, e] of events.entries()) {
    // NFT events key on their collection contract, launchpad events on the token.
    const entity = "contract" in e ? e.contract : e.token
    const [row] = await sql<{ id: string }[]>`
      insert into indexer.events (type, entity, payload, block, block_hash, tx_hash, log_index, sub, confirmed, created_at)
      values (${e.type}, ${entity}, ${sql.json(e as unknown as postgres.JSONValue)}, ${e.blockNumber},
              ${`0x${e.blockNumber.padStart(64, "0")}`}, ${e.txHash}, ${e.logIndex}, ${opts.subs?.[i] ?? ""},
              ${opts.confirmed ?? true}, to_timestamp(${opts.writtenAt ?? e.blockTimestamp}))
      returning id`
    ids.push(row!.id)
  }
  return ids
}

/** Points the indexer cursor at a block (heartbeat and discovery lists read it). */
export async function setCursorBlock(sql: Sql, block: number): Promise<void> {
  await sql`
    insert into indexer.cursors (source, block, block_hash) values ('inkypump', ${block}, '0x00')
    on conflict (source) do update set block = excluded.block`
}

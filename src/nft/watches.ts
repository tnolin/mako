import type { Sql } from "../db"
import { WATCH_CAP_NFT } from "./policy"

/** A watch or mute belongs to a user (bot.users.id) or to a chat (Telegram chat id). */
export type Owner = { userId: string } | { chatId: string }

const ids = (o: Owner) => ({
  userId: "userId" in o ? o.userId : null,
  chatId: "chatId" in o ? o.chatId : null,
})
const where = (sql: Sql, o: Owner) =>
  "userId" in o ? sql`user_id = ${o.userId}` : sql`chat_id = ${o.chatId}`

/**
 * Watches a collection. A collection is watched, muted or neither, so this removes the owner's mute.
 * shortcut: the cap is checked before the insert without a lock, so two taps at once can pass 50 by one.
 */
export async function watch(
  sql: Sql,
  owner: Owner,
  contract: string,
): Promise<"added" | "exists" | "limit"> {
  return sql.begin(async (tx) => {
    const [have] = await tx`
      select 1 from bot.nft_watches where ${where(sql, owner)} and contract = ${contract}`
    if (have) return "exists"
    const [n] = await tx<{ n: number }[]>`
      select count(*)::int as n from bot.nft_watches where ${where(sql, owner)}`
    if (n!.n >= WATCH_CAP_NFT) return "limit"
    await tx`delete from bot.collection_mutes where ${where(sql, owner)} and contract = ${contract}`
    const o = ids(owner)
    await tx`
      insert into bot.nft_watches (user_id, chat_id, contract) values (${o.userId}, ${o.chatId}, ${contract})`
    return "added"
  })
}

export async function unwatch(sql: Sql, owner: Owner, contract: string): Promise<void> {
  await sql`delete from bot.nft_watches where ${where(sql, owner)} and contract = ${contract}`
}

/** The owner's watched collections, newest first. */
export async function watchesOf(sql: Sql, owner: Owner): Promise<string[]> {
  const rows = await sql<{ contract: string }[]>`
    select contract from bot.nft_watches where ${where(sql, owner)} order by id desc`
  return rows.map((r) => r.contract)
}

/** Mutes a collection and stops watching it; `wasWatching` picks the pop-up. */
export async function muteCollection(
  sql: Sql,
  owner: Owner,
  contract: string,
): Promise<{ wasWatching: boolean }> {
  return sql.begin(async (tx) => {
    const gone = await tx`
      delete from bot.nft_watches where ${where(sql, owner)} and contract = ${contract} returning 1`
    const o = ids(owner)
    await tx`
      insert into bot.collection_mutes (user_id, chat_id, contract) values (${o.userId}, ${o.chatId}, ${contract})
      on conflict do nothing`
    return { wasWatching: gone.length > 0 }
  })
}

export async function unmuteCollection(sql: Sql, owner: Owner, contract: string): Promise<void> {
  await sql`delete from bot.collection_mutes where ${where(sql, owner)} and contract = ${contract}`
}

/** The owner's muted collections, newest first. */
export async function mutesOf(sql: Sql, owner: Owner): Promise<string[]> {
  const rows = await sql<{ contract: string }[]>`
    select contract from bot.collection_mutes where ${where(sql, owner)} order by id desc`
  return rows.map((r) => r.contract)
}

/** Sets a mint reminder. The last explicit tap wins, so it removes the user's mute. */
export async function remind(sql: Sql, userId: string, contract: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`delete from bot.collection_mutes where user_id = ${userId} and contract = ${contract}`
    await tx`
      insert into bot.reminders (user_id, contract) values (${userId}, ${contract}) on conflict do nothing`
  })
}

export async function unremind(sql: Sql, userId: string, contract: string): Promise<void> {
  await sql`delete from bot.reminders where user_id = ${userId} and contract = ${contract}`
}

export async function remindersOf(sql: Sql, userId: string): Promise<string[]> {
  const rows = await sql<{ contract: string }[]>`
    select contract from bot.reminders where user_id = ${userId} order by created_at desc, contract`
  return rows.map((r) => r.contract)
}

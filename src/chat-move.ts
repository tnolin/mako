import type postgres from "postgres"

/**
 * The chat's token and collection watches and collection mutes follow it to the new id. Rows the new id
 * already has win, since those tables have no foreign key to bot.chats.
 */
async function moveWatches(
  tx: postgres.TransactionSql,
  from: string | number,
  to: string | number,
): Promise<void> {
  await tx`
    insert into bot.chat_token_watches (chat_id, target, created_at)
    select ${to}, target, created_at from bot.chat_token_watches where chat_id = ${from}
    on conflict do nothing`
  await tx`delete from bot.chat_token_watches where chat_id = ${from}`
  await tx`
    insert into bot.nft_watches (chat_id, contract, created_at, reminders_off)
    select ${to}, contract, created_at, reminders_off from bot.nft_watches where chat_id = ${from}
    on conflict do nothing`
  await tx`delete from bot.nft_watches where chat_id = ${from}`
  await tx`
    insert into bot.collection_mutes (chat_id, contract, created_at)
    select ${to}, contract, created_at from bot.collection_mutes where chat_id = ${from}
    on conflict do nothing`
  await tx`delete from bot.collection_mutes where chat_id = ${from}`
}

/**
 * A group that became a supergroup has a new chat id. If the new id is free the row is renamed;
 * if its own join event got there first, the old row's setup is carried over and the old row is deleted.
 * Call inside a transaction.
 */
export async function moveChat(
  tx: postgres.TransactionSql,
  from: string | number,
  to: string | number,
): Promise<void> {
  await moveWatches(tx, from, to)
  const [taken] = await tx`select 1 from bot.chats where chat_id = ${to}`
  if (!taken) {
    await tx`update bot.chats set chat_id = ${to}, kind = 'supergroup' where chat_id = ${from}`
    return
  }
  await tx`
    update bot.chats n set settings = o.settings, active = o.active, paused_reason = o.paused_reason,
      owner = coalesce(n.owner, o.owner), setup_by = coalesce(o.setup_by, n.setup_by),
      removed_at = null, kind = 'supergroup'
    from bot.chats o where o.chat_id = ${from} and n.chat_id = ${to}`
  await tx`delete from bot.chats where chat_id = ${from}`
}

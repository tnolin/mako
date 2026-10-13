import type postgres from "postgres"

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

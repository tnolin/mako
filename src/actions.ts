import type postgres from "postgres"
import type { Sql } from "./db"
import type { ChatType } from "./delivery/recipients"

/** Analytics with no personal data: no user column, and no chat id for private chats (it equals the user id). */
export async function logAction(
  sql: Sql,
  a: {
    chatType: ChatType
    chatId?: number | string | null
    action: string
    token?: string | null
    params?: Record<string, unknown>
  },
): Promise<void> {
  const chatId = a.chatType === "private" ? null : (a.chatId?.toString() ?? null)
  await sql`
    insert into bot.user_actions (chat_type, chat_id, action, token, params)
    values (${a.chatType}, ${chatId}, ${a.action}, ${a.token ?? null}, ${sql.json((a.params ?? {}) as postgres.JSONValue)})`
}

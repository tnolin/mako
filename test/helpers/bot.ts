import type postgres from "postgres"
import type { Payload } from "../../src/cards/card"
import type { Sql } from "../../src/db"
import { basicPreset, type Settings } from "../../src/settings"

export async function addUser(
  sql: Sql,
  tgId: number,
  settings: Settings = basicPreset(),
): Promise<string> {
  const [r] = await sql<{ id: string }[]>`
    insert into bot.users (platform_user_id, settings)
    values (${tgId}, ${sql.json(settings as unknown as postgres.JSONValue)}) returning id::text`
  return r!.id
}

export async function addChat(
  sql: Sql,
  chatId: number,
  kind: "group" | "supergroup" | "channel",
  settings: Settings = basicPreset(),
  opts: { active?: boolean; setupBy?: string | null } = {},
): Promise<void> {
  await sql`
    insert into bot.chats (chat_id, kind, settings, active, setup_by)
    values (${chatId}, ${kind}, ${sql.json(settings as unknown as postgres.JSONValue)}, ${opts.active ?? true}, ${opts.setupBy ?? null})`
}

export async function subscribe(sql: Sql, userId: string, kind: "watch" | "mute", token: string) {
  await sql`insert into bot.subscriptions (user_id, kind, target) values (${userId}, ${kind}, ${token})`
}

export type DeliveryRow = {
  id: string
  chat_id: string
  chat_type: string
  thread_id: number | null
  alert: string
  dedupe_key: string
  status: string
  priority: number
  card: Payload
}

export function listDeliveries(sql: Sql): Promise<DeliveryRow[]> {
  return sql<DeliveryRow[]>`
    select id::text, chat_id::text, chat_type, thread_id, alert, dedupe_key, status, priority, card
    from bot.deliveries order by created_at, chat_id, dedupe_key`
}

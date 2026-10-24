import type postgres from "postgres"
import type { Sql } from "../db"
import { basicPreset, readSettings, type Settings } from "../settings"

/** Shown when a button is tapped by someone with no user row (for example after Delete my data). */
export const NO_USER = "Send /start to use MAKO."

export type User = { id: string; tg: number; settings: Settings }
type Row = { id: string; tg: string; settings: unknown; created?: boolean }
const toUser = (r: Row): User => ({
  id: r.id,
  tg: Number(r.tg),
  settings: readSettings(r.settings, "private"),
})
const json = (s: Settings) => s as unknown as postgres.JSONValue

export async function findUser(sql: Sql, tg: number): Promise<User | null> {
  const [r] = await sql<Row[]>`
    select id::text, platform_user_id::text as tg, settings from bot.users where platform_user_id = ${tg}`
  return r ? toUser(r) : null
}

/** Creates the user with the basic preset, or clears blocked_at for a returning user. Stores only the numeric id. */
export async function ensureUser(sql: Sql, tg: number): Promise<{ user: User; created: boolean }> {
  const [r] = await sql<Row[]>`
    insert into bot.users (platform_user_id, settings) values (${tg}, ${sql.json(json(basicPreset("private")))})
    on conflict (platform, platform_user_id) do update set blocked_at = null
    returning id::text, platform_user_id::text as tg, settings, (xmax = 0) as created`
  return { user: toUser(r!), created: r!.created === true }
}

export async function saveUserSettings(sql: Sql, id: string, s: Settings): Promise<void> {
  await sql`update bot.users set settings = ${sql.json(json(s))} where id = ${id}`
}

/**
 * Delete my data: the user row (subscriptions cascade, chat references go null) and their DM deliveries.
 * The user row goes first: the poller holds a share lock on it while it writes a DM row, so the
 * delivery delete below then sees that row.
 */
export async function deleteUserData(sql: Sql, tg: number): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`delete from bot.users where platform_user_id = ${tg}`
    await tx`delete from bot.deliveries where chat_type = 'private' and chat_id = ${tg}`
  })
}

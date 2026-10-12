import type postgres from "postgres"
import type { Payload } from "../cards/card"
import type { Sql } from "../db"
import { escapeHtml } from "../format"
import type { Logger } from "../log"
import { ALERT_LABEL, type AlertKind, PRIORITY } from "../settings"

export type NoticeInfo = { alert?: AlertKind; top?: AlertKind; topCount?: number; total?: number }
export type Notify = (chatId: string, reason: string, info?: NoticeInfo) => Promise<void>

export type NoticeApi = {
  getChatMember(chatId: number, userId: number): Promise<{ status: string }>
  getChatAdministrators(chatId: number): Promise<{ user: { id: number; is_bot: boolean } }[]>
  getChat(chatId: number): Promise<{ title?: string }>
}

const isAdmin = (status: string) => status === "creator" || status === "administrator"

/** `titleHtml` is already escaped. */
export function noticeText(reason: string, titleHtml: string, info: NoticeInfo): string {
  if (reason === "removed") {
    return `MAKO was removed from ${titleHtml}, so it can no longer post alerts there. Add it again and run /setup to resume.`
  }
  if (reason === "rights") {
    return `MAKO lost permission to post in ${titleHtml}. Alerts there are paused. Give MAKO admin rights to post, then tap Resume in settings.`
  }
  if (reason.startsWith("topic:")) {
    const label = ALERT_LABEL[info.alert ?? (reason.slice(6) as AlertKind)] ?? "these"
    return `The topic for ${label} alerts in ${titleHtml} was closed or deleted, so those alerts are paused. Run /route in another topic, or reopen it and tap Resume in settings.`
  }
  const label = info.top ? ALERT_LABEL[info.top] : "one feed"
  return `MAKO is skipping alerts in ${titleHtml} because of high volume: ${info.total ?? 0} skipped in the last hour. ${info.topCount ?? 0} of ${info.total ?? 0} skipped were ${label}. Turn it off or /route it to its own topic.`
}

/** Admin notices go by DM to setup_by (checked live), else to another admin who has started the bot. */
export function createNotify(deps: {
  sql: Sql
  api: NoticeApi
  botUsername: string
  log: Logger
}): Notify {
  const { sql, api, log } = deps
  const pick = async (chatId: string, reason: string): Promise<string | null> => {
    const [c] = await sql<{ tg: string | null; blocked: boolean }[]>`
      select u.platform_user_id::text as tg, (u.blocked_at is not null) as blocked
      from bot.chats c left join bot.users u on u.id = c.setup_by where c.chat_id = ${chatId}`
    if (c?.tg && !c.blocked) {
      if (reason === "removed") return c.tg
      const m = await api.getChatMember(Number(chatId), Number(c.tg)).catch(() => null)
      if (m && isAdmin(m.status)) return c.tg
    }
    if (reason === "removed") return null
    const admins = await api.getChatAdministrators(Number(chatId)).catch(() => [])
    const ids = admins.filter((a) => !a.user.is_bot).map((a) => a.user.id)
    if (ids.length === 0) return null
    const [u] = await sql<{ tg: string }[]>`
      select platform_user_id::text as tg from bot.users
      where platform_user_id = any(${ids}) and blocked_at is null
      order by array_position(${ids}::bigint[], platform_user_id) limit 1`
    return u?.tg ?? null
  }
  return async (chatId, reason, info = {}) => {
    const recent = await sql`
      select 1 from bot.notices where chat_id = ${chatId} and reason = ${reason} and sent_at > now() - interval '24 hours'`
    if (recent.length > 0) return
    const to = await pick(chatId, reason)
    await sql`
      insert into bot.notices (chat_id, reason, sent_at) values (${chatId}, ${reason}, now())
      on conflict (chat_id, reason) do update set sent_at = excluded.sent_at`
    if (!to) {
      log("info", "admin notice not delivered: no admin has started the bot", { chatId, reason })
      return
    }
    const title = await api
      .getChat(Number(chatId))
      .then((c) => c.title)
      .catch(() => undefined)
    const payload: Payload = {
      type: "text",
      html: noticeText(reason, title ? escapeHtml(title) : "your chat", info),
      buttons: [
        [{ text: "Open settings", url: `https://t.me/${deps.botUsername}?start=s_${chatId}` }],
      ],
    }
    await sql`
      insert into bot.deliveries (chat_id, chat_type, alert, dedupe_key, priority, event_ts, card)
      values (${to}, 'private', 'notice', ${`notice:${chatId}:${reason}:${Date.now()}`}, ${PRIORITY.notice}, now(),
              ${sql.json(payload as unknown as postgres.JSONValue)})`
  }
}

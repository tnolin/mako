import type { Payload } from "../cards/card"
import type { Sql } from "../db"
import type { Candidate } from "../rules/index"
import { type AlertKind, readSettings, type Settings } from "../settings"

export type ChatType = "private" | "group" | "supergroup" | "channel"

export type Delivery = {
  eventId: string
  chatId: string
  chatType: ChatType
  threadId: number | null
  alert: AlertKind
  token: string
  dedupeKey: string
  priority: number
  eventTs: number
  payload: Payload
  supersedesBonding: boolean
  holds?: Candidate["holds"]
}

type UserT = { userId: string; chatId: string; settings: Settings }
type ChatT = { chatId: string; chatType: Exclude<ChatType, "private">; settings: Settings }

export type Audience = {
  users: UserT[]
  chats: ChatT[]
  /** token → user ids */
  watch: Map<string, Set<string>>
  mute: Map<string, Set<string>>
  /** `${chatId}:${token}` → the PUMPING alerts queued there: event time and dedupe key. */
  lastPump: Map<string, { ts: number; key: string }[]>
}

/** Watchers get BIG at the default 5% threshold, whatever their own setting. */
export const WATCH_BIG_BPS = 500

export function feedAccepts(s: Settings, c: Candidate): boolean {
  if (!s.alerts[c.alert].on) return false
  if (c.alert === "bonding") return c.mark !== undefined && s.alerts.bonding.marks.includes(c.mark)
  if (c.alert === "big") return (c.sizeBps ?? 0) >= s.alerts.big.pctBps
  return true
}

/** DM watchers get every type except NEW TOKEN, at every BONDING mark and the default BIG threshold. */
export function watchAccepts(c: Candidate): boolean {
  if (c.alert === "new") return false
  if (c.alert === "big") return (c.sizeBps ?? 0) >= WATCH_BIG_BPS
  return true
}

/** One alert per event per chat: the lowest priority number, then the highest BONDING mark. */
function best(cs: Candidate[]): Candidate | undefined {
  return [...cs].sort((a, b) => a.priority - b.priority || (b.mark ?? 0) - (a.mark ?? 0))[0]
}

export function route(cands: Candidate[], aud: Audience): Delivery[] {
  const byEvent = new Map<string, Candidate[]>()
  for (const c of cands) byEvent.set(c.eventId, [...(byEvent.get(c.eventId) ?? []), c])
  const out: Delivery[] = []
  // A candidate's own earlier row (crash re-run, reorg re-insert) and later pumps never cool it.
  const cooling = (chatId: string, c: Candidate) =>
    c.alert === "pumping" &&
    (aud.lastPump.get(`${chatId}:${c.token}`) ?? []).some(
      (p) => p.key !== c.dedupeKey && p.ts <= c.eventTs && p.ts > c.eventTs - 3600,
    )
  const push = (
    c: Candidate,
    chatId: string,
    chatType: ChatType,
    threadId: number | null,
    s: Settings,
  ) => {
    if (c.alert === "pumping") {
      const k = `${chatId}:${c.token}`
      aud.lastPump.set(k, [...(aud.lastPump.get(k) ?? []), { ts: c.eventTs, key: c.dedupeKey }])
    }
    out.push({
      eventId: c.eventId,
      chatId,
      chatType,
      threadId,
      alert: c.alert,
      token: c.token,
      dedupeKey: c.dedupeKey,
      priority: c.priority,
      eventTs: c.eventTs,
      payload: { type: "card", card: c.card, image: s.alerts[c.alert].image },
      supersedesBonding: c.supersedesBonding ?? false,
      holds: c.holds,
    })
  }
  for (const cs of byEvent.values()) {
    const token = cs[0]!.token
    const watchers = aud.watch.get(token)
    const muters = aud.mute.get(token)
    for (const u of aud.users) {
      if (muters?.has(u.userId)) continue
      const watching = watchers?.has(u.userId) ?? false
      const c = best(
        cs.filter(
          (c) =>
            (feedAccepts(u.settings, c) || (watching && watchAccepts(c))) && !cooling(u.chatId, c),
        ),
      )
      if (c) push(c, u.chatId, "private", null, u.settings)
    }
    for (const ch of aud.chats) {
      const c = best(
        cs.filter(
          (c) =>
            feedAccepts(ch.settings, c) &&
            !ch.settings.pausedRoutes?.includes(c.alert) &&
            !cooling(ch.chatId, c),
        ),
      )
      if (!c) continue
      const thread =
        ch.chatType === "channel"
          ? null
          : (ch.settings.routes?.[c.alert] ?? ch.settings.thread ?? null)
      push(c, ch.chatId, ch.chatType, thread, ch.settings)
    }
  }
  return out
}

// shortcut: loads every active user and chat per batch; fine to tens of thousands of rows.
// Index subscriptions by alert type and filter in SQL when that stops being true.
export async function loadAudience(sql: Sql, tokens: string[]): Promise<Audience> {
  const users = await sql<{ userId: string; chatId: string; settings: unknown }[]>`
    select id::text as "userId", platform_user_id::text as "chatId", settings
    from bot.users where blocked_at is null`
  const chats = await sql<{ chatId: string; chatType: ChatT["chatType"]; settings: unknown }[]>`
    select chat_id::text as "chatId", kind as "chatType", settings
    from bot.chats where active and removed_at is null`
  const subs = tokens.length
    ? await sql<{ userId: string; kind: "watch" | "mute"; target: string }[]>`
        select user_id::text as "userId", kind, target from bot.subscriptions where target = any(${tokens})`
    : []
  const pumps = tokens.length
    ? await sql<{ chatId: string; token: string; ts: number; key: string }[]>`
        select chat_id::text as "chatId", token, extract(epoch from event_ts)::int as ts, dedupe_key as key
        from bot.deliveries where alert = 'pumping' and token = any(${tokens}) and status <> 'superseded'`
    : []
  const watch = new Map<string, Set<string>>()
  const mute = new Map<string, Set<string>>()
  for (const s of subs) {
    const m = s.kind === "watch" ? watch : mute
    if (!m.has(s.target)) m.set(s.target, new Set())
    m.get(s.target)!.add(s.userId)
  }
  const lastPump = new Map<string, { ts: number; key: string }[]>()
  for (const p of pumps) {
    const k = `${p.chatId}:${p.token}`
    lastPump.set(k, [...(lastPump.get(k) ?? []), { ts: p.ts, key: p.key }])
  }
  return {
    users: users.map((u) => ({ ...u, settings: readSettings(u.settings) })),
    chats: chats.map((c) => ({ ...c, settings: readSettings(c.settings) })),
    watch,
    mute,
    lastPump,
  }
}

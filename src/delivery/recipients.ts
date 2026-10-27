import type { Payload } from "../cards/card"
import type { Sql } from "../db"
import { FLOOR_COOLDOWN_S, LISTING_CAP, LISTING_CAP_WINDOW_S } from "../nft/policy"
import type { Candidate } from "../rules/index"
import {
  type AlertKind,
  type ChatType,
  NFT_ALL_ALERTS,
  readSettings,
  type Settings,
  wantsImage,
} from "../settings"

export type { ChatType }

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
  /** token → the chats (Telegram chat ids) whose admins watch it. */
  chatWatch: Map<string, Set<string>>
  mute: Map<string, Set<string>>
  /** `${chatId}:${token}` → the PUMPING alerts queued there: event time and dedupe key. */
  lastPump: Map<string, { ts: number; key: string }[]>
  /** contract → the users (bot.users.id) and chats that watch it. */
  watches: Map<string, Owners>
  /** contract → the users and chats that muted it. */
  nftMutes: Map<string, Owners>
  /** `${chatId}:${contract}` → the UNDER FLOOR and RARE LISTING alerts queued there: event time and dedupe key. */
  listingSent: Map<string, { ts: number; key: string }[]>
  /** `${chatId}:${contract}:${dir}` → the FLOOR alerts queued there. */
  lastFloor: Map<string, { ts: number; key: string }[]>
}

export type Owners = { users: Set<string>; chats: Set<string> }

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

/**
 * A group that watches a token gets every alert for it except NEW TOKEN, whatever its switches say.
 * BONDING uses the group's marks and BIG BUY/SELL the group's percentage.
 */
export function chatWatchAccepts(s: Settings, c: Candidate): boolean {
  if (c.alert === "new") return false
  if (c.alert === "bonding") return c.mark !== undefined && s.alerts.bonding.marks.includes(c.mark)
  if (c.alert === "big") return (c.sizeBps ?? 0) >= s.alerts.big.pctBps
  return true
}

const isNft = (c: Candidate): boolean => "contract" in c.card

/** The chat's thresholds for an NFT candidate; kinds without one always pass. */
export function nftAccepts(s: Settings, c: Candidate): boolean {
  const a = s.alerts
  switch (c.alert) {
    case "minted":
      return c.markBps !== undefined && a.minted.marks.includes(c.markBps)
    case "under":
      return (c.discountBps ?? 0) >= a.under.pctBps
    case "rare":
      return c.rankBps !== undefined && c.rankBps <= a.rare.topBps
    case "floor":
      return (c.floorBps ?? 0) >= a.floor.pctBps
    case "sweep":
      return (c.sweepItems ?? 0) >= a.sweep.items
    case "bigsale":
      return c.salePriceWei !== undefined && c.salePriceWei >= BigInt(a.bigsale.minWei)
    case "sale":
      return c.salePriceWei !== undefined && c.salePriceWei >= BigInt(a.sale.minWei)
    default:
      return true
  }
}

const ALL_COLLECTIONS: readonly string[] = NFT_ALL_ALERTS

/**
 * Muted first. An All collections alert reaches an owner through the feed (the collection passes the checks
 * and the alert is on) or because the owner watches the collection (the switch and the verdict are
 * ignored, the thresholds are not). A Watched only alert needs the watch, the switch and the thresholds.
 */
function nftWants(s: Settings, c: Candidate, watching: boolean): boolean {
  // MINT REMINDER is clock-driven: the reminder scheduler queues it. Only MINT UPDATED, which shares its
  // switch, is routed here.
  if (c.alert === "reminder") return c.mintUpdate === true && watching && s.alerts.reminder.on
  if (!nftAccepts(s, c)) return false
  if (ALL_COLLECTIONS.includes(c.alert))
    return watching || (c.feedEligible === true && s.alerts[c.alert].on)
  return watching && s.alerts[c.alert].on
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
    (aud.lastPump.get(`${chatId}:${c.target}`) ?? []).some(
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
      const k = `${chatId}:${c.target}`
      aud.lastPump.set(k, [...(aud.lastPump.get(k) ?? []), { ts: c.eventTs, key: c.dedupeKey }])
    }
    out.push({
      eventId: c.eventId,
      chatId,
      chatType,
      threadId,
      alert: c.alert,
      token: c.target,
      dedupeKey: c.dedupeKey,
      priority: c.priority,
      eventTs: c.eventTs,
      payload:
        "contract" in c.card
          ? { type: "nftalert", card: c.card, image: wantsImage(s, c.alert) }
          : { type: "card", card: c.card, image: wantsImage(s, c.alert) },
      supersedesBonding: c.supersedesBonding ?? false,
      holds: c.holds,
    })
  }
  // Earlier rows (a crash re-run) never count against their own candidate; the batch's choices do.
  const recent = (
    m: Map<string, { ts: number; key: string }[]>,
    k: string,
    c: Candidate,
    windowS: number,
  ) =>
    (m.get(k) ?? []).filter(
      (p) => p.key !== c.dedupeKey && p.ts <= c.eventTs && p.ts > c.eventTs - windowS,
    )
  const capped = (chatId: string, c: Candidate): boolean => {
    if (c.alert === "under" || c.alert === "rare") {
      const k = `${chatId}:${c.target}`
      return recent(aud.listingSent, k, c, LISTING_CAP_WINDOW_S).length >= LISTING_CAP
    }
    if (c.alert === "floor") {
      return (
        recent(aud.lastFloor, `${chatId}:${c.target}:${c.floorDir}`, c, FLOOR_COOLDOWN_S).length > 0
      )
    }
    return false
  }
  const remember = (chatId: string, c: Candidate) => {
    const floor = c.alert === "floor"
    if (!floor && c.alert !== "under" && c.alert !== "rare") return
    const m = floor ? aud.lastFloor : aud.listingSent
    const k = floor ? `${chatId}:${c.target}:${c.floorDir}` : `${chatId}:${c.target}`
    m.set(k, [...(m.get(k) ?? []), { ts: c.eventTs, key: c.dedupeKey }])
  }
  for (const cs of byEvent.values()) {
    if (isNft(cs[0]!)) {
      const target = cs[0]!.target
      const watched = aud.watches.get(target)
      const muted = aud.nftMutes.get(target)
      for (const u of aud.users) {
        if (muted?.users.has(u.userId)) continue
        const w = watched?.users.has(u.userId) ?? false
        const c = best(cs.filter((c) => nftWants(u.settings, c, w) && !capped(u.chatId, c)))
        if (!c) continue
        remember(u.chatId, c)
        push(c, u.chatId, "private", null, u.settings)
      }
      for (const ch of aud.chats) {
        if (muted?.chats.has(ch.chatId)) continue
        const w = watched?.chats.has(ch.chatId) ?? false
        const c = best(
          cs.filter(
            (c) =>
              nftWants(ch.settings, c, w) &&
              !ch.settings.pausedRoutes?.includes(c.alert) &&
              !capped(ch.chatId, c),
          ),
        )
        if (!c) continue
        remember(ch.chatId, c)
        const thread =
          ch.chatType === "channel"
            ? null
            : (ch.settings.routes?.[c.alert] ?? ch.settings.thread ?? null)
        push(c, ch.chatId, ch.chatType, thread, ch.settings)
      }
      continue
    }
    const token = cs[0]!.target
    const watchers = aud.watch.get(token)
    const muters = aud.mute.get(token)
    const chatWatchers = aud.chatWatch.get(token)
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
      const watching = chatWatchers?.has(ch.chatId) ?? false
      const c = best(
        cs.filter(
          (c) =>
            (feedAccepts(ch.settings, c) || (watching && chatWatchAccepts(ch.settings, c))) &&
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
export async function loadAudience(
  sql: Sql,
  tokens: string[],
  nowS: number = Math.floor(Date.now() / 1000),
): Promise<Audience> {
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
  const chatSubs = tokens.length
    ? await sql<{ chatId: string; target: string }[]>`
        select chat_id::text as "chatId", target from bot.chat_token_watches where target = any(${tokens})`
    : []
  const pumps = tokens.length
    ? await sql<{ chatId: string; token: string; ts: number; key: string }[]>`
        select chat_id::text as "chatId", token, extract(epoch from event_ts)::int as ts, dedupe_key as key
        from bot.deliveries where alert = 'pumping' and token = any(${tokens}) and status <> 'superseded'`
    : []
  type OwnerRow = { userId: string | null; chatId: string | null; contract: string }
  type SentRow = { chatId: string; token: string; ts: number; key: string }
  const [nftWatches, nftMuteRows, listing, floors] = tokens.length
    ? await Promise.all([
        sql<OwnerRow[]>`
          select user_id::text as "userId", chat_id::text as "chatId", contract
          from bot.nft_watches where contract = any(${tokens})`,
        sql<OwnerRow[]>`
          select user_id::text as "userId", chat_id::text as "chatId", contract
          from bot.collection_mutes where contract = any(${tokens})`,
        // Two hours reaches back past the one-hour cap for a candidate up to its 30-minute late window.
        sql<SentRow[]>`
          select chat_id::text as "chatId", token, extract(epoch from event_ts)::int as ts, dedupe_key as key
          from bot.deliveries
          where alert in ('under', 'rare') and token = any(${tokens}) and status <> 'superseded'
            and event_ts > to_timestamp(${nowS - 2 * 3600})`,
        sql<SentRow[]>`
          select chat_id::text as "chatId", token, extract(epoch from event_ts)::int as ts, dedupe_key as key
          from bot.deliveries
          where alert = 'floor' and token = any(${tokens}) and status <> 'superseded'
            and event_ts > to_timestamp(${nowS - 7 * 3600})`,
      ])
    : [[] as OwnerRow[], [] as OwnerRow[], [] as SentRow[], [] as SentRow[]]
  const owners = (rows: OwnerRow[]) => {
    const m = new Map<string, Owners>()
    for (const r of rows) {
      const o = m.get(r.contract) ?? { users: new Set<string>(), chats: new Set<string>() }
      if (r.userId) o.users.add(r.userId)
      if (r.chatId) o.chats.add(r.chatId)
      m.set(r.contract, o)
    }
    return m
  }
  const listingSent = new Map<string, { ts: number; key: string }[]>()
  for (const r of listing) {
    const k = `${r.chatId}:${r.token}`
    listingSent.set(k, [...(listingSent.get(k) ?? []), { ts: r.ts, key: r.key }])
  }
  const lastFloor = new Map<string, { ts: number; key: string }[]>()
  for (const r of floors) {
    // The direction is in the dedupe key: floor:<contract>:<up|down>:<bucket>.
    const k = `${r.chatId}:${r.token}:${r.key.split(":")[2]}`
    lastFloor.set(k, [...(lastFloor.get(k) ?? []), { ts: r.ts, key: r.key }])
  }
  const watch = new Map<string, Set<string>>()
  const mute = new Map<string, Set<string>>()
  for (const s of subs) {
    const m = s.kind === "watch" ? watch : mute
    if (!m.has(s.target)) m.set(s.target, new Set())
    m.get(s.target)!.add(s.userId)
  }
  const chatWatch = new Map<string, Set<string>>()
  for (const s of chatSubs) {
    if (!chatWatch.has(s.target)) chatWatch.set(s.target, new Set())
    chatWatch.get(s.target)!.add(s.chatId)
  }
  const lastPump = new Map<string, { ts: number; key: string }[]>()
  for (const p of pumps) {
    const k = `${p.chatId}:${p.token}`
    lastPump.set(k, [...(lastPump.get(k) ?? []), { ts: p.ts, key: p.key }])
  }
  return {
    users: users.map((u) => ({ ...u, settings: readSettings(u.settings, "private") })),
    chats: chats.map((c) => ({ ...c, settings: readSettings(c.settings, c.chatType) })),
    watch,
    chatWatch,
    mute,
    lastPump,
    watches: owners(nftWatches),
    nftMutes: owners(nftMuteRows),
    listingSent,
    lastFloor,
  }
}

/** Chats that get NEW TOKEN: users and active chats with it on and its route not paused, with their topic. */
export function newTokenChats(
  aud: Audience,
): { chatId: string; chatType: ChatType; threadId: number | null }[] {
  const out: { chatId: string; chatType: ChatType; threadId: number | null }[] = []
  for (const u of aud.users) {
    if (u.settings.alerts.new.on)
      out.push({ chatId: u.chatId, chatType: "private", threadId: null })
  }
  for (const c of aud.chats) {
    if (!c.settings.alerts.new.on || c.settings.pausedRoutes?.includes("new")) continue
    const threadId =
      c.chatType === "channel" ? null : (c.settings.routes?.new ?? c.settings.thread ?? null)
    out.push({ chatId: c.chatId, chatType: c.chatType, threadId })
  }
  return out
}

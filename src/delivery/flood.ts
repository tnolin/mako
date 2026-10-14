import type { LaunchEvent } from "@ink-indexer/events"
import type { Payload } from "../cards/card"
import { clean } from "../format"
import type { Row } from "../history"
import { launchpadOf } from "../launchpads"
import type { ChatType } from "./recipients"

/** More than this many launches on one launchpad within FLOOD_WINDOW_S is a flood. */
export const FLOOD_LAUNCHES = 10
export const FLOOD_WINDOW_S = 300
/** One NEW TOKENS card per chat per minute of flood, sent after the minute plus a grace for indexer lag. */
export const BATCH_S = 60
export const BATCH_GRACE_S = 30
export const BATCH_SHOWN = 10
export const BATCH_NAME_MAX = 20
/**
 * The poller looks back further and further until every flood start it uses is certain, up to this far.
 * shortcut: a flood that has lasted longer than this can get one more notice per MAX_LOOKBACK_S.
 */
export const MAX_LOOKBACK_S = 86_400

export type LaunchMark = { id: string; launchpad: string; ts: number }

/**
 * Launch id → id of the launch that started its flood, for launches in flood. A launch is in flood when its
 * launchpad had more than FLOOD_LAUNCHES launches in the FLOOD_WINDOW_S up to and including it (id order).
 * A start is only right when the launch before it was classified with a full window; `uncertainStarts`
 * names the starts that aren't, so the caller can load more history. The sliding window assumes
 * timestamps never decrease in id order, which holds because events are inserted in block order.
 */
export function floodStarts(all: LaunchMark[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const ls of byLaunchpad(all).values()) {
    let start: string | null = null
    let lo = 0
    for (let i = 0; i < ls.length; i++) {
      const l = ls[i]!
      while (ls[lo]!.ts <= l.ts - FLOOD_WINDOW_S) lo++
      if (i - lo + 1 > FLOOD_LAUNCHES) {
        start ??= l.id
        out.set(l.id, start)
      } else {
        start = null
      }
    }
  }
  return out
}

function byLaunchpad(all: LaunchMark[]): Map<string, LaunchMark[]> {
  const m = new Map<string, LaunchMark[]>()
  for (const l of all) {
    const ls = m.get(l.launchpad)
    if (ls) ls.push(l)
    else m.set(l.launchpad, [l])
  }
  return m
}

/**
 * Flood starts that may be wrong because `all` begins at `fromTs`: the start's own window or the window of
 * the launch before it reaches back past the history loaded, so the flood may really have started earlier.
 */
export function uncertainStarts(
  all: LaunchMark[],
  fromTs: number,
  starts: Map<string, string>,
): Set<string> {
  const out = new Set<string>()
  for (const ls of byLaunchpad(all).values()) {
    for (let i = 0; i < ls.length; i++) {
      const l = ls[i]!
      if (starts.get(l.id) !== l.id) continue
      const prev = ls[i - 1]
      if (l.ts - FLOOD_WINDOW_S < fromTs || !prev || prev.ts - FLOOD_WINDOW_S < fromTs)
        out.add(l.id)
    }
  }
  return out
}

export type FloodRow = {
  chatId: string
  chatType: ChatType
  threadId: number | null
  dedupeKey: string
  /** Epoch seconds. */
  eventTs: number
  /** Epoch seconds; set on cards, which wait for their minute to end. */
  sendAfter: number | null
  payload: Payload
}

type Target = { chatId: string; chatType: ChatType; threadId: number | null }

const noticeHtml = (name: string) =>
  `Lots of new tokens are launching on ${name} at once. To avoid spam, NEW TOKEN alerts are grouped into one message per minute until it slows down.`

/**
 * The deliveries that replace individual NEW TOKEN alerts for launches in flood: one notice per flood and
 * one card per minute bucket, for every chat that gets NEW TOKEN. `flooded` is in event-id order.
 */
export function floodRows(
  flooded: Row<LaunchEvent>[],
  starts: Map<string, string>,
  to: Target[],
): FloodRow[] {
  const notices = new Map<string, { name: string; ts: number }>()
  const cards = new Map<
    string,
    { lp: string; minute: number; entries: { token: string; name: string; ticker: string }[] }
  >()
  for (const l of flooded) {
    const lp = l.p.launchpad
    const name = launchpadOf(lp).name
    const nk = `flood:${lp}:${starts.get(l.id)}`
    // Half a second past its launch, so the notice follows the individual alerts of that same second.
    if (!notices.has(nk)) notices.set(nk, { name, ts: l.p.blockTimestamp + 0.5 })
    const minute = Math.floor(l.p.blockTimestamp / BATCH_S)
    const ck = `newtokens:${lp}:${minute}`
    const card = cards.get(ck) ?? { lp: name, minute, entries: [] }
    card.entries.push({
      token: l.p.token,
      name: clean(l.p.name, BATCH_NAME_MAX),
      ticker: clean(l.p.ticker, 32) || "?",
    })
    cards.set(ck, card)
  }
  const out: FloodRow[] = []
  for (const t of to) {
    for (const [key, n] of notices) {
      out.push({
        ...t,
        dedupeKey: key,
        eventTs: n.ts,
        sendAfter: null,
        payload: { type: "text", html: noticeHtml(n.name) },
      })
    }
    for (const [key, c] of cards) {
      const end = (c.minute + 1) * BATCH_S
      out.push({
        ...t,
        dedupeKey: key,
        eventTs: end,
        sendAfter: end + BATCH_GRACE_S,
        payload: { type: "newtokens", launchpad: c.lp, entries: c.entries },
      })
    }
  }
  return out
}

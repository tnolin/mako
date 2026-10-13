import { valueText } from "../cards/money"
import { age, bar, buysSells } from "../format"
import { MARKS, PRIORITY } from "../settings"
import { makeCard } from "./card"
import { devCounts, prevSoldBps, windowStats } from "./stats"
import type { Candidate, TradeCtx } from "./types"

/** One candidate per mark crossed; recipients keep the highest mark each chat has. */
export function bonding(t: TradeCtx): Candidate[] {
  const p = t.ev.p
  const l = t.launch.p
  const before = prevSoldBps(t.trades, t.ev.id)
  const crossed = MARKS.filter((m) => before < m && m <= p.soldBps)
  if (crossed.length === 0) return []
  const w = windowStats(t.trades, p.blockTimestamp - 3600, t.ev.id)
  const dev = devCounts(t.trades, l.creator, t.ev.id)
  const rows: [string, string][] = [
    ["curve", bar(p.soldBps)],
    ["mcap", valueText(p.marketCap, p.quoteAsset, t.prices)],
    ["volume", `${valueText(w.volume, p.quoteAsset, t.prices)} (1h)`],
    ["trades", `${buysSells(w.buys, w.sells)} (1h)`],
    ["age", age(p.blockTimestamp - l.blockTimestamp)],
    ["dev", buysSells(dev.buys, dev.sells)],
  ]
  return crossed.map((mark) => ({
    alert: "bonding",
    eventId: t.ev.id,
    token: p.token,
    dedupeKey: `bonding:${mark}:${p.token}`,
    priority: PRIORITY.bonding,
    eventTs: p.blockTimestamp,
    mark,
    card: makeCard("bonding", `BONDING ${mark / 100}%`, l, rows),
  }))
}

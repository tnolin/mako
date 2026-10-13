import { valueText } from "../cards/money"
import { age, bar, buysSells } from "../format"
import { PRIORITY } from "../settings"
import { makeCard } from "./card"
import { pumpWindow, windowStats } from "./stats"
import type { Candidate, TradeCtx } from "./types"

export const PUMP_BPS = 1500

export function pumping(t: TradeCtx): Candidate[] {
  const p = t.ev.p
  const l = t.launch.p
  if (p.txHash === l.txHash) return []
  const w = pumpWindow(t.trades, t.ev, l.txHash)
  const gain = p.soldBps - w.base
  if (gain < PUMP_BPS) return []
  const mins = Math.max(1, Math.ceil((p.blockTimestamp - w.firstTs) / 60))
  const win = windowStats(t.trades, w.firstTs, t.ev.id)
  return [
    {
      alert: "pumping",
      eventId: t.ev.id,
      token: p.token,
      dedupeKey: `pump:${p.txHash}:${p.logIndex}`,
      priority: PRIORITY.pumping,
      eventTs: p.blockTimestamp,
      card: makeCard("pumping", "PUMPING", l, [
        ["curve", `${bar(p.soldBps)} (+${Math.floor(gain / 100)}% in ${mins}m)`],
        ["mcap", valueText(p.marketCap, p.quoteAsset, t.prices)],
        ["volume", `${valueText(win.volume, p.quoteAsset, t.prices)} (${mins}m)`],
        ["trades", `${buysSells(win.buys, win.sells)} (${mins}m)`],
        ["age", age(p.blockTimestamp - l.blockTimestamp)],
      ]),
    },
  ]
}

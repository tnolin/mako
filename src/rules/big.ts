import { quoteText, valueText } from "../cards/money"
import { bar, bpsChange } from "../format"
import { PRIORITY } from "../settings"
import { makeCard } from "./card"
import { prevSoldBps } from "./stats"
import type { Candidate, TradeCtx } from "./types"

/** The smallest selectable threshold; recipients compare sizeBps with their own setting. */
export const MIN_BIG_BPS = 250

export function big(t: TradeCtx): Candidate[] {
  const p = t.ev.p
  const l = t.launch.p
  if (p.txHash === l.txHash) return []
  if (p.side === "sell" && p.trader === l.creator) return []
  const sizeBps = Number((BigInt(p.quoteAmount) * 10_000n) / BigInt(p.target))
  if (sizeBps < MIN_BIG_BPS) return []
  const buy = p.side === "buy"
  return [
    {
      alert: "big",
      eventId: t.ev.id,
      token: p.token,
      dedupeKey: `big:${p.txHash}:${p.logIndex}`,
      priority: PRIORITY.big,
      eventTs: p.blockTimestamp,
      sizeBps,
      card: makeCard("big", buy ? "BIG BUY" : "BIG SELL", l, [
        [buy ? "bought" : "sold", quoteText(p.quoteAmount, p.quoteAsset, t.prices)],
        ["curve", `${bar(p.soldBps)} ${bpsChange(p.soldBps - prevSoldBps(t.trades, t.ev.id))}`],
        ["mcap", valueText(p.marketCap, p.quoteAsset, t.prices)],
      ]),
    },
  ]
}

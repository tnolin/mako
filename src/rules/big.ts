import { quoteText, valueText } from "../cards/money"
import { bar, bpsChange, units } from "../format"
import { PRIORITY } from "../settings"
import { makeCard } from "./card"
import { prevSoldBps } from "./stats"
import type { Candidate, SwapCtx, TradeCtx } from "./types"

/** The smallest selectable threshold; recipients compare sizeBps with their own setting. */
export const MIN_BIG_BPS = 250
/** A pool trade worth less than this in USD never sends BIG, however thin the pool. */
export const BIG_MIN_USD = 500

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
      target: p.token,
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

/**
 * BIG BUY/SELL on a pool trade, sized against the pool's quote side before the trade. Without a USD price the
 * $500 minimum can't be checked, so nothing is sent.
 */
export function bigSwap(s: SwapCtx): Candidate[] {
  const p = s.ev.p
  const l = s.launch.p
  if (p.side === "sell" && p.trader === l.creator) return []
  const quote = BigInt(p.quoteAmount)
  const liquidity = BigInt(p.quoteLiquidity)
  const buy = p.side === "buy"
  const before = buy ? liquidity - quote : liquidity + quote
  if (before <= 0n) return []
  const price = s.prices.usd(p.quoteAsset)
  if (price === null || units(quote) * price < BIG_MIN_USD) return []
  const sizeBps = Number((quote * 10_000n) / before)
  if (sizeBps < MIN_BIG_BPS) return []
  return [
    {
      alert: "big",
      eventId: s.ev.id,
      target: p.token,
      dedupeKey: `big:${p.txHash}:${p.logIndex}`,
      priority: PRIORITY.big,
      eventTs: p.blockTimestamp,
      sizeBps,
      card: makeCard("big", buy ? "BIG BUY" : "BIG SELL", l, [
        [buy ? "bought" : "sold", quoteText(quote, p.quoteAsset, s.prices)],
        ["mcap", valueText(p.marketCap, p.quoteAsset, s.prices)],
        ["liquidity", valueText(2n * liquidity, p.quoteAsset, s.prices)],
      ]),
    },
  ]
}

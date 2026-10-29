import { quoteUnits, valueText } from "../cards/money"
import { age, bar, buysSells } from "../format"
import { PRIORITY, PUMP_BONDED_STEPS } from "../settings"
import { makeCard } from "./card"
import { buyers, pumpWindow, windowStats } from "./stats"
import type { Candidate, SwapCtx, TradeCtx } from "./types"

export const PUMP_BPS = 1500
/** The smallest bonded PUMPING threshold a chat can pick; gains under it are only observed. */
const MIN_BONDED_BPS = PUMP_BONDED_STEPS[0]

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
      target: p.token,
      dedupeKey: `pump:${p.txHash}:${p.logIndex}`,
      priority: PRIORITY.pumping,
      eventTs: p.blockTimestamp,
      card: makeCard("pumping", "PUMPING", l, [
        ["pumped", `+${Math.floor(gain / 100)}% (${mins}m)`],
        ["curve", bar(p.soldBps)],
        ["mcap", valueText(p.marketCap, p.quoteAsset, t.prices)],
        ["volume", `${valueText(win.volume, p.quoteAsset, t.prices)} (${mins}m)`],
        ["trades", `${buysSells(win.buys, win.sells)} (${mins}m)`],
        ["age", age(p.blockTimestamp - l.blockTimestamp)],
      ]),
    },
  ]
}

/**
 * PUMPING after bonding: the market cap's gain over the lowest market cap of this pool's swaps in the last 10
 * minutes. Every swap yields one candidate so the re-arm state sees each gain; recipients compare the gain with
 * their own threshold.
 */
export function pumpingBonded(s: SwapCtx): Candidate[] {
  const p = s.ev.p
  const l = s.launch.p
  const mcap = BigInt(p.marketCap)
  let low = s.ev
  for (const w of s.swaps) {
    if (w.p.poolId === p.poolId && BigInt(w.p.marketCap) < BigInt(low.p.marketCap)) low = w
  }
  const lowCap = BigInt(low.p.marketCap)
  const gainBps = lowCap > 0n ? Number(((mcap - lowCap) * 10_000n) / lowCap) : 0
  const price = s.prices.usd(p.quoteAsset)
  const base = {
    alert: "pumping" as const,
    eventId: s.ev.id,
    target: p.token,
    dedupeKey: `pump:${p.txHash}:${p.logIndex}`,
    priority: PRIORITY.pumping,
    eventTs: p.blockTimestamp,
    mcapUsd: price === null ? null : quoteUnits(mcap) * price,
  }
  if (gainBps < MIN_BONDED_BPS) {
    return [
      {
        ...base,
        pump: { token: p.token, gainBps, observeOnly: true },
        card: makeCard("pumping", "PUMPING", l, []),
      },
    ]
  }
  const from = low.p.blockTimestamp
  const mins = `${Math.max(1, Math.ceil((p.blockTimestamp - from) / 60))}m`
  // Volume, trades and buyers count every pool of the token, as /t does.
  const inWindow = s.swaps.filter((w) => w.p.blockTimestamp >= from)
  const win = windowStats(inWindow, from, s.ev.id)
  const ath = BigInt(p.athMarketCap)
  const down = ath > mcap ? Number(((ath - mcap) * 100n) / ath) : 0
  const value = (raw: bigint) => valueText(raw, p.quoteAsset, s.prices)
  return [
    {
      ...base,
      pump: { token: p.token, gainBps },
      card: makeCard("pumping", "PUMPING", l, [
        ["pumped", `+${Math.floor(gainBps / 100)}% (${mins})`],
        ["mcap", value(mcap)],
        ["ath", `${value(ath)} (${down === 0 ? "0" : `−${down}`}%)`],
        ["liquidity", value(2n * BigInt(p.quoteLiquidity))],
        ["volume", `${value(win.volume)} (${mins})`],
        ["trades", `${buysSells(win.buys, win.sells)} (${mins})`],
        ["buyers", `${buyers(inWindow)} (${mins})`],
        s.bond
          ? ["bonded", `${age(p.blockTimestamp - s.bond.p.blockTimestamp)} ago`]
          : ["age", age(p.blockTimestamp - l.blockTimestamp)],
      ]),
      holds: {
        token: l.token,
        holder: l.creator,
        block: p.blockNumber,
        totalSupply: l.totalSupply,
      },
    },
  ]
}

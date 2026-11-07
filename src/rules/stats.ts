import type { LaunchEvent, SwapEvent, TradeEvent } from "@ink-indexer/events"
import { quoteUnits, valueText } from "../cards/money"
import { usd } from "../format"
import type { Row } from "../history"
import type { Prices } from "../prices"

const lt = (a: string, b: string) => BigInt(a) < BigInt(b)
const le = (a: string, b: string) => BigInt(a) <= BigInt(b)

/** soldBps after the last trade before `id`, or 0. */
export function prevSoldBps(trades: Row<TradeEvent>[], id: string): number {
  let v = 0
  for (const t of trades) {
    if (!lt(t.id, id)) break
    v = t.p.soldBps
  }
  return v
}

/** How to total the volume of a token that trades in more than one quote: the quote its figures are shown in. */
export type Across = { prices: Prices; quote: string }

/** `Across` for a launch with more than one market, otherwise undefined: one quote is summed in its own units. */
export function acrossQuotes(
  launch: LaunchEvent,
  quote: string,
  prices: Prices,
): Across | undefined {
  return (launch.markets?.length ?? 0) > 1 ? { prices, quote } : undefined
}

/**
 * Volume (sum of quoteAmount) and buy/sell counts for trades or swaps at or after `fromTs`, up to `uptoId`.
 *
 * With `across`, the markets of a multi-pair token are in different currencies, so the volume is `usd`: each
 * swap's quote amount at its quote's price, with swaps in a quote that has no price left out. When `across.quote`
 * itself has no price, there is no dollar total and `volume` sums the swaps in that quote alone. Counts include
 * every swap either way.
 */
export function windowStats(
  trades: Row<TradeEvent | SwapEvent>[],
  fromTs: number,
  uptoId: string,
  across?: Across,
): { volume: bigint; buys: number; sells: number; usd?: number } {
  const dollars = across !== undefined && across.prices.usd(across.quote) !== null
  let volume = 0n
  let total = 0
  let buys = 0
  let sells = 0
  for (const t of trades) {
    if (!le(t.id, uptoId) || t.p.blockTimestamp < fromTs) continue
    if (across === undefined) {
      volume += BigInt(t.p.quoteAmount)
    } else if (dollars) {
      const price = across.prices.usd(t.p.quoteAsset)
      if (price !== null) total += quoteUnits(t.p.quoteAmount, t.p.quoteAsset) * price
    } else if (t.p.quoteAsset === across.quote) {
      volume += BigInt(t.p.quoteAmount)
    }
    if (t.p.side === "buy") buys++
    else sells++
  }
  return dollars ? { volume, buys, sells, usd: total } : { volume, buys, sells }
}

/** A window's volume as a card shows it: dollars for a multi-pair total, else `valueText` in `quote`. */
export function windowVolumeText(
  w: { volume: bigint; usd?: number },
  quote: string,
  prices: Prices,
): string {
  return w.usd === undefined ? valueText(w.volume, quote, prices) : usd(w.usd)
}

/** Distinct wallets that bought, by the transaction sender. */
export function buyers(swaps: Row<SwapEvent>[]): number {
  return new Set(swaps.filter((s) => s.p.side === "buy").map((s) => s.p.trader)).size
}

type Fill = Row<TradeEvent | SwapEvent>

const devTrades = (trades: Fill[], creator: string, uptoId: string) =>
  trades.filter((t) => t.p.trader === creator && le(t.id, uptoId))

/** Curve trades and pool swaps as one history in id order. */
export function fills(trades: Row<TradeEvent>[], swaps: Row<SwapEvent>[]): Fill[] {
  return [...trades, ...swaps].sort((a, b) => (lt(a.id, b.id) ? -1 : lt(b.id, a.id) ? 1 : 0))
}

/**
 * Whether the creator's fills are in more than one quote asset, as on a multi-pair token. Their amounts cannot be
 * added into one PnL then.
 */
export function devSpansQuotes(trades: Fill[], creator: string, uptoId: string): boolean {
  return new Set(devTrades(trades, creator, uptoId).map((t) => t.p.quoteAsset)).size > 1
}

export function devCounts(trades: Fill[], creator: string, uptoId: string) {
  const d = devTrades(trades, creator, uptoId)
  return {
    buys: d.filter((t) => t.p.side === "buy").length,
    sells: d.filter((t) => t.p.side === "sell").length,
  }
}

/**
 * Realized PnL of the creator's curve trades and pool swaps by average cost, in id order. Tokens sold
 * beyond what the creator bought (allocation, transfers) carry a zero cost basis.
 */
export function devPnl(trades: Fill[], creator: string, uptoId: string) {
  let qty = 0n
  let cost = 0n
  let realized = 0n
  let basis = 0n
  for (const t of devTrades(trades, creator, uptoId)) {
    const tokens = BigInt(t.p.tokenAmount)
    const quote = BigInt(t.p.quoteAmount)
    if (t.p.side === "buy") {
      qty += tokens
      cost += quote
      continue
    }
    const covered = tokens < qty ? tokens : qty
    const c = qty > 0n ? (cost * covered) / qty : 0n
    cost -= c
    qty -= covered
    realized += quote - c
    basis += c
  }
  return { realized, basis }
}

export function launchTxTrades(trades: Row<TradeEvent>[], txHash: string): Row<TradeEvent>[] {
  return trades.filter((t) => t.p.txHash === txHash)
}

/**
 * PUMPING baseline: soldBps at the last trade at least 600 s before `current`; for a younger token,
 * soldBps right after the launch transaction (0 without one). `firstTs` is the first trade after the
 * baseline, where the shown window starts.
 */
export function pumpWindow(
  trades: Row<TradeEvent>[],
  current: Row<TradeEvent>,
  launchTxHash: string,
): { base: number; firstTs: number } {
  const prior = trades.filter((t) => lt(t.id, current.id))
  const cutoff = current.p.blockTimestamp - 600
  let i = -1
  prior.forEach((t, k) => {
    if (t.p.blockTimestamp <= cutoff) i = k
  })
  if (i >= 0) {
    return { base: prior[i]!.p.soldBps, firstTs: (prior[i + 1] ?? current).p.blockTimestamp }
  }
  const launchTx = prior.filter((t) => t.p.txHash === launchTxHash)
  const first = prior.find((t) => t.p.txHash !== launchTxHash) ?? current
  return { base: launchTx.at(-1)?.p.soldBps ?? 0, firstTs: first.p.blockTimestamp }
}

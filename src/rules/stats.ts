import type { TradeEvent } from "@ink-indexer/events"
import type { Row } from "../history"

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

/** Volume (sum of quoteAmount) and buy/sell counts for trades at or after `fromTs`, up to `uptoId`. */
export function windowStats(
  trades: Row<TradeEvent>[],
  fromTs: number,
  uptoId: string,
): { volume: bigint; buys: number; sells: number } {
  let volume = 0n
  let buys = 0
  let sells = 0
  for (const t of trades) {
    if (!le(t.id, uptoId) || t.p.blockTimestamp < fromTs) continue
    volume += BigInt(t.p.quoteAmount)
    if (t.p.side === "buy") buys++
    else sells++
  }
  return { volume, buys, sells }
}

const devTrades = (trades: Row<TradeEvent>[], creator: string, uptoId: string) =>
  trades.filter((t) => t.p.trader === creator && le(t.id, uptoId))

export function devCounts(trades: Row<TradeEvent>[], creator: string, uptoId: string) {
  const d = devTrades(trades, creator, uptoId)
  return {
    buys: d.filter((t) => t.p.side === "buy").length,
    sells: d.filter((t) => t.p.side === "sell").length,
  }
}

/**
 * Realized PnL of the creator's curve trades by average cost. Tokens sold beyond what the creator
 * bought on the curve (allocation, transfers) carry a zero cost basis.
 */
export function devPnl(trades: Row<TradeEvent>[], creator: string, uptoId: string) {
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

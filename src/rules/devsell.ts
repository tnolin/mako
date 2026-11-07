import type { Card } from "../cards/card"
import { pnlText, valueText } from "../cards/money"
import { bar, buysSells, compact, pct1, units } from "../format"
import type { DevHolds } from "../rpc"
import { PRIORITY } from "../settings"
import { makeCard } from "./card"
import { withHooks } from "./hooks-row"
import { devCounts, devPnl, fills } from "./stats"
import type { Candidate, SwapCtx, TradeCtx } from "./types"

export function devSell(t: TradeCtx): Candidate[] {
  const p = t.ev.p
  const l = t.launch.p
  if (p.side !== "sell" || p.trader !== l.creator) return []
  const pnl = devPnl(t.trades, l.creator, t.ev.id)
  const dev = devCounts(t.trades, l.creator, t.ev.id)
  const share = Number((BigInt(p.tokenAmount) * 1_000_000n) / BigInt(l.totalSupply)) / 10_000
  const card = makeCard("devsell", "DEV SELL", l, [])
  card.rows = [
    ["sold", `${compact(units(p.tokenAmount))} (${pct1(share)})`],
    ["dev pnl", pnlText(pnl.realized, pnl.basis, p.quoteAsset, t.prices)],
    ["dev", buysSells(dev.buys, dev.sells)],
    ["curve", bar(p.soldBps)],
    ["mcap", valueText(p.marketCap, p.quoteAsset, t.prices)],
  ]
  card.rows = withHooks(card.rows, l)
  return [
    {
      alert: "devsell",
      eventId: t.ev.id,
      target: p.token,
      dedupeKey: `devsell:${p.txHash}:${p.logIndex}`,
      priority: PRIORITY.devsell,
      eventTs: p.blockTimestamp,
      card,
      holds: {
        token: l.token,
        holder: l.creator,
        block: p.blockNumber,
        totalSupply: l.totalSupply,
      },
    },
  ]
}

/** DEV SELL on a pool sell by the creator. PnL and counts cover the creator's curve trades and pool swaps. */
export function devSellSwap(s: SwapCtx): Candidate[] {
  const p = s.ev.p
  const l = s.launch.p
  if (p.side !== "sell" || p.trader !== l.creator) return []
  const history = fills(s.dev?.trades ?? [], s.dev?.swaps ?? [])
  const pnl = devPnl(history, l.creator, s.ev.id)
  const dev = devCounts(history, l.creator, s.ev.id)
  const share = Number((BigInt(p.tokenAmount) * 1_000_000n) / BigInt(l.totalSupply)) / 10_000
  const card = makeCard("devsell", "DEV SELL", l, [])
  card.rows = [
    ["sold", `${compact(units(p.tokenAmount))} (${pct1(share)})`],
    ["dev pnl", pnlText(pnl.realized, pnl.basis, p.quoteAsset, s.prices)],
    ["dev", buysSells(dev.buys, dev.sells)],
    ["mcap", valueText(p.marketCap, p.quoteAsset, s.prices)],
  ]
  card.rows = withHooks(card.rows, l)
  return [
    {
      alert: "devsell",
      eventId: s.ev.id,
      target: p.token,
      dedupeKey: `devsell:${p.txHash}:${p.logIndex}`,
      priority: PRIORITY.devsell,
      eventTs: p.blockTimestamp,
      card,
      holds: {
        token: l.token,
        holder: l.creator,
        block: p.blockNumber,
        totalSupply: l.totalSupply,
      },
    },
  ]
}

/**
 * Inserts `dev holds` next to the first anchor row found, or at the end (before a hooks row) when the card has none. Leaves the card as it
 * is when the read failed.
 */
export function withDevHolds(
  card: Card,
  h: DevHolds,
  at: { after: string } | { before: string | string[] },
): Card {
  if (!h) return card
  const rows = [...card.rows]
  const anchors = "after" in at ? [at.after] : [at.before].flat()
  const i = rows.findIndex(([k]) => anchors.includes(k))
  const row: [string, string] = ["dev holds", `${pct1(h.pct)}${h.now ? " (now)" : ""}`]
  if (i >= 0) rows.splice("after" in at ? i + 1 : i, 0, row)
  else {
    // The hooks row stays the last row.
    const hooks = rows.findIndex(([k]) => k === "hooks")
    rows.splice(hooks < 0 ? rows.length : hooks, 0, row)
  }
  return { ...card, rows }
}

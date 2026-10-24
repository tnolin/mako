import type { Card } from "../cards/card"
import { pnlText, valueText } from "../cards/money"
import { bar, buysSells, compact, pct1, units } from "../format"
import type { DevHolds } from "../rpc"
import { PRIORITY } from "../settings"
import { makeCard } from "./card"
import { devCounts, devPnl } from "./stats"
import type { Candidate, TradeCtx } from "./types"

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

/** Inserts `dev holds` after the `dev` row, or leaves the card as it is when the read failed. */
export function withDevHolds(card: Card, h: DevHolds): Card {
  if (!h) return card
  const rows = [...card.rows]
  const i = rows.findIndex(([k]) => k === "dev")
  rows.splice(i + 1, 0, ["dev holds", `${pct1(h.pct)}${h.now ? " (now)" : ""}`])
  return { ...card, rows }
}

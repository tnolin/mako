import type { BondEvent, LaunchEvent, TradeEvent } from "@ink-indexer/events"
import { quoteUnits, valueText } from "../cards/money"
import { age, amount, buysSells, compact, count, units } from "../format"
import type { Row } from "../history"
import type { Prices } from "../prices"
import { PRIORITY } from "../settings"
import { makeCard } from "./card"
import { devCounts, windowStats } from "./stats"
import type { Candidate } from "./types"

export function bonded(
  ev: Row<BondEvent>,
  launch: Row<LaunchEvent>,
  trades: Row<TradeEvent>[],
  prices: Prices,
): Candidate {
  const b = ev.p
  const l = launch.p
  const w = windowStats(trades, 0, ev.id)
  const dev = devCounts(trades, l.creator, ev.id)
  const last = trades.at(-1)
  const card = makeCard("bonded", "BONDED", l, [])
  const rows: [string, string][] = [["age", age(b.blockTimestamp - l.blockTimestamp)]]
  if (last) rows.push(["mcap", valueText(last.p.marketCap, l.quoteAsset, prices)])
  rows.push(
    [
      "pool",
      `${amount(quoteUnits(b.liquidityQuote))} ${prices.symbol(b.quoteAsset)} + ${compact(units(b.liquidityTokens))} ${card.ticker}`,
    ],
    ["volume", valueText(w.volume, l.quoteAsset, prices)],
    ["trades", count(w.buys + w.sells)],
    ["dev", buysSells(dev.buys, dev.sells)],
  )
  return {
    alert: "bonded",
    eventId: ev.id,
    target: b.token,
    dedupeKey: `bonded:${b.token}`,
    priority: PRIORITY.bonded,
    eventTs: b.blockTimestamp,
    supersedesBonding: true,
    card: { ...card, rows },
  }
}

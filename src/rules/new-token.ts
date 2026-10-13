import type { LaunchEvent, TradeEvent } from "@ink-indexer/events"
import { quoteText } from "../cards/money"
import { count, pct1 } from "../format"
import type { Row } from "../history"
import type { Prices } from "../prices"
import { PRIORITY } from "../settings"
import { creatorLinks, makeCard } from "./card"
import { launchTxTrades } from "./stats"
import type { Candidate } from "./types"

export function newToken(
  ev: Row<LaunchEvent>,
  trades: Row<TradeEvent>[],
  stats: { launches: number; bonded: number },
  prices: Prices,
): Candidate {
  const l = ev.p
  const card = makeCard("new", "NEW TOKEN", l, [], creatorLinks(l))
  const rows: [string, string][] = [
    ["pair", `${card.ticker}/${prices.symbol(l.quoteAsset)}`],
    ["bonds at", quoteText(l.targetRaise, l.quoteAsset, prices)],
  ]
  const devBuys = launchTxTrades(trades, l.txHash).filter(
    (t) => t.p.side === "buy" && t.p.trader === l.creator,
  )
  if (devBuys.length > 0) {
    const quote = devBuys.reduce((s, t) => s + BigInt(t.p.quoteAmount), 0n)
    const tokens = devBuys.reduce((s, t) => s + BigInt(t.p.tokenAmount), 0n)
    const share = Number((tokens * 1_000_000n) / BigInt(l.totalSupply)) / 10_000
    rows.push(["dev buy", `${quoteText(quote, l.quoteAsset, prices, false)} (${pct1(share)})`])
  }
  rows.push([
    "dev",
    `${count(stats.launches)} launch${stats.launches === 1 ? "" : "es"} | ${count(stats.bonded)} bonded`,
  ])
  return {
    alert: "new",
    eventId: ev.id,
    token: l.token,
    dedupeKey: `new:${l.token}`,
    priority: PRIORITY.new,
    eventTs: l.blockTimestamp,
    card: { ...card, rows },
  }
}

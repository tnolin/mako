import type { LaunchEvent, SwapEvent, TradeEvent } from "@ink-indexer/events"
import { quoteText } from "../cards/money"
import { count, pct1 } from "../format"
import type { Row } from "../history"
import type { Prices } from "../prices"
import { PRIORITY } from "../settings"
import { creatorLinks, makeCard } from "./card"
import { withHooks } from "./hooks-row"
import { launchTxTrades } from "./stats"
import type { Candidate } from "./types"

/** A creator with at least this many launches and none bonded is a serial launcher: their launches send no NEW TOKEN. */
export const SERIAL_LAUNCHER_MIN_LAUNCHES = 10

/**
 * A token that starts in a pool never bonds, so its creator's bonded count says nothing about how their launches
 * did: those launches always send.
 */
export const isSerialLauncher = (
  launch: Pick<LaunchEvent, "startsInPool">,
  stats: { launches: number; bonded: number },
): boolean =>
  launch.startsInPool !== true &&
  stats.launches >= SERIAL_LAUNCHER_MIN_LAUNCHES &&
  stats.bonded === 0

export function newToken(
  ev: Row<LaunchEvent>,
  trades: Row<TradeEvent>[],
  /** The swaps of the launch transaction, for a token that starts in a pool. */
  swaps: Row<SwapEvent>[],
  stats: { launches: number; bonded: number },
  prices: Prices,
): Candidate {
  const l = ev.p
  const card = makeCard("new", "NEW TOKEN", l, [], creatorLinks(l))
  const others = (l.markets?.length ?? 0) - 1
  const rows: [string, string][] = [
    ["pair", `${card.ticker}/${prices.symbol(l.quoteAsset)}${others > 0 ? ` +${others}` : ""}`],
  ]
  // A token that starts in a pool has no curve, so nothing to bond at.
  if (l.targetRaise !== null)
    rows.push(["bonds at", quoteText(l.targetRaise, l.quoteAsset, prices)])
  const devBuys = [
    ...launchTxTrades(trades, l.txHash),
    // Only market 0's pool: a launch transaction can also swap in the token's other markets.
    ...swaps.filter((s) => s.p.txHash === l.txHash && s.p.poolId === l.poolId),
  ].filter((t) => t.p.side === "buy" && t.p.trader === l.creator)
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
    target: l.token,
    dedupeKey: `new:${l.token}`,
    priority: PRIORITY.new,
    eventTs: l.blockTimestamp,
    card: { ...card, rows: withHooks(rows, l) },
  }
}

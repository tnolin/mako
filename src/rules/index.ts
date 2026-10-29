import type {
  BondEvent,
  IndexerEvent,
  LaunchEvent,
  NftCollectionEvent,
  NftDropEvent,
  SwapEvent,
  TradeEvent,
} from "@ink-indexer/events"
import {
  bondOf,
  creatorStats,
  devTradesOf,
  launchOf,
  type Row,
  swapsOf,
  tradesOf,
} from "../history"
import { marketRules } from "../nft/rules/market"
import { mintRules } from "../nft/rules/mint"
import { big, bigSwap } from "./big"
import { bonded } from "./bonded"
import { bonding } from "./bonding"
import { devSell, devSellSwap } from "./devsell"
import { newToken } from "./new-token"
import { pumping, pumpingBonded } from "./pumping"
import type { Candidate, RuleCtx, SwapCtx } from "./types"

export { withDevHolds } from "./devsell"
export type { Candidate, RuleCtx, SwapCtx } from "./types"

/** Seconds of swap history a swap rule sees. */
const SWAP_WINDOW_S = 600

const missingLaunch = (ev: Row<IndexerEvent>, token: string, ctx: RuleCtx) =>
  ctx.log("warn", "event without a launch event, skipped", { id: ev.id, token, type: ev.p.type })

/** What the swap rules read for one pool swap, or null when the token's launch is missing. */
export async function swapCtx(ev: Row<SwapEvent>, ctx: RuleCtx): Promise<SwapCtx | null> {
  const p = ev.p
  const launch = await launchOf(ctx.sql, p.token)
  if (!launch) {
    missingLaunch(ev, p.token, ctx)
    return null
  }
  const [bond, swaps, dev] = await Promise.all([
    bondOf(ctx.sql, p.token),
    swapsOf(ctx.sql, p.token, ev.id, p.blockTimestamp - SWAP_WINDOW_S),
    p.trader === launch.p.creator ? devTradesOf(ctx.sql, p.token, p.trader, ev.id) : null,
  ])
  return { ev, launch, bond, swaps, dev, prices: ctx.prices }
}

/**
 * Candidate alerts for one confirmed event. Reads only indexer.events. For an nft.collection or nft.drop event, `prev`
 * is the snapshot it replaced in the NFT state; the state already holds the event.
 */
export async function rulesFor(
  ev: Row<IndexerEvent>,
  ctx: RuleCtx,
  prev: NftCollectionEvent | NftDropEvent | null = null,
): Promise<Candidate[]> {
  const p = ev.p
  switch (p.type) {
    case "nft.collection":
    case "nft.drop":
    case "nft.mint":
    case "nft.launch":
      return mintRules(ev as never, prev, ctx)
    case "nft.listing":
    case "nft.sale":
    case "nft.stats":
      return marketRules(ev as never, ctx)
  }
  if (p.type === "launchpad.launch") {
    const [trades, stats] = await Promise.all([
      tradesOf(ctx.sql, p.token),
      creatorStats(ctx.sql, p.creator, ev.id),
    ])
    return [newToken(ev as Row<LaunchEvent>, trades, stats, ctx.prices)]
  }
  if (p.type === "launchpad.swap") {
    const s = await swapCtx(ev as Row<SwapEvent>, ctx)
    if (!s) return []
    return [...devSellSwap(s), ...pumpingBonded(s), ...bigSwap(s)]
  }
  const launch = await launchOf(ctx.sql, p.token)
  if (!launch) {
    missingLaunch(ev, p.token, ctx)
    return []
  }
  const trades = await tradesOf(ctx.sql, p.token, ev.id)
  if (p.type === "launchpad.bond") return [bonded(ev as Row<BondEvent>, launch, trades, ctx.prices)]
  const t = { ev: ev as Row<TradeEvent>, launch, trades, prices: ctx.prices }
  return [...devSell(t), ...bonding(t), ...pumping(t), ...big(t)]
}

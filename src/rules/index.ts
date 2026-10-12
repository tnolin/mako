import type { BondEvent, IndexerEvent, LaunchEvent, TradeEvent } from "@ink-indexer/events"
import { creatorStats, launchOf, type Row, tradesOf } from "../history"
import { big } from "./big"
import { bonded } from "./bonded"
import { bonding } from "./bonding"
import { devSell } from "./devsell"
import { newToken } from "./new-token"
import { pumping } from "./pumping"
import type { Candidate, RuleCtx } from "./types"

export { withDevHolds } from "./devsell"
export type { Candidate, RuleCtx } from "./types"

/** Candidate alerts for one confirmed event. Reads only indexer.events. */
export async function rulesFor(ev: Row<IndexerEvent>, ctx: RuleCtx): Promise<Candidate[]> {
  const p = ev.p
  if (p.type === "launchpad.launch") {
    const [trades, stats] = await Promise.all([
      tradesOf(ctx.sql, p.token),
      creatorStats(ctx.sql, p.creator, ev.id),
    ])
    return [newToken(ev as Row<LaunchEvent>, trades, stats, ctx.prices)]
  }
  if (p.type !== "launchpad.trade" && p.type !== "launchpad.bond") return []
  const launch = await launchOf(ctx.sql, p.token)
  if (!launch) {
    ctx.log("warn", "event without a launch event, skipped", {
      id: ev.id,
      token: p.token,
      type: p.type,
    })
    return []
  }
  const trades = await tradesOf(ctx.sql, p.token, ev.id)
  if (p.type === "launchpad.bond") return [bonded(ev as Row<BondEvent>, launch, trades, ctx.prices)]
  const t = { ev: ev as Row<TradeEvent>, launch, trades, prices: ctx.prices }
  return [...devSell(t), ...bonding(t), ...pumping(t), ...big(t)]
}

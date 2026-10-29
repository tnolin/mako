import type { LaunchEvent, SwapEvent, TradeEvent } from "@ink-indexer/events"
import { valueText } from "../cards/money"
import { age, bar, units, usd } from "../format"
import { type Row, swapsOf } from "../history"
import { PRIORITY } from "../settings"
import { makeCard } from "./card"
import { windowStats } from "./stats"
import type { Candidate, RuleCtx } from "./types"

/**
 * An event older than this is past MCAP TARGET's 30-minute queue window: its delivery would be dropped as late after
 * the target was cleared, so it doesn't fire. The next fresh trade past the target does.
 */
const FRESH_S = 1800
const HOUR_S = 3600

type TargetRow = { kind: "u" | "c"; id: string; usd: number; setUsd: number }

/**
 * MCAP TARGET: one candidate per watch whose target this trade or swap reached, bound to that user or chat. A target
 * set after the event's block never fires on it. `trades` are the token's curve trades up to the event (empty on
 * the swap path); the hour's swaps are read only when a target fires.
 */
export async function mcapTargets(
  ctx: RuleCtx,
  ev: Row<TradeEvent | SwapEvent>,
  launch: Row<LaunchEvent>,
  trades: Row<TradeEvent>[],
): Promise<Candidate[]> {
  const p = ev.p
  if (ctx.now() - p.blockTimestamp > FRESH_S) return []
  const price = ctx.prices.usd(p.quoteAsset)
  if (price === null) return []
  const mcapUsd = units(p.marketCap) * price
  const rows = await ctx.sql<TargetRow[]>`
    select 'u' as kind, user_id::text as id, target_usd::float8 as usd, target_set_usd::float8 as "setUsd"
    from bot.subscriptions
    where kind = 'watch' and target = ${p.token} and target_usd is not null
      and target_set_at <= to_timestamp(${p.blockTimestamp})
      and ((target_up and ${mcapUsd}::numeric >= target_usd) or (not target_up and ${mcapUsd}::numeric <= target_usd))
    union all
    select 'c', chat_id::text, target_usd::float8, target_set_usd::float8
    from bot.chat_token_watches
    where target = ${p.token} and target_usd is not null
      and target_set_at <= to_timestamp(${p.blockTimestamp})
      and ((target_up and ${mcapUsd}::numeric >= target_usd) or (not target_up and ${mcapUsd}::numeric <= target_usd))`
  if (rows.length === 0) return []
  const from = p.blockTimestamp - HOUR_S
  const swaps = await swapsOf(ctx.sql, p.token, ev.id, from)
  const vol = windowStats([...trades, ...swaps], from, ev.id).volume
  const l = launch.p
  return rows.map((r) => ({
    alert: "mcap",
    eventId: ev.id,
    target: p.token,
    dedupeKey: `mcap:${r.kind}${r.id}:${p.token}:${r.usd}`,
    priority: PRIORITY.mcap,
    eventTs: p.blockTimestamp,
    recipient: r.kind === "u" ? { user: r.id } : { chat: r.id },
    mcapTarget: { usd: r.usd, setUsd: r.setUsd },
    card: makeCard("mcap", "MCAP TARGET", l, [
      ["mcap", valueText(p.marketCap, p.quoteAsset, ctx.prices)],
      ...(p.type === "launchpad.trade" ? [["curve", bar(p.soldBps)] as [string, string]] : []),
      ["target", `${usd(r.usd)} (set at ${usd(r.setUsd)})`],
      ["volume", `${valueText(vol, p.quoteAsset, ctx.prices)} (1h)`],
      ["age", age(p.blockTimestamp - l.blockTimestamp)],
    ]),
  }))
}

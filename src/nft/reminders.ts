import type { NftDropStage } from "@ink-indexer/events"
import type postgres from "postgres"
import type { Sql } from "../db"
import { clean, count, inText, utcDate, utcTime } from "../format"
import type { Logger } from "../log"
import { NATIVE, type Prices } from "../prices"
import { PRIORITY } from "../settings"
import { ethText, makeNftAlertCard, type NftAlertCard } from "./card"
import { AUCTION_REMINDER_LEAD_S, isTeamStage, REMINDER_LEAD_S } from "./policy"
import { endingSoonCard } from "./rules/auction"
import { mintMarket } from "./rules/mint"
import type { CollectionState, NftState } from "./state"

/** A stage's reminder is queued from 14 to 16 minutes ahead; the dedupe key keeps it to one. */
const WINDOW_S = 60

export type RemindersDeps = {
  sql: Sql
  /** The poller's NFT state; undefined until it is loaded. */
  nft: () => NftState | undefined
  /** The ETH price for the dollar figures; without it an auction card shows ETH only. */
  prices?: Prices
  now?: () => number
}

const nowS = () => Math.floor(Date.now() / 1000)

function reminderCard(st: CollectionState, stage: NftDropStage, now: number): NftAlertCard {
  const rows: NftAlertCard["rows"] = [
    [
      "starts",
      `${utcTime(stage.startTime, utcDate(stage.startTime) !== utcDate(now))} (in ${inText(stage.startTime - now)})`,
    ],
    ["price", BigInt(stage.priceWei) === 0n ? "free" : ethText(BigInt(stage.priceWei), null)],
  ]
  if (stage.maxPerWallet !== null) rows.push(["limit", `${stage.maxPerWallet} per wallet`])
  // The latest minted count the state knows, from the newest mint event.
  const seen = [st.lastStage, st.lastMark, st.soldOut].filter((m) => m !== null)
  let latest = seen[0]
  for (const m of seen) if (latest && BigInt(m.minted) > BigInt(latest.minted)) latest = m
  if (latest) {
    const max = Number(latest.maxSupply)
    rows.push([
      "minted",
      max > 0
        ? `${count(Number(latest.minted))} / ${count(max)} (${Math.floor((Number(latest.minted) * 100) / max)}%)`
        : count(Number(latest.minted)),
    ])
  }
  const contract = st.drop!.contract
  // The same card as the other mint alerts, with the collection image and no links line.
  const card = makeNftAlertCard(
    "reminder",
    `MINT REMINDER · ${clean(stage.label, 12)}`,
    st.col,
    rows,
    { contract, ...mintMarket(st) },
  )
  return { ...card, links: [] }
}

/**
 * Queues one DM for every user who asked for reminders of the collection: users with a reminder, plus
 * watchers while their REMINDERS switch is on and the watch has reminders on, minus users who muted the
 * collection and users who blocked the bot. Groups get none. The dedupe key keeps it to one per user.
 */
async function queueDm(
  sql: Sql,
  contract: string,
  dedupeKey: string,
  card: NftAlertCard,
  now: number,
): Promise<void> {
  const payload = { type: "nftalert", card, image: true }
  await sql`
    insert into bot.deliveries (chat_id, chat_type, alert, token, dedupe_key, priority, event_ts, card)
    select u.platform_user_id, 'private', 'reminder', ${contract}, ${dedupeKey},
      ${PRIORITY.reminder}, to_timestamp(${now}), ${sql.json(payload as unknown as postgres.JSONValue)}
    from bot.users u
    where u.blocked_at is null
      and not exists (
        select 1 from bot.collection_mutes m where m.user_id = u.id and m.contract = ${contract})
      and (
        exists (select 1 from bot.reminders r where r.user_id = u.id and r.contract = ${contract})
        or (
          coalesce((u.settings #>> '{alerts,reminder,on}')::boolean, true)
          and exists (
            select 1 from bot.nft_watches w
            where w.user_id = u.id and w.contract = ${contract} and not w.reminders_off)))
    on conflict (chat_id, dedupe_key) do nothing`
}

/**
 * Queues a DM for every user who asked for reminders of a collection with a stage starting 14 to 16
 * minutes from now, and for every real collection whose auction ends in about an hour. Clock-driven and
 * read-only apart from the queue: it never calls OpenSea.
 */
export async function queueReminders(deps: RemindersDeps): Promise<void> {
  const nft = deps.nft()
  if (!nft) return
  const now = (deps.now ?? nowS)()
  const lead = REMINDER_LEAD_S
  for (const st of nft.upcoming(now, lead + WINDOW_S)) {
    const drop = st.drop!
    for (const stage of drop.stages) {
      const ahead = stage.startTime - now
      if (isTeamStage(stage) || ahead < lead - WINDOW_S || ahead > lead + WINDOW_S) continue
      await queueDm(
        deps.sql,
        drop.contract,
        `reminder:${drop.contract}:${stage.startTime}`,
        reminderCard(st, stage, now),
        now,
      )
    }
  }
  for (const st of nft.auctionsEnding(now, AUCTION_REMINDER_LEAD_S, WINDOW_S)) {
    const a = st.auction!
    const rate = deps.prices?.usd(NATIVE) ?? null
    await queueDm(
      deps.sql,
      a.contract,
      `auction:${a.auction}:ending`,
      endingSoonCard(st, a, now, rate),
      now,
    )
  }
}

/** Runs queueReminders every 30 seconds. Returns a stop function. */
export function startReminders(
  deps: RemindersDeps & { log: Logger; everyMs?: number },
): () => void {
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      await queueReminders(deps)
    } catch (err) {
      deps.log("warn", "reminder pass failed", { error: String(err) })
    } finally {
      running = false
    }
  }
  void tick()
  const timer = setInterval(tick, deps.everyMs ?? 30_000)
  return () => clearInterval(timer)
}

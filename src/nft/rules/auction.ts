import type { NftAuctionEvent } from "@ink-indexer/events"
import { count, inText, utcDate, utcTime } from "../../format"
import type { Row } from "../../history"
import { NATIVE } from "../../prices"
import type { Candidate, RuleCtx } from "../../rules/types"
import { type AlertKind, LONG_WINDOW, PRIORITY } from "../../settings"
import {
  ethNumber,
  ethText,
  makeNftAlertCard,
  type NftAlertCard,
  type NftAlertKind,
  stateName,
} from "../card"
import { auctionPrices } from "../history"
import { nftxSlugOf } from "../nftx"
import { AUCTION_UPCOMING_MIN_S, BID_RAISE_BPS, BID_RAISE_GAP_S } from "../policy"
import type { CollectionState } from "../state"

type Rows = NftAlertCard["rows"]
type Base = { eventId: string; contract: string }
type Opts = { links?: true; remind?: true }

const lateS = (kind: AlertKind) => ((LONG_WINDOW as readonly string[]).includes(kind) ? 1800 : 180)
const isLate = (kind: AlertKind, ts: number, now: number) => now - ts > lateS(kind)
const sameDay = (a: number, b: number) => utcDate(a) === utcDate(b)

/**
 * An auction card: labelled and linked as NFTX, no address lines. The name is the OpenSea name, else the
 * floor token's name from the collection's NFTX open. Only the cards that announce a start carry the
 * collection's links.
 */
function build(
  alert: NftAlertKind,
  title: string,
  st: CollectionState,
  a: NftAuctionEvent,
  rows: Rows,
  o: Opts = {},
): NftAlertCard {
  const base = makeNftAlertCard(alert, title, st.col, rows, {
    contract: a.contract,
    market: "nftx",
    nftxSlug: nftxSlugOf(st, a.nftxSlug),
    ...(o.remind ? { remind: true as const } : {}),
  })
  return {
    ...base,
    name: stateName(st, a.contract),
    links: o.links ? base.links : [],
  }
}

const eth = (wei: string, rate: number | null) => ethText(BigInt(wei), rate)

/** UPCOMING AUCTION: when it starts and ends, how much it sells and the starting minimum bid. */
export function upcomingAuctionCard(
  st: CollectionState,
  a: NftAuctionEvent,
  at: number,
  rate: number | null,
): NftAlertCard {
  return build(
    "upcoming",
    "UPCOMING AUCTION",
    st,
    a,
    [
      ["starts", `${utcTime(a.startsAt, true)} (in ${inText(a.startsAt - at)})`],
      ["ends", utcTime(a.endsAt, !sameDay(a.endsAt, a.startsAt))],
      ["supply", `${count(Number(a.supply))} NFTs`],
      ["min bid", eth(a.minBidWei, rate)],
    ],
    { links: true },
  )
}

/** AUCTION LIVE: the minimum bid now, when it ends and how much it sells. */
export function liveAuctionCard(
  st: CollectionState,
  a: NftAuctionEvent,
  at: number,
  rate: number | null,
): NftAlertCard {
  return build(
    "mintstart",
    "AUCTION LIVE",
    st,
    a,
    [
      ["min bid", eth(a.clearingPriceWei, rate)],
      ["ends", `${utcTime(a.endsAt, !sameDay(a.endsAt, at))} (in ${inText(a.endsAt - at)})`],
      ["supply", `${count(Number(a.supply))} NFTs`],
    ],
    { links: true, remind: true },
  )
}

/** MINIMUM BID RAISED: `(+N%)` is the rise over the auction's starting minimum bid, rounded down. */
export function bidRaisedCard(
  st: CollectionState,
  a: NftAuctionEvent,
  at: number,
  rate: number | null,
): NftAlertCard {
  const start = BigInt(a.minBidWei)
  const rise = start > 0n ? ` (+${((BigInt(a.clearingPriceWei) - start) * 100n) / start}%)` : ""
  return build("minted", "MINIMUM BID RAISED", st, a, [
    ["min bid", `${eth(a.clearingPriceWei, rate)}${rise}`],
    ["bidders", count(a.bidders)],
    ["raised", eth(a.raisedWei, rate)],
    ["ends", `in ${inText(a.endsAt - at)}`],
  ])
}

/** AUCTION ENDING SOON: sent an hour before the end, from the latest figures the state holds. */
export function endingSoonCard(
  st: CollectionState,
  a: NftAuctionEvent,
  at: number,
  rate: number | null,
): NftAlertCard {
  return build("reminder", "AUCTION ENDING SOON", st, a, [
    ["ends", `${utcTime(a.endsAt)} (in ${inText(a.endsAt - at)})`],
    ["min bid", eth(a.clearingPriceWei, rate)],
    ["bidders", count(a.bidders)],
    ["raised", eth(a.raisedWei, rate)],
  ])
}

/** AUCTION ENDED: the result of a graduated auction, or a refund when the minimum raise was not met. */
export function endedCard(
  st: CollectionState,
  a: NftAuctionEvent,
  _at: number,
  rate: number | null,
): NftAlertCard {
  if (a.graduated === false) {
    return build("soldout", "AUCTION ENDED", st, a, [
      ["result", "minimum not raised, bids refunded"],
      [
        "raised",
        `${ethNumber(BigInt(a.raisedWei))} / ${ethNumber(BigInt(a.requiredRaiseWei))} ETH`,
      ],
      ["bidders", count(a.bidders)],
    ])
  }
  const sold = BigInt(a.cleared ?? "0")
  const supply = BigInt(a.supply)
  const share = supply > 0n ? ` (${(sold * 100n) / supply}%)` : ""
  return build("soldout", "AUCTION ENDED", st, a, [
    ["price", `${eth(a.clearingPriceWei, rate)} per NFT`],
    ["sold", `${count(Number(sold))} / ${count(Number(supply))}${share}`],
    ["raised", eth(a.raisedWei, rate)],
    ["bidders", count(a.bidders)],
    ["claims", `from ${utcTime(a.claimsAt)}`],
  ])
}

function cand(
  b: Base,
  alert: NftAlertKind,
  dedupeKey: string,
  card: NftAlertCard,
  eventTs: number,
  extra: Partial<Candidate> = {},
): Candidate {
  return {
    alert,
    eventId: b.eventId,
    target: b.contract,
    dedupeKey,
    priority: PRIORITY[alert],
    eventTs,
    card,
    feedEligible: true,
    ...extra,
  }
}

const upcomingKey = (a: NftAuctionEvent) => `auction:${a.auction}:upcoming`
const liveKey = (a: NftAuctionEvent) => `auction:${a.auction}:live`

/**
 * Walks an auction's `price` events oldest first and says whether the last one raises the minimum bid enough
 * to alert. An event fires when its clearing price is at least `BID_RAISE_BPS` above the base and
 * `BID_RAISE_GAP_S` has passed since the last event that fired; a fired event becomes the base. The base
 * starts at the auction's starting minimum bid.
 *
 * shortcut: the walk does not know which fires were delivered, so a fire that sent nothing (late, or no
 * recipient) still starts the gap and becomes the base, and every `price` event reads the auction's earlier
 * ones again. An auction has a handful of checkpoints, so the re-read is cheap; keep the last fire on the
 * auction state if one ever has enough for it to matter.
 */
export function bidRaiseWalk(
  prices: { wei: bigint; ts: number }[],
  startWei: bigint,
): { fires: boolean; baseWei: bigint; lastFireTs: number | null } {
  let baseWei = startWei
  let lastFireTs: number | null = null
  let fires = false
  for (const { wei, ts } of prices) {
    fires =
      wei > baseWei &&
      wei * 10_000n >= baseWei * BigInt(10_000 + BID_RAISE_BPS) &&
      (lastFireTs === null || ts - lastFireTs >= BID_RAISE_GAP_S)
    if (fires) {
      baseWei = wei
      lastFireTs = ts
    }
  }
  return { fires, baseWei, lastFireTs }
}

const sameEvent = (a: NftAuctionEvent, b: NftAuctionEvent) =>
  a.auction === b.auction &&
  a.phase === b.phase &&
  a.blockNumber === b.blockNumber &&
  a.logIndex === b.logIndex

/**
 * Candidates for one `nft.auction` event. The state already holds the event, so an event it dropped (an
 * auction in a currency other than ETH) gives nothing. Every phase needs verdict `real`, watched or not.
 */
export async function auctionRules(ev: Row<NftAuctionEvent>, ctx: RuleCtx): Promise<Candidate[]> {
  const p = ev.p
  const st = ctx.nft.get(p.contract)
  if (!st?.auction || !sameEvent(st.auction, p) || st.col?.verdict !== "real") return []
  const now = ctx.now()
  const rate = ctx.prices.usd(NATIVE)
  const b: Base = { eventId: ev.id, contract: p.contract }
  switch (p.phase) {
    case "created":
      if (p.startsAt - now >= AUCTION_UPCOMING_MIN_S) {
        if (isLate("upcoming", p.blockTimestamp, now)) return []
        return [
          cand(
            b,
            "upcoming",
            upcomingKey(p),
            upcomingAuctionCard(st, p, now, rate),
            p.blockTimestamp,
          ),
        ]
      }
      // Seen after the start (a late keep, or an indexer behind the chain): the same card and key the
      // `live` phase uses, stamped now, so it goes out once.
      if (p.startsAt <= now && now < p.endsAt)
        return [cand(b, "mintstart", liveKey(p), liveAuctionCard(st, p, now, rate), now)]
      return []
    case "live":
      if (isLate("mintstart", p.blockTimestamp, now)) return []
      return [
        cand(
          b,
          "mintstart",
          liveKey(p),
          liveAuctionCard(st, p, p.blockTimestamp, rate),
          p.blockTimestamp,
        ),
      ]
    case "price": {
      if (isLate("minted", p.blockTimestamp, now)) return []
      const earlier = await auctionPrices(ctx.sql, p.contract, p.auction, ev.id)
      const walk = earlier.map((r) => ({
        wei: BigInt(r.p.clearingPriceWei),
        ts: r.p.blockTimestamp,
      }))
      if (!earlier.some((r) => r.id === ev.id))
        walk.push({ wei: BigInt(p.clearingPriceWei), ts: p.blockTimestamp })
      if (!bidRaiseWalk(walk, BigInt(p.minBidWei)).fires) return []
      return [
        cand(
          b,
          "minted",
          `auction:${p.auction}:raise:${p.blockNumber}`,
          bidRaisedCard(st, p, p.blockTimestamp, rate),
          p.blockTimestamp,
          // Watchers only, whatever mint percentages they chose.
          { feedEligible: false, bidRaise: true },
        ),
      ]
    }
    case "ended":
      if (isLate("soldout", p.blockTimestamp, now)) return []
      return [
        cand(
          b,
          "soldout",
          `auction:${p.auction}:ended`,
          endedCard(st, p, p.blockTimestamp, rate),
          p.blockTimestamp,
        ),
      ]
  }
}

/**
 * The auction's current card for a collection that just turned `real`: UPCOMING AUCTION when the start is
 * at least `AUCTION_UPCOMING_MIN_S` ahead, else AUCTION LIVE while it runs. Null once it ended or when
 * neither applies. It uses the cards' own keys and is delivered beside the chat's other alert for the
 * snapshot.
 */
export function auctionCatchUp(
  b: Base,
  st: CollectionState,
  now: number,
  rate: number | null,
): Candidate | null {
  const a = st.auction
  if (!a || a.phase === "ended" || now >= a.endsAt) return null
  if (a.startsAt - now >= AUCTION_UPCOMING_MIN_S)
    return cand(b, "upcoming", upcomingKey(a), upcomingAuctionCard(st, a, now, rate), now, {
      separate: true,
    })
  if (a.phase === "live" || a.phase === "price")
    return cand(b, "mintstart", liveKey(a), liveAuctionCard(st, a, now, rate), now, {
      separate: true,
    })
  return null
}

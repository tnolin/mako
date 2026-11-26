import type { NftListingEvent, NftSaleEvent, NftStatsEvent } from "@ink-indexer/events"
import { age, clean, count, inText, rankText } from "../../format"
import type { Row } from "../../history"
import { NATIVE } from "../../prices"
import type { Candidate, RuleCtx } from "../../rules/types"
import { type AlertKind, LONG_WINDOW, PRIORITY } from "../../settings"
import {
  ethText,
  makeNftAlertCard,
  multiple,
  type NftAlertCard,
  type NftAlertKind,
  shortAddr,
  walletText,
} from "../card"
import { salesByBuyer } from "../history"
import { NFTX_LOCKER, nftxSlugOf } from "../nftx"
import {
  BIGSALE_MIN_FLOOR_MULTIPLE,
  FLOOR_MAX_AGE_S,
  MIN_BIGSALE_WEI,
  RARE_PRICE_DEN,
  RARE_PRICE_NUM,
  SWEEP_WINDOW_S,
} from "../policy"
import type { CollectionState } from "../state"

type Rows = NftAlertCard["rows"]

/** The card options that label a card NFTX and point it at NFTX; none for OpenSea. */
const nftxOpts = (
  st: CollectionState | undefined,
  market: "opensea" | "nftx" | null | undefined,
  slug: string | null | undefined,
): { market?: "nftx"; nftxSlug?: string | null } =>
  market === "nftx" ? { market: "nftx", nftxSlug: nftxSlugOf(st, slug) } : {}

const VIA = { listing: "NFTX listing", instant_sell: "instant sell", instant_buy: "instant buy" }
const viaRow = (via: NftSaleEvent["via"]): Rows => (via ? [["via", VIA[via]]] : [])

const lateS = (kind: AlertKind) => ((LONG_WINDOW as readonly string[]).includes(kind) ? 1800 : 180)
const isLate = (kind: AlertKind, ts: number, now: number) => now - ts > lateS(kind)
const feedOk = (st: CollectionState | undefined) => st?.col?.verdict === "real"
/** Rounded, so a 23.8% discount reads 24%. */
const pct = (bps: number) => Math.round(bps / 100)

/** `(+5%)` or `(−12%)`: the price against the floor, to the nearest percent. */
function premium(price: bigint, floor: bigint): string {
  const bps = Number(((price - floor) * 10000n) / floor)
  const p = Math.round(Math.abs(bps) / 100)
  return `(${bps < 0 ? "−" : "+"}${p}%)`
}

function cand(
  ev: Row<{ contract: string }>,
  alert: NftAlertKind,
  dedupeKey: string,
  card: NftAlertCard,
  eventTs: number,
  st: CollectionState | undefined,
  extra: Partial<Candidate> = {},
): Candidate {
  return {
    alert,
    eventId: ev.id,
    target: ev.p.contract,
    dedupeKey,
    priority: PRIORITY[alert],
    eventTs,
    card,
    feedEligible: feedOk(st),
    ...extra,
  }
}

const itemName = (
  st: CollectionState | undefined,
  name: string | null,
  contract: string,
  tokenId: string,
) => clean(name, 64) || `${clean(st?.col?.name, 64) || shortAddr(contract)} #${tokenId}`
const rankRow = (rank: number | null, max: number | null) =>
  rank !== null && max !== null ? rankText(rank, max) : null

/** ` · 1.08x`: an NFTX listing's price as a multiple of the pool floor, which its ETH price follows. */
const multipleText = (p: NftListingEvent): string =>
  p.market === "nftx" && p.floorMultiple != null ? ` · ${(p.floorMultiple / 100).toFixed(2)}x` : ""

function listing(ev: Row<NftListingEvent>, ctx: RuleCtx, rate: number | null): Candidate[] {
  const p = ev.p
  const st = ctx.nft.get(p.contract)
  if (isLate("under", p.blockTimestamp, ctx.now())) return []
  if (p.floorWei === null || p.floorAt === null || p.blockTimestamp - p.floorAt > FLOOR_MAX_AGE_S)
    return []
  const price = BigInt(p.priceWei)
  const floor = BigInt(p.floorWei)
  if (floor <= 0n) return []
  const key = `list:${p.contract}:${p.tokenId}:${p.priceWei}`
  const opts = {
    contract: p.contract,
    tokenId: p.tokenId,
    imageUrl: p.imageUrl,
    ...nftxOpts(st, p.market, p.nftxSlug),
  }
  const item = itemName(st, p.itemName, p.contract, p.tokenId)
  const rank = rankRow(p.rank, p.maxRank)
  const left = inText(p.expiresAt - ctx.now())
  const expires: [string, string] = [
    "expires",
    p.listingType === "dutch" ? `auction ends in ${left}` : `in ${left}`,
  ]
  const out: Candidate[] = []

  const discountBps = Number(((floor - price) * 10000n) / floor)
  if (discountBps >= 1000) {
    const rows: Rows = [
      ["item", item],
      ["price", ethText(price, rate)],
      ["floor", ethText(floor, null)],
    ]
    if (rank) rows.push(["rank", rank])
    rows.push(expires)
    const card = makeNftAlertCard(
      "under",
      `UNDER FLOOR ${pct(discountBps)}%`,
      st?.col ?? null,
      rows,
      opts,
    )
    out.push(cand(ev, "under", key, card, p.blockTimestamp, st, { discountBps }))
  }

  if (
    p.rank !== null &&
    p.maxRank !== null &&
    p.maxRank > 0 &&
    price * RARE_PRICE_DEN <= floor * RARE_PRICE_NUM
  ) {
    const rankBps = Math.ceil((p.rank * 10000) / p.maxRank)
    if (rankBps <= 1000) {
      const rows: Rows = [
        ["item", item],
        ["rank", rank ?? ""],
        ["price", `${ethText(price, rate)}${multipleText(p)}`],
        ["floor", `${ethText(floor, null)} ${premium(price, floor)}`],
        expires,
      ]
      const card = makeNftAlertCard("rare", "RARE LISTING", st?.col ?? null, rows, opts)
      // The same key as UNDER FLOOR: one alert per listing, and RARE wins where a chat accepts both.
      out.push(cand(ev, "rare", key, card, p.blockTimestamp, st, { rankBps }))
    }
  }
  return out
}

function floorMove(ev: Row<NftStatsEvent>, ctx: RuleCtx, rate: number | null): Candidate[] {
  const p = ev.p
  if (isLate("floor", p.blockTimestamp, ctx.now())) return []
  if (p.floorWei === null || p.floor24hAgoWei === null) return []
  const floor = BigInt(p.floorWei)
  const ago = BigInt(p.floor24hAgoWei)
  if (ago <= 0n) return []
  const change = Number(((floor - ago) * 10000n) / ago)
  const floorBps = Math.abs(change)
  if (floorBps < 1000) return []
  const dir = change > 0 ? "up" : "down"
  const st = ctx.nft.get(p.contract)
  // An NFTX pool move before OpenSea has stats for the collection carries no volume, sales or holders.
  const rows: Rows = [
    ["floor", ethText(floor, rate)],
    ["24h ago", ethText(ago, null)],
  ]
  if (p.volume24hWei != null)
    rows.push(["volume", `${ethText(BigInt(p.volume24hWei), rate)} (24h)`])
  if (p.sales24h != null) rows.push(["sales", `${count(p.sales24h)} (24h)`])
  if (p.owners != null) rows.push(["holders", count(p.owners)])
  const card = makeNftAlertCard(
    "floor",
    `FLOOR ${dir.toUpperCase()} ${pct(floorBps)}%`,
    st?.col ?? null,
    rows,
    {
      contract: p.contract,
      ...nftxOpts(st, p.floorMarket, p.nftxSlug),
    },
  )
  const bucket = Math.floor(p.blockTimestamp / 21600)
  return [
    cand(ev, "floor", `floor:${p.contract}:${dir}:${bucket}`, card, p.blockTimestamp, st, {
      floorDir: dir,
      floorBps,
    }),
  ]
}

async function sale(
  ev: Row<NftSaleEvent>,
  ctx: RuleCtx,
  rate: number | null,
): Promise<Candidate[]> {
  const p = ev.p
  const st = ctx.nft.get(p.contract)
  const col = st?.col ?? null
  const price = BigInt(p.priceWei)
  const out: Candidate[] = []
  const opts = {
    contract: p.contract,
    tokenId: p.tokenId,
    imageUrl: p.imageUrl,
    ...nftxOpts(st, p.market, p.nftxSlug),
  }
  const item = itemName(st, p.itemName, p.contract, p.tokenId)
  const floor = p.floorWei !== null && BigInt(p.floorWei) > 0n ? BigInt(p.floorWei) : null
  const rank = rankRow(p.rank, p.maxRank)
  const key = `${p.txHash}:${p.logIndex}:${p.tokenId}`

  if (!isLate("sale", p.blockTimestamp, ctx.now())) {
    const rows: Rows = [
      ["item", item],
      ["price", ethText(price, rate)],
    ]
    if (floor) rows.push(["floor", `${ethText(floor, null)} ${premium(price, floor)}`])
    if (rank) rows.push(["rank", rank])
    rows.push(...viaRow(p.via), ["buyer", walletText(p.buyer)], ["seller", walletText(p.seller)])
    const card = makeNftAlertCard("sale", "SOLD", col, rows, opts)
    out.push(cand(ev, "sale", `sale:${key}`, card, p.blockTimestamp, st, { salePriceWei: price }))

    if (
      price >= BigInt(MIN_BIGSALE_WEI) &&
      (!floor || price >= floor * BIGSALE_MIN_FLOOR_MULTIPLE)
    ) {
      const big: Rows = [
        ["item", item],
        ["price", ethText(price, rate)],
      ]
      if (floor) big.push(["floor", `${ethText(floor, null)} (${multiple(price, floor)})`])
      if (rank) big.push(["rank", rank])
      big.push(...viaRow(p.via), ["buyer", walletText(p.buyer)])
      const bigCard = makeNftAlertCard("bigsale", "BIG SALE", col, big, opts)
      out.push(
        cand(ev, "bigsale", `bigsale:${key}`, bigCard, p.blockTimestamp, st, {
          salePriceWei: price,
        }),
      )
    }
  }

  // SWEEP: this buyer's items in this collection in the 10 minutes ending at this sale. The pool buying
  // items, or an arbitrage contract routing them into it, is not a collector sweeping.
  const toPool = p.toPool === true || p.buyer.toLowerCase() === NFTX_LOCKER
  if (!toPool && !isLate("sweep", p.blockTimestamp, ctx.now())) {
    const mine = await salesByBuyer(
      ctx.sql,
      p.contract,
      p.buyer,
      p.blockTimestamp - SWEEP_WINDOW_S,
      ev.id,
    )
    if (mine.length >= 5) {
      const first = mine[0]!.p.blockTimestamp
      const total = mine.reduce((s, r) => s + BigInt(r.p.priceWei), 0n)
      const latestFloor = p.floorWei ?? st?.stats?.floorWei ?? null
      const rows: Rows = [
        ["buyer", walletText(p.buyer)],
        ["bought", `${mine.length} items in ${age(p.blockTimestamp - first)}`],
        ["spent", `${ethText(total, rate)} · avg ${ethText(total / BigInt(mine.length), null)}`],
      ]
      if (latestFloor) rows.push(["floor", ethText(BigInt(latestFloor), null)])
      // The header and links read NFTX only when every counted sale was on NFTX.
      const onNftx = mine.every((r) => r.p.market === "nftx")
      const card = makeNftAlertCard("sweep", "SWEEP", col, rows, {
        contract: p.contract,
        ...(onNftx ? nftxOpts(st, "nftx", p.nftxSlug) : {}),
      })
      out.push(
        cand(
          ev,
          "sweep",
          `sweep:${p.contract}:${p.buyer}:${Math.floor(first / 3600)}`,
          card,
          p.blockTimestamp,
          st,
          {
            sweepItems: mine.length,
          },
        ),
      )
    }
  }
  return out
}

/** Candidates for a listing, sale or stats event. UNDER FLOOR, RARE, FLOOR, SWEEP, BIG SALE and SOLD reach watchers only (routing). */
export async function marketRules(
  ev: Row<NftListingEvent | NftSaleEvent | NftStatsEvent>,
  ctx: RuleCtx,
): Promise<Candidate[]> {
  const rate = ctx.prices.usd(NATIVE)
  const p = ev.p
  if (p.type === "nft.listing") return listing(ev as Row<NftListingEvent>, ctx, rate)
  if (p.type === "nft.stats") return floorMove(ev as Row<NftStatsEvent>, ctx, rate)
  return sale(ev as Row<NftSaleEvent>, ctx, rate)
}

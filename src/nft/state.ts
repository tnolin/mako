import type {
  NftAuctionEvent,
  NftCollectionEvent,
  NftDropEvent,
  NftEvent,
  NftLaunchEvent,
  NftMintEvent,
  NftStatsEvent,
} from "@ink-indexer/events"
import type { Sql } from "../db"
import type { Row } from "../history"
import { findAddress } from "../platforms/telegram/ui"
import { normalise, parseOpenSeaLink } from "./match"
import { AUCTION_REMINDER_MIN_S, isTeamStage } from "./policy"

/** What the rules and screens know about one collection: the latest event of each kind. */
export type CollectionState = {
  col: NftCollectionEvent | null
  drop: NftDropEvent | null
  /** The latest `stage_start`. */
  lastStage: NftMintEvent | null
  /** The latest `progress`. */
  lastMark: NftMintEvent | null
  soldOut: NftMintEvent | null
  stats: NftStatsEvent | null
  /** The latest Chimera launch. */
  launch: NftLaunchEvent | null
  /** The latest open on NFTX, kept apart from a Chimera launch of the same collection. */
  nftxLaunch: NftLaunchEvent | null
  /** The latest phase of the collection's ETH auction. */
  auction: NftAuctionEvent | null
}

/** 1 exact slug, 2 exact name, 3 name prefix, 4 name or slug contains. */
export type Tier = 1 | 2 | 3 | 4

export type NftState = {
  get(contract: string): CollectionState | undefined
  /** Applies one event in id order; returns the previous snapshot for an nft.collection or nft.drop event, else null. */
  apply(ev: Row<NftEvent>): NftCollectionEvent | NftDropEvent | null
  /** Matches best first: tier, then `real`, then owners, then 24 h sales. An address or link gives one exact match. */
  matches(q: string): { tier: Tier; state: CollectionState }[]
  search(q: string, limit?: number): CollectionState[]
  /** Collections with a mint running: a stage or mark was seen and it has not sold out. */
  live(): CollectionState[]
  /** Collections not sold out with a non-Team stage starting within `withinS` after `nowS`, soonest first. */
  upcoming(nowS: number, withinS: number): CollectionState[]
  /**
   * Real collections whose auction has not ended, runs at least `AUCTION_REMINDER_MIN_S` and ends `aheadS` from
   * `nowS`, give or take `windowS`.
   */
  auctionsEnding(nowS: number, aheadS: number, windowS: number): CollectionState[]
}

const empty = (): CollectionState => ({
  col: null,
  drop: null,
  lastStage: null,
  lastMark: null,
  soldOut: null,
  stats: null,
  launch: null,
  nftxLaunch: null,
  auction: null,
})

const verdictRank = (s: CollectionState) => (s.col?.verdict === "real" ? 0 : 1)
const owners = (s: CollectionState) => s.stats?.owners ?? 0
const sales = (s: CollectionState) => s.stats?.sales24h ?? 0

/**
 * Whether the collection's auction can still send AUCTION ENDING SOON: the collection is real, the auction
 * has not ended and it lasts long enough.
 */
export const remindsAuction = (s: CollectionState): boolean => {
  const a = s.auction
  return (
    !!a &&
    a.phase !== "ended" &&
    s.col?.verdict === "real" &&
    a.endsAt - a.startsAt >= AUCTION_REMINDER_MIN_S
  )
}

export function createNftState(initial: Map<string, CollectionState> = new Map()): NftState {
  const byContract = initial
  const entry = (c: string) => {
    const have = byContract.get(c)
    if (have) return have
    const fresh = empty()
    byContract.set(c, fresh)
    return fresh
  }
  const compare = (a: CollectionState, b: CollectionState) =>
    verdictRank(a) - verdictRank(b) || owners(b) - owners(a) || sales(b) - sales(a)

  function matches(q: string): { tier: Tier; state: CollectionState }[] {
    const link = parseOpenSeaLink(q)
    const addr = findAddress(q)
    const contract = link && "contract" in link ? link.contract : (addr ?? null)
    if (contract) {
      const s = byContract.get(contract)
      return s ? [{ tier: 1, state: s }] : []
    }
    const slug = link && "slug" in link ? link.slug : q.trim().toLowerCase()
    const needle = normalise(q)
    const out: { tier: Tier; state: CollectionState }[] = []
    for (const state of byContract.values()) {
      const col = state.col
      // A filtered collection is a copycat: only its address or an OpenSea item link opens it.
      if (!col || col.verdict === "filtered") continue
      const name = normalise(col.name ?? "")
      const s = (col.slug ?? "").toLowerCase()
      const tier: Tier | null =
        s !== "" && s === slug
          ? 1
          : needle !== "" && name === needle
            ? 2
            : needle !== "" && name.startsWith(needle)
              ? 3
              : needle !== "" && (name.includes(needle) || normalise(s).includes(needle))
                ? 4
                : null
      if (tier) out.push({ tier, state })
    }
    return out.sort((a, b) => a.tier - b.tier || compare(a.state, b.state))
  }

  return {
    get: (c) => byContract.get(c),
    apply({ p }) {
      if (p.type === "nft.listing" || p.type === "nft.sale") return null
      // Amounts of another currency cannot be rendered, and nothing downstream may see such an auction.
      if (p.type === "nft.auction" && p.currency !== "ETH") return null
      const s = entry(p.contract)
      switch (p.type) {
        case "nft.collection": {
          const prev = s.col
          s.col = p
          return prev
        }
        case "nft.drop": {
          const prev = s.drop
          s.drop = p
          return prev
        }
        case "nft.stats":
          s.stats = p
          break
        case "nft.launch":
          if (p.launchpad === "nftx") s.nftxLaunch = p
          else s.launch = p
          break
        case "nft.auction":
          s.auction = p
          break
        case "nft.mint":
          if (p.kind === "stage_start") s.lastStage = p
          else if (p.kind === "progress") s.lastMark = p
          else s.soldOut = p
          break
      }
      return null
    },
    matches,
    search: (q, limit) =>
      matches(q)
        .slice(0, limit)
        .map((m) => m.state),
    live: () => [...byContract.values()].filter((s) => (s.lastStage || s.lastMark) && !s.soldOut),
    upcoming(nowS, withinS) {
      const next = (s: CollectionState) =>
        Math.min(
          ...(s.drop?.stages ?? [])
            .filter(
              (st) => !isTeamStage(st) && st.startTime > nowS && st.startTime <= nowS + withinS,
            )
            .map((st) => st.startTime),
        )
      return [...byContract.values()]
        .filter((s) => !s.soldOut && Number.isFinite(next(s)))
        .sort((a, b) => next(a) - next(b))
    },
    auctionsEnding: (nowS, aheadS, windowS) =>
      [...byContract.values()].filter(
        (s) => remindsAuction(s) && Math.abs(s.auction!.endsAt - nowS - aheadS) <= windowS,
      ),
  }
}

/**
 * Rebuilds the state from the events up to and including `uptoId` (the poller's cursor), so a snapshot
 * newer than the cursor is applied later, in order, and its change is still seen once.
 */
export async function loadNftState(sql: Sql, uptoId: string): Promise<NftState> {
  const states = new Map<string, CollectionState>()
  const ents = await sql<{ entity: string }[]>`
    select entity from indexer.events
    where type in ('nft.collection', 'nft.launch', 'nft.drop', 'nft.mint', 'nft.auction') and id <= ${uptoId}
    group by entity`
  const contracts = ents.map((e) => e.entity)
  if (contracts.length === 0) return createNftState(states)
  // One lookup per collection and kind through events_type_entity_id: the newest row with id <= uptoId.
  const latest = <T extends NftEvent>(type: string, filter?: [field: string, value: string]) =>
    sql<{ p: T }[]>`
      select l.payload as p
      from unnest(${contracts}::text[]) as c(entity)
      cross join lateral (
        select payload from indexer.events
        where type = ${type} and entity = c.entity and id <= ${uptoId}
          ${filter === undefined ? sql`` : sql`and payload->>${filter[0]} = ${filter[1]}`}
        order by id desc limit 1
      ) l`
  const [cols, drops, stages, marks, outs, stats, launches, opens, auctions] = await Promise.all([
    latest<NftCollectionEvent>("nft.collection"),
    latest<NftDropEvent>("nft.drop"),
    latest<NftMintEvent>("nft.mint", ["kind", "stage_start"]),
    latest<NftMintEvent>("nft.mint", ["kind", "progress"]),
    latest<NftMintEvent>("nft.mint", ["kind", "sold_out"]),
    latest<NftStatsEvent>("nft.stats"),
    latest<NftLaunchEvent>("nft.launch", ["launchpad", "chimera"]),
    latest<NftLaunchEvent>("nft.launch", ["launchpad", "nftx"]),
    latest<NftAuctionEvent>("nft.auction", ["currency", "ETH"]),
  ])
  const state = createNftState(states)
  const put = (rows: { p: NftEvent }[]) => {
    for (const { p } of rows) state.apply({ id: "0", p })
  }
  for (const rows of [cols, drops, stages, marks, outs, stats, launches, opens, auctions]) put(rows)
  return state
}

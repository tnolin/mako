import type { BondEvent, LaunchEvent, SwapEvent, TradeEvent } from "@ink-indexer/events"
import type { Card } from "../cards/card"
import type { Sql } from "../db"
import type { Row } from "../history"
import type { Logger } from "../log"
import type { NftAlertCard } from "../nft/card"
import type { NftMark } from "../nft/policy"
import type { NftState } from "../nft/state"
import type { Prices } from "../prices"
import type { HoldsReq } from "../rpc"
import type { AlertKind, Mark } from "../settings"

export type Candidate = {
  alert: AlertKind
  eventId: string
  /** A token address, or a collection contract. */
  target: string
  /** Unique per chat in bot.deliveries. */
  dedupeKey: string
  priority: number
  /** Event blockTimestamp, unix seconds. Late drop is measured from it. */
  eventTs: number
  card: Card | NftAlertCard
  /** BONDING: the crossed mark. */
  mark?: Mark
  /** BIG: trade size over target, in basis points. */
  sizeBps?: number
  /** DEV SELL: the balance read the poller resolves outside any transaction. */
  holds?: HoldsReq
  /** BONDED: marks that chat's pending BONDING rows for the token superseded. */
  supersedesBonding?: boolean
  /** NFT: the collection passes the quality checks, so the All collections feed may carry it. */
  feedEligible?: boolean
  /** MINT UPDATED: sent under the REMINDERS switch, to watchers only. */
  mintUpdate?: boolean
  /** MINTED: the crossed mark. */
  markBps?: NftMark
  /** UNDER FLOOR: the discount to the floor, in basis points. */
  discountBps?: number
  /** RARE LISTING: the item's rank as a share of the collection, in basis points (rounded up). */
  rankBps?: number
  /** SWEEP: how many items the buyer took in the window. */
  sweepItems?: number
  /** SOLD and BIG SALE: the sale price in wei. */
  salePriceWei?: bigint
  /** FLOOR UP / DOWN. */
  floorDir?: "up" | "down"
  /** FLOOR UP / DOWN: the absolute move in basis points. */
  floorBps?: number
  /**
   * PUMPING after bonding: the market cap gain over the 10-minute low. Every pool swap carries one, so the re-arm
   * state sees each gain; an `observeOnly` candidate is below every threshold and is never sent.
   */
  pump?: { token: string; gainBps: number; observeOnly?: true }
  /** PUMPING after bonding: the market cap in USD, or null without a current price. */
  mcapUsd?: number | null
}

export type RuleCtx = {
  sql: Sql
  prices: Prices
  log: Logger
  /** The in-memory NFT collection state, already holding the event being processed. */
  nft: NftState
  /** Unix seconds. */
  now: () => number
  /** Unix seconds: NFT events before this time never alert (the backfill cutoff). */
  nftSince?: number
}

export type TradeCtx = {
  ev: Row<TradeEvent>
  launch: Row<LaunchEvent>
  /** The token's trades up to and including `ev`, in id order. */
  trades: Row<TradeEvent>[]
  prices: Prices
}

export type SwapCtx = {
  ev: Row<SwapEvent>
  launch: Row<LaunchEvent>
  bond: Row<BondEvent> | null
  /** The token's swaps in the 600 s up to and including `ev`, in id order. */
  swaps: Row<SwapEvent>[]
  /** The creator's curve trades and pool swaps up to `ev`; loaded only when the creator made this swap. */
  dev: { trades: Row<TradeEvent>[]; swaps: Row<SwapEvent>[] } | null
  prices: Prices
}

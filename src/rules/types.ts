import type { LaunchEvent, TradeEvent } from "@ink-indexer/events"
import type { Card } from "../cards/card"
import type { Sql } from "../db"
import type { Row } from "../history"
import type { Logger } from "../log"
import type { Prices } from "../prices"
import type { HoldsReq } from "../rpc"
import type { AlertKind, Mark } from "../settings"

export type Candidate = {
  alert: AlertKind
  eventId: string
  token: string
  /** Unique per chat in bot.deliveries. */
  dedupeKey: string
  priority: number
  /** Event blockTimestamp, unix seconds. Late drop is measured from it. */
  eventTs: number
  card: Card
  /** BONDING: the crossed mark. */
  mark?: Mark
  /** BIG: trade size over target, in basis points. */
  sizeBps?: number
  /** DEV SELL: the balance read the poller resolves outside any transaction. */
  holds?: HoldsReq
  /** BONDED: marks that chat's pending BONDING rows for the token superseded. */
  supersedesBonding?: boolean
}

export type RuleCtx = { sql: Sql; prices: Prices; log: Logger }

export type TradeCtx = {
  ev: Row<TradeEvent>
  launch: Row<LaunchEvent>
  /** The token's trades up to and including `ev`, in id order. */
  trades: Row<TradeEvent>[]
  prices: Prices
}

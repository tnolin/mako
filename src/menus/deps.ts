import type { Sql } from "../db"
import type { Logger } from "../log"
import type { Prices } from "../prices"

export type BotDeps = {
  sql: Sql
  prices: Prices
  log: Logger
  report: (err: unknown) => void
  /** Public base URL of the Trade redirect. */
  linksBase: string
  /** Wait between checks for the bot's channel admin rights (tests use 1). */
  channelRetryMs?: number
}

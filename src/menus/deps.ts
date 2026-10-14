import type { Sql } from "../db"
import type { Logger } from "../log"
import type { Images } from "../platforms/telegram/images"
import type { ReadSqrtPrice } from "../pool"
import type { Prices } from "../prices"

export type BotDeps = {
  sql: Sql
  prices: Prices
  log: Logger
  report: (err: unknown) => void
  /** Sends token cards as padded photos or text. */
  images: Images
  /** Bonded token cards read the live pool price through this. Absent: cards use the bonded-at row. */
  readSqrtPrice?: ReadSqrtPrice
  /** Public base URL of the Trade redirect. */
  linksBase: string
  /** Wait between checks for the bot's channel admin rights (tests use 1). */
  channelRetryMs?: number
}

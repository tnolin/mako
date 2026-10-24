import type { LaunchpadKey } from "../launchpads"
import type { NftAlertCard } from "../nft/card"
import type { AlertKind } from "../settings"

/** Platform-neutral alert (ADR 0002). Text fields are cleaned, not escaped; renderers escape. */
export type Card = {
  alert: AlertKind
  title: string
  ticker: string
  name: string
  launchpad: string
  launchpadKey: LaunchpadKey
  rows: [label: string, value: string][]
  links: { label: "X" | "Telegram" | "Website"; url: string }[]
  token: string
  imageUrl: string | null
}

export type Button = { text: string; url?: string; data?: string }

/** What a delivery row carries in its `card` column. */
export type Payload =
  | { type: "card"; card: Card; image: boolean }
  | { type: "nftalert"; card: NftAlertCard; image: boolean }
  | { type: "text"; html: string; buttons?: Button[][] }
  | {
      type: "newtokens"
      /** Launchpad display name. */
      launchpad: string
      /** Oldest first; names and tickers already cleaned. */
      entries: { token: string; name: string; ticker: string }[]
    }

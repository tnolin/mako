// Thresholds and limits for NFT alerts. Pure constants: settings.ts imports from here, never the reverse.

export const NFT_MARKS = [2500, 5000, 7500] as const
export type NftMark = (typeof NFT_MARKS)[number]

export const UNDER_STEPS = [1000, 2000, 3000] as const
export type UnderBps = (typeof UNDER_STEPS)[number]
export const RARE_STEPS = [100, 500, 1000] as const
export type RareBps = (typeof RARE_STEPS)[number]
export const FLOOR_STEPS = [1000, 2000, 3000] as const
export type FloorBps = (typeof FLOOR_STEPS)[number]
export const SWEEP_STEPS = [5, 10] as const
export type SweepItems = (typeof SWEEP_STEPS)[number]

const ETH = 10n ** 18n
const wei = (n: bigint): string => String(n)
/** BIG SALE minimums in wei (decimal strings): 0.05, 0.1, 0.25, 0.5 ETH. */
export const BIGSALE_STEPS = [wei(ETH / 20n), wei(ETH / 10n), wei(ETH / 4n), wei(ETH / 2n)] as const
/** SOLD minimums in wei: any, 0.01, 0.05, 0.1, 0.5, 1 ETH. One global value per chat. */
export const SALE_STEPS = [
  "0",
  wei(ETH / 100n),
  wei(ETH / 20n),
  wei(ETH / 10n),
  wei(ETH / 2n),
  wei(ETH),
] as const

export const DEFAULT_BIGSALE_WEI = BIGSALE_STEPS[1]
export const DEFAULT_SALE_WEI = SALE_STEPS[2]
/** The smallest BIG SALE choice: every sale at or above it yields a candidate. */
export const MIN_BIGSALE_WEI = BIGSALE_STEPS[0]

/** A stage whose label matches this, or whose allowlist has this many wallets or fewer, is a Team stage. */
export const TEAM_STAGE_RE = /team|reserve|treasury|dev/i
export const TEAM_ALLOWLIST_MAX = 10

export const LISTING_CAP = 3
export const LISTING_CAP_WINDOW_S = 3600
export const FLOOR_COOLDOWN_S = 6 * 3600
/** UNDER FLOOR and RARE LISTING need a floor read within this long of the listing. */
export const FLOOR_MAX_AGE_S = 15 * 60
export const SWEEP_WINDOW_S = 600
/** UNDER FLOOR and RARE LISTING ignore listings that expire within this long (relist bots). */
export const MIN_LISTING_LIFE_S = 3600
/** RARE LISTING: price at most floor × 11/10. */
export const RARE_PRICE_NUM = 11n
export const RARE_PRICE_DEN = 10n
export const WATCH_CAP_NFT = 50
export const REMINDER_LEAD_S = 15 * 60
/** MINT STARTING and MINT LIVE need a scheduled stage starting within this long of now, when the schedule is known. */
export const STAGE_START_MAX_S = 10 * 60
/** A catch-up for a mint with no stage end time needs a mint event at most this old. */
export const MINT_RECENT_S = 3600
/** A catch-up MINT STARTING or MINT LIVE needs a stage that started at most this long ago. */
export const CATCH_UP_MAX_S = 3600
/** A Chimera launch held for its OpenSea page is sent only this long after the launch. */
export const LAUNCH_HOLD_S = 7 * 24 * 3600
export const ITEM_CACHE_RANK_S = 7 * 24 * 3600
export const ITEM_CACHE_OFFER_S = 5 * 60
export const TRENDING_CACHE_S = 10 * 60

/** Decimal ETH from a wei string, trimmed: "100000000000000000" → "0.1". */
export function ethTrim(weiStr: string): string {
  const w = BigInt(weiStr)
  const frac = (w % ETH).toString().padStart(18, "0").replace(/0+$/, "")
  return frac ? `${w / ETH}.${frac}` : String(w / ETH)
}

/** A Team stage gets no MINT STARTING or MINT REMINDER and isn't listed on UPCOMING MINT. */
export function isTeamStage(s: { label: string; allowlistCount: number | null }): boolean {
  return (
    TEAM_STAGE_RE.test(s.label) ||
    (s.allowlistCount !== null && s.allowlistCount <= TEAM_ALLOWLIST_MAX)
  )
}

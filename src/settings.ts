import {
  BIGSALE_STEPS,
  DEFAULT_BIGSALE_WEI,
  DEFAULT_SALE_WEI,
  ethTrim,
  FLOOR_STEPS,
  type FloorBps,
  NFT_MARKS,
  type NftMark,
  RARE_STEPS,
  type RareBps,
  SALE_STEPS,
  SWEEP_STEPS,
  type SweepItems,
  UNDER_STEPS,
  type UnderBps,
} from "./nft/policy"

export const TOKEN_ALERTS = ["new", "bonding", "pumping", "bonded", "devsell", "big"] as const
/** Shown on the "All collections" screen: they reach every collection that passes the checks. */
export const NFT_ALL_ALERTS = [
  "upcoming",
  "mintstart",
  "minted",
  "soldout",
  "launch",
  "bigsale",
] as const
/** Shown on the "Watched only" screen: they never fire for a collection the chat doesn't watch. */
export const NFT_WATCHED_ALERTS = ["under", "rare", "floor", "sweep", "sale", "reminder"] as const
/**
 * MCAP TARGET has no switch: it reaches only whoever set the target on a watched token. It is an alert kind so a
 * group can route it to a topic.
 */
export const ALERTS = [...TOKEN_ALERTS, "mcap", ...NFT_ALL_ALERTS, ...NFT_WATCHED_ALERTS] as const
export type TokenAlert = (typeof TOKEN_ALERTS)[number]
export type AlertKind = (typeof ALERTS)[number]
/** Regex alternation of every alert kind, for callback-data patterns, so a new alert needs no edit there. */
export const ALERT_PATTERN = ALERTS.join("|")
export const TOKEN_PATTERN = TOKEN_ALERTS.join("|")
export const MARKS = [5000, 8000, 9000] as const
export type Mark = (typeof MARKS)[number]
export const BIG_STEPS = [250, 500, 1000] as const
export type BigBps = (typeof BIG_STEPS)[number]
/** PUMPING after bonding: the market cap gain over the 10-minute low, in bps. */
export const PUMP_BONDED_STEPS = [1500, 2000, 3000, 5000] as const
export type PumpBps = (typeof PUMP_BONDED_STEPS)[number]
/** PUMPING after bonding: the lowest market cap in USD a feed hears about. */
export const PUMP_FLOOR_STEPS = [25_000, 50_000, 100_000, 250_000] as const
export type PumpFloorUsd = (typeof PUMP_FLOOR_STEPS)[number]
export type { NftMark }

/** The chat types a Settings object is made for: the NFT defaults differ between a DM and a group. */
export type ChatType = "private" | "group" | "supergroup" | "channel"

type Toggle = { on: boolean; image: boolean }
export type Settings = {
  alerts: {
    new: Toggle
    bonding: Toggle & { marks: Mark[] }
    /** `pctBps` and `floorUsd` apply after bonding; the curve rule has a fixed threshold. */
    pumping: Toggle & { pctBps: PumpBps; floorUsd: PumpFloorUsd }
    bonded: Toggle
    devsell: Toggle
    big: Toggle & { pctBps: BigBps }
    /** Always on: readSettings sets `on` whatever is stored. */
    mcap: Toggle
    upcoming: Toggle
    mintstart: Toggle
    minted: Toggle & { marks: NftMark[] }
    soldout: Toggle
    launch: Toggle
    /** Minimum price in wei, a decimal string. */
    bigsale: Toggle & { minWei: string }
    under: Toggle & { pctBps: UnderBps }
    rare: Toggle & { topBps: RareBps }
    floor: Toggle & { pctBps: FloorBps }
    sweep: Toggle & { items: SweepItems }
    /** SOLD: one global minimum price in wei, a decimal string. */
    sale: Toggle & { minWei: string }
    /** MINT REMINDER: DMs only, and no image switch. */
    reminder: { on: boolean }
  }
  /** Chats: default topic (null = General). */
  thread?: number | null
  /** Chats: per-alert topic. */
  routes?: Partial<Record<AlertKind, number>>
  /** Chats: alerts whose topic broke. */
  pausedRoutes?: AlertKind[]
  /** Chats: names of the topics MAKO posts in, by topic number, as Telegram sent them. */
  topicNames?: Record<string, string>
}

/** A topic as the screens name it: General, its stored name, or its number for a route saved before names. */
export const topicLabel = (s: Settings, thread: number | null | undefined): string =>
  thread == null ? "General" : (s.topicNames?.[thread] ?? `topic ${thread}`)

/** Telegram caps a topic name at 128 characters. */
const TOPIC_NAME_MAX = 128

export const PRIORITY = {
  notice: 0,
  devsell: 0,
  bonded: 1,
  mcap: 1,
  summary: 1,
  soldout: 1,
  bonding: 2,
  mintstart: 2,
  reminder: 2,
  rare: 2,
  pumping: 3,
  upcoming: 3,
  minted: 3,
  under: 3,
  sweep: 3,
  bigsale: 3,
  launch: 3,
  big: 4,
  floor: 4,
  new: 5,
  sale: 5,
} as const

/** Kinds that may wait 30 minutes in the queue instead of 3. */
// shortcut: an MCAP TARGET delivery still pending after 30 minutes is skipped by lateDrop after its target was
// cleared. Restore the target when lateDrop skips an mcap delivery if this shows up.
export const LONG_WINDOW = [
  "devsell",
  "mcap",
  "bonded",
  "notice",
  "summary",
  "upcoming",
  "minted",
  "soldout",
  "launch",
  "floor",
  "sweep",
  "bigsale",
  "sale",
] as const

export const ALERT_LABEL: Record<AlertKind, string> = {
  new: "NEW TOKEN",
  bonding: "BONDING",
  pumping: "PUMPING",
  bonded: "BONDED",
  devsell: "DEV SELL",
  big: "BIG BUY/SELL",
  mcap: "MCAP TARGET",
  upcoming: "UPCOMING MINT",
  mintstart: "MINT STARTING",
  minted: "MINTED",
  soldout: "SOLD OUT",
  launch: "NEW COLLECTION",
  under: "UNDER FLOOR",
  rare: "RARE LISTING",
  floor: "FLOOR MOVE",
  sweep: "SWEEP",
  bigsale: "BIG SALE",
  sale: "SOLD",
  reminder: "MINT REMINDER",
}

/** The label on the settings screens: the setting that switches MINT REMINDER on is REMINDERS. */
export const SETTINGS_LABEL: Record<AlertKind, string> = { ...ALERT_LABEL, reminder: "REMINDERS" }

/** One line per token alert, for the onboarding picker. */
export const ALERT_HELP: Record<TokenAlert, string> = {
  new: "a token launches",
  bonding: "curve passes 80% or 90%",
  pumping: "curve +15% or mcap +20% in 10 min",
  bonded: "a token bonds",
  devsell: "the creator sells",
  big: "one trade worth 5%+ of the bond target or pool",
}

/** Whether the chat wants a photo for this alert. MINT REMINDER has no image switch: it always has one. */
export function wantsImage(s: Settings, kind: AlertKind): boolean {
  return kind === "reminder" ? true : s.alerts[kind].image
}

const pct = (bps: number): string => String(bps / 100)

/** The line on the alert-settings screens, with the current thresholds. */
export function ALERT_DESC(kind: AlertKind, s: Settings): string {
  const a = s.alerts
  switch (kind) {
    case "new":
      return "NEW TOKEN - newly detected tokens created."
    case "bonding":
      return "BONDING - When a token passes your set threshold."
    case "pumping":
      return `PUMPING - When a token's curve jumps 15%+ in 10 min, or its market cap rises ${pct(a.pumping.pctBps)}%+ in 10 min after bonding.`
    case "bonded":
      return "BONDED - A token that has bonded/graduated."
    case "devsell":
      return "DEV SELL - When the creator sells any amount of their own token."
    case "big":
      return `BIG BUY/SELL - one trade worth ${pct(a.big.pctBps)}%+ of the token's bond target, or of its pool's liquidity after bonding.`
    case "mcap":
      return "MCAP TARGET - When a watched token's market cap reaches the target you set with /watch."
    case "upcoming":
      return "UPCOMING MINT - When a new mint is scheduled."
    case "mintstart":
      return "MINT STARTING - When a mint's public stage opens."
    case "minted":
      return "MINTED - When a watched collection's total mints has passed your designated threshold (eg. 50% = 50/100 mints)."
    case "soldout":
      return "SOLD OUT - When a collection completely mints out."
    case "launch":
      return "NEW COLLECTION - A new Chimera collection is detected."
    case "bigsale":
      return `BIG SALE - When an NFT sells for ${ethTrim(a.bigsale.minWei)} ETH or more.`
    case "under":
      return `UNDER FLOOR - an item lists ${pct(a.under.pctBps)}%+ under floor.`
    case "rare":
      return `RARE LISTING - a top ${pct(a.rare.topBps)}% item lists near floor.`
    case "floor":
      return `FLOOR MOVE - the floor moves ${pct(a.floor.pctBps)}%+ in 24h.`
    case "sweep":
      return `SWEEP - one wallet buys ${a.sweep.items}+ items in 10 min.`
    case "sale":
      return a.sale.minWei === "0"
        ? "SOLD - an item sells at any price."
        : `SOLD - an item sells for ${ethTrim(a.sale.minWei)} ETH or more.`
    case "reminder":
      return "REMINDERS - a message 15 min before each mint stage."
  }
}

/** The defaults for a chat type. The seven All collections kinds are on in DMs and off elsewhere. */
export function basicPreset(chatType: ChatType): Settings {
  const t = (): Toggle => ({ on: true, image: true })
  const feed = (): Toggle => ({ on: chatType === "private", image: true })
  return {
    alerts: {
      new: t(),
      bonding: { ...t(), marks: [8000, 9000] },
      pumping: { ...t(), pctBps: 2000, floorUsd: 50_000 },
      bonded: t(),
      devsell: t(),
      big: { ...t(), pctBps: 500 },
      mcap: t(),
      upcoming: feed(),
      mintstart: feed(),
      minted: { ...feed(), marks: [5000] },
      soldout: feed(),
      launch: feed(),
      bigsale: { ...feed(), minWei: DEFAULT_BIGSALE_WEI },
      under: { ...t(), pctBps: 2000 },
      rare: { ...t(), topBps: 1000 },
      floor: { ...t(), pctBps: 2000 },
      sweep: { ...t(), items: 5 },
      sale: { on: false, image: true, minWei: DEFAULT_SALE_WEI },
      reminder: { on: true },
    },
  }
}

export function allOff(s: Settings): Settings {
  const out = structuredClone(s)
  for (const a of ALERTS) out.alerts[a].on = false
  return out
}

const SCREEN_KINDS = {
  token: TOKEN_ALERTS,
  nft_all: NFT_ALL_ALERTS,
  nft_watched: NFT_WATCHED_ALERTS,
} as const

/** One settings screen back to the defaults for the chat type. Topic routes are not an alert preference. */
export function resetScreen(
  s: Settings,
  screen: keyof typeof SCREEN_KINDS,
  chatType: ChatType,
): Settings {
  const out = structuredClone(s)
  const d = basicPreset(chatType)
  for (const k of SCREEN_KINDS[screen]) (out.alerts as Record<string, unknown>)[k] = d.alerts[k]
  return out
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null
const pick = <T>(steps: readonly T[], v: unknown, dflt: T): T =>
  steps.includes(v as T) ? (v as T) : dflt

/** Stored JSON over the defaults for the chat type. Unknown or invalid values fall back to the default. */
export function readSettings(raw: unknown, chatType: ChatType): Settings {
  const s = basicPreset(chatType)
  if (!isObj(raw)) return s
  const alerts = isObj(raw.alerts) ? raw.alerts : {}
  for (const a of ALERTS) {
    const v = alerts[a]
    if (!isObj(v)) continue
    if (typeof v.on === "boolean") s.alerts[a].on = v.on
    if (a !== "reminder" && typeof v.image === "boolean") s.alerts[a].image = v.image
  }
  s.alerts.mcap.on = true
  const b = alerts.bonding
  if (isObj(b) && Array.isArray(b.marks)) {
    s.alerts.bonding.marks = MARKS.filter((m) => (b.marks as unknown[]).includes(m))
  }
  const g = alerts.big
  if (isObj(g) && BIG_STEPS.includes(g.pctBps as BigBps)) s.alerts.big.pctBps = g.pctBps as BigBps
  const m = alerts.minted
  if (isObj(m) && Array.isArray(m.marks)) {
    s.alerts.minted.marks = NFT_MARKS.filter((x) => (m.marks as unknown[]).includes(x))
  }
  const o = (k: string) => (isObj(alerts[k]) ? (alerts[k] as Record<string, unknown>) : {})
  const A = s.alerts
  A.pumping.pctBps = pick(PUMP_BONDED_STEPS, o("pumping").pctBps, A.pumping.pctBps)
  A.pumping.floorUsd = pick(PUMP_FLOOR_STEPS, o("pumping").floorUsd, A.pumping.floorUsd)
  A.bigsale.minWei = pick<string>(BIGSALE_STEPS, o("bigsale").minWei, A.bigsale.minWei)
  A.under.pctBps = pick(UNDER_STEPS, o("under").pctBps, A.under.pctBps)
  A.rare.topBps = pick(RARE_STEPS, o("rare").topBps, A.rare.topBps)
  A.floor.pctBps = pick(FLOOR_STEPS, o("floor").pctBps, A.floor.pctBps)
  A.sweep.items = pick(SWEEP_STEPS, o("sweep").items, A.sweep.items)
  A.sale.minWei = pick<string>(SALE_STEPS, o("sale").minWei, A.sale.minWei)
  if (typeof raw.thread === "number" || raw.thread === null) s.thread = raw.thread
  if (isObj(raw.routes)) {
    s.routes = Object.fromEntries(
      Object.entries(raw.routes).filter(
        ([k, v]) => (ALERTS as readonly string[]).includes(k) && typeof v === "number",
      ),
    ) as Settings["routes"]
  }
  if (Array.isArray(raw.pausedRoutes)) {
    s.pausedRoutes = ALERTS.filter((a) => (raw.pausedRoutes as unknown[]).includes(a))
  }
  if (isObj(raw.topicNames)) {
    s.topicNames = Object.fromEntries(
      Object.entries(raw.topicNames)
        .filter(([k, v]) => /^\d+$/.test(k) && typeof v === "string" && v.trim() !== "")
        .map(([k, v]) => [k, (v as string).trim().slice(0, TOPIC_NAME_MAX)]),
    )
  }
  return s
}

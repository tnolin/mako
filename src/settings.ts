export const ALERTS = ["new", "bonding", "pumping", "bonded", "devsell", "big"] as const
export type AlertKind = (typeof ALERTS)[number]
/** Regex alternation of every alert kind, for callback-data patterns, so a new alert needs no edit there. */
export const ALERT_PATTERN = ALERTS.join("|")
export const MARKS = [5000, 8000, 9000] as const
export type Mark = (typeof MARKS)[number]
export const BIG_STEPS = [250, 500, 1000] as const
export type BigBps = (typeof BIG_STEPS)[number]

type Toggle = { on: boolean; image: boolean }
export type Settings = {
  alerts: {
    new: Toggle
    bonding: Toggle & { marks: Mark[] }
    pumping: Toggle
    bonded: Toggle
    devsell: Toggle
    big: Toggle & { pctBps: BigBps }
  }
  /** Chats: default topic (null = General). */
  thread?: number | null
  /** Chats: per-alert topic. */
  routes?: Partial<Record<AlertKind, number>>
  /** Chats: alerts whose topic broke. */
  pausedRoutes?: AlertKind[]
}

export const PRIORITY = {
  notice: 0,
  devsell: 0,
  bonded: 1,
  summary: 1,
  bonding: 2,
  pumping: 3,
  big: 4,
  new: 5,
} as const

/** Kinds that may wait 30 minutes in the queue instead of 3. */
export const LONG_WINDOW = ["devsell", "bonded", "notice", "summary"] as const

export const ALERT_LABEL: Record<AlertKind, string> = {
  new: "NEW TOKEN",
  bonding: "BONDING",
  pumping: "PUMPING",
  bonded: "BONDED",
  devsell: "DEV SELL",
  big: "BIG BUY/SELL",
}

export const ALERT_HELP: Record<AlertKind, string> = {
  new: "a token launches",
  bonding: "curve passes 80% or 90%",
  pumping: "curve jumps 15%+ in 10 min",
  bonded: "a token bonds",
  devsell: "the creator sells",
  big: "one trade of 5%+ of the bond target",
}

export function basicPreset(): Settings {
  const t = (): Toggle => ({ on: true, image: true })
  return {
    alerts: {
      new: t(),
      bonding: { ...t(), marks: [8000, 9000] },
      pumping: t(),
      bonded: t(),
      devsell: t(),
      big: { ...t(), pctBps: 500 },
    },
  }
}

export function allOff(s: Settings): Settings {
  const out = structuredClone(s)
  for (const a of ALERTS) out.alerts[a].on = false
  return out
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null

/** Stored JSON over code defaults. Unknown or invalid values fall back to the default. */
export function readSettings(raw: unknown): Settings {
  const s = basicPreset()
  if (!isObj(raw)) return s
  const alerts = isObj(raw.alerts) ? raw.alerts : {}
  for (const a of ALERTS) {
    const v = alerts[a]
    if (!isObj(v)) continue
    if (typeof v.on === "boolean") s.alerts[a].on = v.on
    if (typeof v.image === "boolean") s.alerts[a].image = v.image
  }
  const b = alerts.bonding
  if (isObj(b) && Array.isArray(b.marks)) {
    s.alerts.bonding.marks = MARKS.filter((m) => (b.marks as unknown[]).includes(m))
  }
  const g = alerts.big
  if (isObj(g) && BIG_STEPS.includes(g.pctBps as BigBps)) s.alerts.big.pctBps = g.pctBps as BigBps
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
  return s
}

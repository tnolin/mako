const CONTROL = /[\p{Cc}‎‏‪-‮⁦-⁩]/gu

/** HTML-escapes text for Telegram's HTML parse mode. */
export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

/** Creator-written text: strips control and bidi characters, trims, cuts to `max` code points. */
export function clean(s: string | null | undefined, max: number): string {
  if (!s) return ""
  const chars = [...s.replace(CONTROL, "").trim()]
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("")
}

/** Returns the URL if it is http(s), otherwise null. */
export function safeUrl(u: string | null | undefined): string | null {
  if (!u) return null
  try {
    const url = new URL(u.trim())
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null
  } catch {
    return null
  }
}

/** Base units to a float. Display only: precision loss past 15 digits is fine here. */
export function units(raw: string | bigint, decimals = 18): number {
  return Number(BigInt(raw)) / 10 ** decimals
}

export function usd(n: number): string {
  if (n < 999.5) return `$${Math.round(n)}`
  if (n < 99_950) return `$${(n / 1e3).toFixed(1)}K`
  if (n < 999_500) return `$${Math.round(n / 1e3)}K`
  if (n < 999_950_000) return `$${(n / 1e6).toFixed(1)}M`
  return `$${(n / 1e9).toFixed(1)}B`
}

/** Quote amounts: 2 decimals, or 4 below 0.01. */
export function amount(n: number): string {
  const d = n !== 0 && Math.abs(n) < 0.01 ? 4 : 2
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })
}

/** Token amounts: 12.4M, 214M, 1.2B. One decimal below 100 of a unit, none above (like usd). */
export function compact(n: number): string {
  const scaled = (v: number, unit: string) =>
    v < 99.95 ? `${v.toFixed(1)}${unit}` : `${Math.round(v)}${unit}`
  if (n >= 1e9) return scaled(n / 1e9, "B")
  if (n >= 1e6) return scaled(n / 1e6, "M")
  if (n >= 1e3) return scaled(n / 1e3, "K")
  return String(Math.round(n))
}

export const pct1 = (n: number): string => `${n.toFixed(1)}%`
export const count = (n: number): string => n.toLocaleString("en-US")

export function age(seconds: number): string {
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${Math.max(1, m)}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export function buysSells(buys: number, sells: number): string {
  return `${count(buys)} buy${buys === 1 ? "" : "s"} | ${count(sells)} sell${sells === 1 ? "" : "s"}`
}

/** 10-cell curve bar from soldBps, matching InkyPump's display. */
export function bar(soldBps: number): string {
  const filled = Math.min(10, Math.floor(soldBps / 1000))
  return `${"■".repeat(filled)}${"□".repeat(10 - filled)} ${Math.floor(soldBps / 100)}%`
}

export function bpsChange(delta: number): string {
  return delta >= 0 ? `(+${Math.floor(delta / 100)}%)` : `(−${Math.floor(-delta / 100)}%)`
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const two = (n: number) => String(n).padStart(2, "0")

/** `Sep 6` (UTC). */
export function utcDate(ts: number): string {
  const d = new Date(ts * 1000)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
}

/** `17:00 UTC`, or `Sep 6 17:00 UTC` with the date (UTC). */
export function utcTime(ts: number, withDate = false): string {
  const d = new Date(ts * 1000)
  const t = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`
  return withDate ? `${utcDate(ts)} ${t}` : t
}

/** A countdown without the zero parts: 15m, 3h, 4h 12m, 21d, 2d 4h. */
export function inText(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  return h % 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${Math.floor(h / 24)}d`
}

export const wallets = (n: number): string => `${count(n)} wallet${n === 1 ? "" : "s"}`

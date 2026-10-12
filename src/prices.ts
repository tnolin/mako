import type { Logger } from "./log"

export const NATIVE = "0x0000000000000000000000000000000000000000"
const KRAKEN = "https://api.kraken.com/0/public/Ticker?pair=XETHZUSD"
const INKY = "https://inkypump.com/api/xstocks/quote-assets?chainId=57073&pageSize=100"
const ETH_FRESH_MS = 10 * 60_000
const XSTOCK_FRESH_MS = 30 * 60_000
const OUTAGE_MS = 30 * 60_000

// shortcut: symbols of the 11 xStocks wrappers on 2026-10-12, used until InkyPump's list loads.
// The bot can't read indexer.hooks and makes no RPC call for symbols. Unknown wrappers show "xStock".
const SEED_SYMBOLS: Record<string, string> = {
  "0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f": "AAPLx",
  "0xd37a850b99a8b80126e025c2ecfcdf853a1eb77d": "ACNx",
  "0x459d3ae62b86cc6125e06260dddfd3afed24a877": "GMEx",
  "0x30987adf0b11dc698438a99ba04ec3a1ab2c7eab": "MSTRx",
  "0x9ac987161435191b055447c288033ea34b0c1477": "NDAQx",
  "0x7d87fd6a379714194a797c0bbb8b40c30d250856": "NFLXx",
  "0xa8ddb5cd96b5222afe198316e9a57caa642850d5": "NVDAx",
  "0x4a2df09536f62341c9f946427d16414c04e21342": "PLTRx",
  "0x8e2eed8b8b5e13ea7bf38e50d7821d2c57309072": "SPCXx",
  "0xe7e553cd128f0011777323a0b44a7b96ea1cb540": "SPYx",
  "0xc3fdbe3a68ee5de461d30415a8165cf9aefe1171": "TSLAx",
}

export function parseKraken(json: unknown): number | null {
  const v = (json as { result?: { XETHZUSD?: { c?: unknown[] } } })?.result?.XETHZUSD?.c?.[0]
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function parseXstocks(json: unknown): Map<string, { usd: number | null; symbol: string }> {
  const out = new Map<string, { usd: number | null; symbol: string }>()
  const assets = (json as { assets?: unknown[] })?.assets ?? []
  for (const a of assets as {
    wrapperAddress?: string
    symbol?: string
    valuation?: { wrapperPriceUsd?: string | null } | null
  }[]) {
    if (!a.wrapperAddress || !a.symbol) continue
    const n = Number(a.valuation?.wrapperPriceUsd)
    out.set(a.wrapperAddress.toLowerCase(), {
      usd: a.valuation?.wrapperPriceUsd != null && Number.isFinite(n) && n > 0 ? n : null,
      symbol: a.symbol,
    })
  }
  return out
}

export type Prices = {
  /** USD per whole quote token, or null when no fresh price exists. */
  usd(quote: string): number | null
  /** "ETH", the xStock symbol, or "xStock". */
  symbol(quote: string): string
}

export function createPrices(deps: {
  fetch?: typeof fetch
  now?: () => number
  log: Logger
  report?: (msg: string) => void
}): Prices & { refresh(): Promise<void>; start(): () => void } {
  const { fetch: f = fetch, now = Date.now, log, report = () => {} } = deps
  let eth: { usd: number; at: number } | undefined
  let xs: { map: Map<string, { usd: number | null; symbol: string }>; at: number } | undefined
  const outage = { eth: { since: 0, reported: false }, xs: { since: 0, reported: false } }

  const health = (key: "eth" | "xs", ok: boolean, label: string) => {
    const o = outage[key]
    if (ok) {
      o.since = 0
      o.reported = false
      return
    }
    if (!o.since) o.since = now()
    if (!o.reported && now() - o.since >= OUTAGE_MS) {
      o.reported = true
      report(`${label} price unavailable for 30 minutes`)
    }
  }

  const get = async (url: string) => {
    const res = await f(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }

  const refreshEth = async () => {
    try {
      const v = parseKraken(await get(KRAKEN))
      if (v !== null) eth = { usd: v, at: now() }
    } catch (err) {
      log("warn", "ETH/USD fetch failed", { error: String(err) })
    }
    health("eth", eth !== undefined && now() - eth.at < ETH_FRESH_MS, "ETH/USD")
  }

  const refreshXstocks = async () => {
    try {
      xs = { map: parseXstocks(await get(INKY)), at: now() }
    } catch (err) {
      log("warn", "xStock prices fetch failed", { error: String(err) })
    }
    health("xs", xs !== undefined && now() - xs.at < XSTOCK_FRESH_MS, "xStock/USD")
  }

  return {
    usd(quote) {
      const q = quote.toLowerCase()
      if (q === NATIVE) return eth && now() - eth.at < ETH_FRESH_MS ? eth.usd : null
      if (!xs || now() - xs.at >= XSTOCK_FRESH_MS) return null
      return xs.map.get(q)?.usd ?? null
    },
    symbol(quote) {
      const q = quote.toLowerCase()
      if (q === NATIVE) return "ETH"
      return xs?.map.get(q)?.symbol ?? SEED_SYMBOLS[q] ?? "xStock"
    },
    async refresh() {
      await Promise.all([refreshEth(), refreshXstocks()])
    },
    start() {
      void refreshEth()
      void refreshXstocks()
      const a = setInterval(() => void refreshEth(), 60_000)
      const b = setInterval(() => void refreshXstocks(), 5 * 60_000)
      return () => {
        clearInterval(a)
        clearInterval(b)
      }
    },
  }
}

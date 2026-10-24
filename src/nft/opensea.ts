import type { Sql } from "../db"
import type { Logger } from "../log"

/** What the NFT card reads from OpenSea about one item. */
export type ItemData = {
  /** OpenSea's rarity rank; null when the collection has none. */
  rank: number | null
  traits: { type: string; value: string }[]
  imageUrl: string | null
  /** Wei. Null when there is none. */
  bestOffer: bigint | null
  listed: bigint | null
  /** The offer or listing read failed: the card says some details are unavailable. */
  partial: boolean
}

export type TrendingTimeframe = "one_hour" | "one_day" | "seven_days"
export type TrendingRow = { slug: string; name: string }

export type ItemReader = {
  /** `calcAt` is the collection's rarity `calculated_at`; a different value drops the cached rank. */
  get(contract: string, tokenId: string, calcAt: string | null): Promise<ItemData | "unavailable">
  trending(timeframe: TrendingTimeframe): Promise<TrendingRow[] | "unavailable">
}

const BASE = "https://api.opensea.io/api/v2"
const BUDGET_WAIT_MS = 5_000
const TIMEOUT_MS = 8_000
const RANK_TTL_MS = 7 * 24 * 3600_000
const OFFER_TTL_MS = 5 * 60_000
const TRENDING_TTL_MS = 10 * 60_000
const REJECTED_LOG_EVERY_MS = 3600_000
const DEFAULT_BLOCK_MS = 60_000

type Got<T> = { ok: true; value: T } | { ok: false; reason: "budget" | "not_found" | "error" }

/**
 * Reads OpenSea for the NFT card and the Trending list. Every request takes one token from the indexer's
 * shared budget (class 0, the bot) and waits at most 5 seconds for it; a 429 blocks every process sharing
 * the key. The key is only ever sent in the x-api-key header and never logged.
 */
export function createItemReader(deps: {
  key: string
  sql: Sql
  fetch?: typeof fetch
  log: Logger
  now?: () => number
}): ItemReader {
  const { key, sql, log } = deps
  const doFetch = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  let rejectedAt: number | undefined
  const scrub = (v: unknown) => {
    const s = v instanceof Error ? v.message : String(v)
    return (key ? s.split(key).join("***") : s).slice(0, 200)
  }

  /** Waits for a budget token, at most 5 s. */
  async function take(): Promise<boolean> {
    const deadline = now() + BUDGET_WAIT_MS
    for (;;) {
      const [row] = await sql<{ wait: number }[]>`select indexer.opensea_take(0) as wait`
      const wait = row?.wait ?? 0
      if (wait === 0) return true
      if (now() + wait > deadline) return false
      await sleep(wait)
    }
  }

  async function get<T>(path: string, parse: (j: unknown) => T): Promise<Got<T>> {
    const where = path.split("?")[0] ?? path
    try {
      if (!(await take())) return { ok: false, reason: "budget" }
      const res = await doFetch(`${BASE}${path}`, {
        headers: { accept: "application/json", "x-api-key": key },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (res.ok) return { ok: true, value: parse(await res.json()) }
      await res.body?.cancel().catch(() => {})
      if (res.status === 404) return { ok: false, reason: "not_found" }
      if (res.status === 401 || res.status === 403) {
        const t = now()
        if (rejectedAt === undefined || t - rejectedAt >= REJECTED_LOG_EVERY_MS) {
          rejectedAt = t
          log("error", "opensea key rejected", { status: res.status })
        }
      } else if (res.status === 429) {
        const secs = Number(res.headers.get("retry-after")?.trim())
        const ms =
          Number.isFinite(secs) && secs >= 0
            ? Math.min(Math.max(secs * 1000, 1000), 3600_000)
            : DEFAULT_BLOCK_MS
        await sql`select indexer.opensea_block(${Math.round(ms)})`.catch((e) =>
          log("warn", "opensea block not recorded", { error: scrub(e) }),
        )
        log("warn", "opensea rate limited", { path: where, blockedMs: ms })
      } else {
        log("warn", "opensea request failed", { path: where, status: res.status })
      }
      return { ok: false, reason: "error" }
    } catch (err) {
      log("warn", "opensea request failed", { path: where, error: scrub(err) })
      return { ok: false, reason: "error" }
    }
  }

  type Base = {
    at: number
    calcAt: string | null
    rank: number | null
    traits: ItemData["traits"]
    imageUrl: string | null
    slug: string | null
  }
  type Prices = { at: number; bestOffer: bigint | null; listed: bigint | null; partial: boolean }
  // shortcut: in memory and per process, never evicted; one entry per item looked up. Add a size cap if
  // lookups grow past a few thousand items a day.
  const bases = new Map<string, Base>()
  const prices = new Map<string, Prices>()
  const trends = new Map<string, { at: number; rows: TrendingRow[] }>()

  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null)
  const parseItem = (j: unknown): Omit<Base, "at" | "calcAt"> => {
    const n = (j as { nft?: Record<string, unknown> }).nft
    if (!n) throw new Error("no nft")
    const rank = (n.rarity as { rank?: unknown } | null | undefined)?.rank
    const traits = Array.isArray(n.traits)
      ? (n.traits as { trait_type?: unknown; value?: unknown }[])
          .filter(
            (t) =>
              str(t.trait_type) !== null &&
              t.value !== null &&
              t.value !== undefined &&
              String(t.value) !== "",
          )
          .map((t) => ({ type: String(t.trait_type), value: String(t.value) }))
      : []
    return {
      rank: typeof rank === "number" && Number.isInteger(rank) && rank > 0 ? rank : null,
      traits,
      imageUrl: str(n.image_url) ?? str(n.display_image_url),
      slug: str(n.collection),
    }
  }
  /** A price in wei from a Price object; only 18-decimal ETH and WETH count. */
  const wei = (p: unknown): bigint | null => {
    const o = p as { currency?: unknown; decimals?: unknown; value?: unknown } | undefined
    if (o?.decimals !== 18 || typeof o.value !== "string" || !/^[0-9]+$/.test(o.value)) return null
    return BigInt(o.value)
  }

  return {
    async get(contract, tokenId, calcAt) {
      const id = `${contract}:${tokenId}`
      const t = now()
      let base = bases.get(id)
      if (!base || t - base.at > RANK_TTL_MS || base.calcAt !== calcAt) {
        const r = await get(`/chain/ink/contract/${contract}/nfts/${tokenId}`, parseItem)
        if (!r.ok) return "unavailable"
        base = { ...r.value, at: t, calcAt }
        bases.set(id, base)
      }
      let p = prices.get(id)
      if (!p || t - p.at > OFFER_TTL_MS) {
        let partial = false
        let bestOffer: bigint | null = null
        let listed: bigint | null = null
        if (base.slug) {
          const [o, l] = await Promise.all([
            get(`/offers/collection/${base.slug}/nfts/${tokenId}/best`, (j) =>
              wei((j as { price?: unknown }).price),
            ),
            get(`/listings/collection/${base.slug}/nfts/${tokenId}/best`, (j) =>
              wei((j as { price?: { current?: unknown } }).price?.current),
            ),
          ])
          if (o.ok) bestOffer = o.value
          else if (o.reason !== "not_found") partial = true
          if (l.ok) listed = l.value
          else if (l.reason !== "not_found") partial = true
        } else partial = true
        p = { at: t, bestOffer, listed, partial }
        prices.set(id, p)
      }
      return {
        rank: base.rank,
        traits: base.traits,
        imageUrl: base.imageUrl,
        bestOffer: p.bestOffer,
        listed: p.listed,
        partial: p.partial,
      }
    },

    async trending(timeframe) {
      const hit = trends.get(timeframe)
      if (hit && now() - hit.at <= TRENDING_TTL_MS) return hit.rows
      const r = await get(
        `/collections/trending?chains=ink&timeframe=${timeframe}&limit=20`,
        (j) => {
          const cs = (j as { collections?: { collection?: unknown; name?: unknown }[] }).collections
          if (!Array.isArray(cs)) throw new Error("no collections")
          return cs.flatMap((c) =>
            str(c.collection)
              ? [{ slug: str(c.collection)!, name: str(c.name) ?? str(c.collection)! }]
              : [],
          )
        },
      )
      if (!r.ok) return "unavailable"
      trends.set(timeframe, { at: now(), rows: r.value })
      return r.value
    },
  }
}

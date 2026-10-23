import { readFileSync } from "node:fs"
import { afterAll, beforeEach, describe, expect, inject, it, vi } from "vitest"
import type { Sql } from "../src/db"
import { createItemReader, type ItemReader } from "../src/nft/opensea"
import { loadNftState, type NftState } from "../src/nft/state"
import { createBot } from "../src/platforms/telegram/bot"
import type { Prices } from "../src/prices"
import { insertEvents, resetDb } from "./helpers/db"
import { nftCollection, nftSale, nftStats } from "./helpers/events"
import { testImages } from "./helpers/images"
import { BOT_INFO, harness, type Payload } from "./helpers/tg"

const WIRED = "0x7c701c0148e0e965065aa05e008ac9341e6efc6c"
const KEY = "SECRETKEY123"
const NOW = Date.UTC(2026, 9, 20) / 1000
const prices: Prices = { usd: () => 2500, symbol: () => "ETH" }
const fixture = () =>
  JSON.parse(
    readFileSync(new URL("./fixtures/opensea/nft-wired-4164.json", import.meta.url), "utf8"),
  ).body
const eth = (n: number) => String(BigInt(Math.round(n * 1e9)) * 10n ** 9n)
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

let sql: Sql
let calls: string[]
let log: ReturnType<
  typeof vi.fn<(level: string, msg: string, fields?: Record<string, unknown>) => void>
>
let route: (path: string) => Response | Promise<Response>
let t = 0
let reader: ItemReader

const okRoute =
  (nft = fixture()) =>
  (path: string) => {
    if (path.includes("/offers/"))
      return json({ price: { currency: "WETH", decimals: 18, value: eth(0.0011) } })
    if (path.includes("/listings/"))
      return json({ price: { current: { currency: "ETH", decimals: 18, value: eth(0.0019) } } })
    if (path.includes("/collections/trending"))
      return json({
        collections: [
          { collection: "wiredonink", name: "WIRED" },
          { collection: "elsewhere", name: "Elsewhere" },
        ],
      })
    return json(nft)
  }
beforeEach(async () => {
  await sql?.end()
  sql = await resetDb(inject("databaseUrl"))
  calls = []
  log = vi.fn()
  t = 1_000_000
  route = okRoute()
  const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
    calls.push(String(url).replace("https://api.opensea.io/api/v2", ""))
    expect((init?.headers as Record<string, string> | undefined)?.["x-api-key"]).toBe(KEY)
    return route(String(url))
  })
  reader = createItemReader({
    key: KEY,
    sql,
    fetch: fetchFn as unknown as typeof fetch,
    log,
    now: () => t,
  })
})
afterAll(() => sql.end())

describe("OpenSea reader", () => {
  it("reads rank, traits, the best offer and the best listing", async () => {
    const d = await reader.get(WIRED, "4164", null)
    expect(d).toMatchObject({
      rank: 752,
      bestOffer: BigInt(eth(0.0011)),
      listed: BigInt(eth(0.0019)),
      partial: false,
    })
    expect((d as { traits: unknown[] }).traits).toHaveLength(10)
    expect((d as { traits: { type: string; value: string }[] }).traits[0]).toEqual({
      type: "Cat",
      value: "Whisper",
    })
    expect(calls).toEqual([
      `/chain/ink/contract/${WIRED}/nfts/4164`,
      "/offers/collection/wiredonink/nfts/4164/best",
      "/listings/collection/wiredonink/nfts/4164/best",
    ])
  })

  it("answers a repeat from the cache, refetches the rank when calcAt changes, and the prices after 5 minutes", async () => {
    await reader.get(WIRED, "4164", "a")
    await reader.get(WIRED, "4164", "a")
    expect(calls).toHaveLength(3)
    await reader.get(WIRED, "4164", "b")
    expect(calls).toHaveLength(4)
    t += 5 * 60_000 + 1
    await reader.get(WIRED, "4164", "b")
    expect(calls).toHaveLength(6)
    t += 7 * 24 * 3600_000
    await reader.get(WIRED, "4164", "b")
    expect(calls).toHaveLength(9)
  })

  it("reads no rank for a collection without rarity, and treats a 404 offer or listing as none", async () => {
    const nft = fixture()
    nft.nft.rarity = null
    route = (p) => (p.includes("/offers/") || p.includes("/listings/") ? json({}, 404) : json(nft))
    expect(await reader.get(WIRED, "4164", null)).toMatchObject({
      rank: null,
      bestOffer: null,
      listed: null,
      partial: false,
    })
  })

  it("marks the data partial when an offer or listing read fails", async () => {
    route = (p) => (p.includes("/offers/") ? json({}, 500) : okRoute()(p))
    expect(await reader.get(WIRED, "4164", null)).toMatchObject({
      bestOffer: null,
      listed: BigInt(eth(0.0019)),
      partial: true,
    })
  })

  it("returns unavailable within about 5 seconds when the budget would take longer", async () => {
    await sql`update indexer.opensea_budget set tokens = 0`
    const start = Date.now()
    expect(await reader.get(WIRED, "4164", null)).toBe("unavailable")
    expect(Date.now() - start).toBeLessThan(6000)
    expect(calls).toEqual([])
  })

  it("blocks every process after a 429", async () => {
    route = () => json({}, 429, { "retry-after": "30" })
    expect(await reader.get(WIRED, "4164", null)).toBe("unavailable")
    const [b] = await sql<
      { ms: number }[]
    >`select extract(epoch from blocked_until - now())::int * 1000 as ms from indexer.opensea_budget`
    expect(b!.ms).toBeGreaterThan(25_000)
    expect(b!.ms).toBeLessThanOrEqual(30_000)
  })

  it("never logs the key, even when a request fails with it in the message", async () => {
    route = () => {
      throw new Error(`connect failed for key ${KEY}`)
    }
    expect(await reader.get(WIRED, "4164", null)).toBe("unavailable")
    route = () => json({}, 401)
    await reader.get(WIRED, "1", null)
    expect(JSON.stringify(log.mock.calls)).not.toContain(KEY)
    expect(log.mock.calls.some((c) => c[1] === "opensea key rejected")).toBe(true)
  })

  it("lists trending collections for a timeframe and caches them for 10 minutes", async () => {
    expect(await reader.trending("one_day")).toEqual([
      { slug: "wiredonink", name: "WIRED" },
      { slug: "elsewhere", name: "Elsewhere" },
    ])
    await reader.trending("one_day")
    expect(calls).toEqual(["/collections/trending?chains=ink&timeframe=one_day&limit=20"])
    t += 10 * 60_000 + 1
    await reader.trending("one_day")
    expect(calls).toHaveLength(2)
    await reader.trending("one_hour")
    expect(calls).toHaveLength(3)
  })
})

describe("NFT card", () => {
  let h: ReturnType<typeof harness>
  let state: NftState
  let img: ReturnType<typeof testImages>
  const kbOf = (p: Payload | undefined) =>
    (p?.reply_markup?.inline_keyboard ?? []) as {
      text: string
      url?: string
      callback_data?: string
    }[][]

  async function boot(withReader: ItemReader | undefined = reader) {
    img = testImages()
    const ids = await insertEvents(sql, [
      nftCollection({
        contract: WIRED,
        name: "WIRED",
        slug: "wiredonink",
        safelist: "verified",
        maxRank: 999,
      }),
      nftStats({ contract: WIRED }),
      nftSale({
        contract: WIRED,
        tokenId: "4164",
        priceWei: eth(0.0015),
        blockTimestamp: Date.UTC(2026, 9, 12) / 1000,
      }),
    ])
    state = await loadNftState(sql, ids.at(-1)!)
    h = harness(
      createBot({
        token: "1:test",
        botInfo: BOT_INFO,
        sql,
        prices,
        log: () => {},
        report: vi.fn(),
        linksBase: "https://go.makobot.xyz",
        images: img.images,
        nft: () => state,
        now: () => NOW,
        ...(withReader ? { items: withReader } : {}),
      }),
    )
  }

  it("renders rank, offers, last sale and traits in the card layout", async () => {
    await boot()
    await h.text("/nft wiredonink 4164")
    const m = h.last("sendPhoto") ?? h.last("sendMessage")!
    const text = (m.caption ?? m.text) as string
    expect(text.split("\n").slice(0, 8)).toEqual([
      "<b>WIRED ✓ #4164 · OpenSea</b>",
      "",
      // The labels pad to two past the longest ("breed inspiration" in this item's traits).
      `<code>${"rank".padEnd(19)}752 / 999</code>`,
      `<code>${"best offer".padEnd(19)}0.0011 ETH ($2.75)</code>`,
      `<code>${"listed".padEnd(19)}0.0019 ETH ($4.75)</code>`,
      `<code>${"last sold".padEnd(19)}0.0015 ETH · Oct 12</code>`,
      `<code>${"cat".padEnd(19)}Whisper</code>`,
      `<code>${"aura".padEnd(19)}Poltergeist</code>`,
    ])
    expect(text).toContain(`CA   <code>${WIRED}</code>`)
    expect(text).not.toContain("unavailable")
    expect(kbOf(m)).toEqual([
      [
        { text: "View", url: `https://go.makobot.xyz/n/i/${WIRED}/4164` },
        { text: "Collection", callback_data: `nc:${WIRED}` },
      ],
    ])
  })

  it("says there is no rarity rank when OpenSea has none", async () => {
    const nft = fixture()
    nft.nft.rarity = null
    route = okRoute(nft)
    await boot()
    await h.text("/nft wiredonink 4164")
    const text = (h.last("sendPhoto")!.caption ?? "") as string
    expect(text).toContain("No rarity rank on OpenSea for this collection.")
    expect(text).not.toContain("<code>rank")
  })

  it("shows what MAKO has and a line about the rest when OpenSea cannot be reached", async () => {
    route = () => json({}, 500)
    await boot()
    await h.text("/nft wiredonink 4164")
    const text = (h.last("sendPhoto")!.caption ?? h.last("sendMessage")!.text) as string
    expect(text).toContain("<code>last sold  0.0015 ETH · Oct 12</code>")
    expect(text).toContain("Some details are unavailable right now.")
    expect(text).not.toContain("<code>rank")
  })

  it("does the same without an OpenSea key", async () => {
    await boot(null as unknown as undefined)
    await h.text("/nft wiredonink 4164")
    expect(h.last("sendPhoto")!.caption as string).toContain(
      "Some details are unavailable right now.",
    )
    expect(calls).toEqual([])
  })

  it("opens from a pasted item link and from the pick-list callback", async () => {
    await boot()
    await h.text(`https://opensea.io/item/ink/${WIRED}/4164`)
    expect(h.last("sendPhoto")!.caption).toContain("<b>WIRED ✓ #4164 · OpenSea</b>")
    h.clear()
    await h.tap(`ni:${WIRED}:77`)
    expect(h.last("sendPhoto")!.caption).toContain("#77")
  })

  it("makes no call and spends no token inside the cooldown", async () => {
    await boot()
    await h.text("/nft wiredonink 4164")
    const before = calls.length
    const [first] = await sql<{ tokens: number }[]>`select tokens from indexer.opensea_budget`
    const tokens = first!.tokens
    h.clear()
    await h.text("/nft wiredonink 4164")
    expect(calls.length).toBe(before)
    expect(h.last("sendPhoto")).toBeUndefined()
    expect(h.last("sendMessage")!.text).toMatch(/^Up to date, try again in \d+s$/)
    const [after] = await sql<{ tokens: number }[]>`select tokens from indexer.opensea_budget`
    expect(after!.tokens).toBeGreaterThanOrEqual(tokens)
  })
  it("lists trending collections that MAKO knows, with the timeframe buttons and Back", async () => {
    await boot()
    await h.tap("nl:t24")
    const m = h.last("editMessageText")!
    expect(m.text).toBe("<b>Trending</b>")
    const kb = kbOf(m)
    expect(kb[0]).toEqual([
      { text: "1h", callback_data: "nl:t1" },
      { text: "24h", callback_data: "nl:t24", style: "success" },
      { text: "7d", callback_data: "nl:t7" },
    ])
    expect(kb[1]![0]!.text).toMatch(/^WIRED · .* floor$/)
    expect(kb[1]![0]!.callback_data).toBe(`nc:${WIRED}:t24`)
    expect(kb.at(-1)).toEqual([{ text: "Back", callback_data: "nfts" }])
    expect(kb).toHaveLength(3)
  })

  it("says so when nothing is trending or OpenSea cannot be reached", async () => {
    route = () => json({ collections: [] })
    await boot()
    await h.tap("nl:t1")
    expect(h.last("editMessageText")!.text).toBe(
      "<b>Trending</b>\nNo Ink collections are trending in this timeframe.",
    )
    route = () => json({}, 500)
    await h.tap("nl:t7")
    expect(h.last("editMessageText")!.text).toBe(
      "<b>Trending</b>\nTrending isn't available right now. Try again in a few minutes.",
    )
  })

  it("explains /nft with nothing after it", async () => {
    await boot()
    await h.text("/nft")
    expect(h.last("sendMessage")!.text).toBe(
      "Look up NFTs by providing a name or contract address.\n/nft wired\n/nft 0x7c701c0148e0e965065aa05e008ac9341e6efc6c",
    )
  })
})

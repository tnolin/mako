import type { NftEvent } from "@ink-indexer/events"
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest"
import type { Sql } from "../src/db"
import type { Row } from "../src/history"
import type { NftAlertCard } from "../src/nft/card"
import { marketRules } from "../src/nft/rules/market"
import { createNftState, type NftState } from "../src/nft/state"
import type { Prices } from "../src/prices"
import type { Candidate } from "../src/rules/index"
import { insertEvents, resetDb } from "./helpers/db"
import {
  addr,
  hash,
  NATIVE,
  nftCollection,
  nftListing,
  nftSale,
  nftStats,
  T0,
} from "./helpers/events"

const milli = (n: number) => String(BigInt(Math.round(n * 1e9)) * 10n ** 9n)
const C = addr(0xc0)
const prices: Prices = { usd: (q) => (q === NATIVE ? 2400 : null), symbol: () => "ETH" }
let sql: Sql
let state: NftState
let now = T0 + 120
let n = 0
beforeEach(async () => {
  await sql?.end()
  sql = await resetDb(inject("databaseUrl"))
  state = createNftState()
  n = 0
  now = T0 + 120
  state.apply({ id: String(++n), p: nftCollection({ name: "PRTSCN", safelist: "verified" }) })
})
afterAll(() => sql.end())

/** The poller's order: apply to the state, store the event (SWEEP reads it back), then run the rules. */
async function run(p: NftEvent, nowS = now, p2: Prices = prices): Promise<Candidate[]> {
  const [id] = await insertEvents(sql, [p])
  const ev = { id: id!, p } as Row<NftEvent>
  state.apply(ev)
  return marketRules(ev as never, { sql, prices: p2, log: () => {}, nft: state, now: () => nowS })
}
const card = (c: Candidate | undefined) => c!.card as NftAlertCard
const rows = (c: Candidate | undefined) => card(c).rows.map(([l, v]) => `${l}|${v}`)
const by = (cs: Candidate[], alert: string) => cs.find((c) => c.alert === alert)

describe("UNDER FLOOR", () => {
  const under = (o = {}) =>
    nftListing({
      itemName: "PRTSCN #4405",
      priceWei: milli(0.032),
      floorWei: milli(0.042),
      floorAt: T0,
      expiresAt: T0 + 120 + 6 * 3600,
      rank: 3232,
      maxRank: 4440,
      ...o,
    })

  it("fires 24% under a fresh floor, titled with the actual discount, with the expected rows", async () => {
    const cs = await run(under({ tokenId: "4405" }))
    const c = by(cs, "under")!
    expect(c).toMatchObject({
      alert: "under",
      target: C,
      priority: 3,
      eventTs: T0 + 60,
      feedEligible: true,
      discountBps: 2380,
      dedupeKey: `list:${C}:4405:${milli(0.032)}`,
    })
    expect(card(c)).toMatchObject({
      title: "UNDER FLOOR 24%",
      name: "PRTSCN",
      verified: true,
      tokenId: "4405",
    })
    expect(rows(c)).toEqual([
      "item|PRTSCN #4405",
      "price|0.032 ETH ($77)",
      "floor|0.042 ETH",
      "rank|3,232 / 4,440",
      "expires|in 6h",
    ])
    expect(by(cs, "rare")).toBeUndefined()
  })

  it("is skipped with a floor older than 2 hours or none, a discount under 10%, or a short life", async () => {
    expect(by(await run(under({ floorAt: T0 - 7200 })), "under")).toBeUndefined()
    expect(by(await run(under({ floorAt: T0 + 60 - 7201 })), "under")).toBeUndefined()
    expect(by(await run(under({ floorWei: null, floorAt: null })), "under")).toBeUndefined()
    expect(by(await run(under({ priceWei: milli(0.039) })), "under")).toBeUndefined()
    expect(by(await run(under({ expiresAt: T0 + 60 + 3599 })), "under")).toBeUndefined()
    expect(by(await run(under({ expiresAt: T0 + 60 + 3600 })), "under")).toBeDefined()
  })

  it("names the item from the collection when the listing has no name, and omits rank when unknown", async () => {
    const c = by(
      await run(under({ itemName: null, tokenId: "9", rank: null, maxRank: null })),
      "under",
    )
    expect(rows(c).slice(0, 1)).toEqual(["item|PRTSCN #9"])
    expect(rows(c).map((r) => r.split("|")[0])).toEqual(["item", "price", "floor", "expires"])
  })

  it("drops a listing after 3 minutes in the queue", async () => {
    expect(await run(under(), T0 + 60 + 181)).toEqual([])
    expect((await run(under(), T0 + 60 + 179)).length).toBeGreaterThan(0)
  })

  it("leaves the dollars out when no price is fresh", async () => {
    const c = by(await run(under(), now, { usd: () => null, symbol: () => "ETH" }), "under")
    expect(rows(c)[1]).toBe("price|0.032 ETH")
  })
})

describe("RARE LISTING", () => {
  const rare = (o = {}) =>
    nftListing({
      itemName: "PRTSCN #77",
      priceWei: milli(0.044),
      floorWei: milli(0.042),
      floorAt: T0,
      expiresAt: T0 + 120 + 6 * 3600,
      rank: 41,
      maxRank: 4440,
      ...o,
    })

  it("needs a rank, and shows the top share and the floor premium", async () => {
    const cs = await run(rare())
    const c = by(cs, "rare")!
    expect(c).toMatchObject({ alert: "rare", priority: 2, rankBps: 93 })
    expect(card(c).title).toBe("RARE LISTING")
    expect(rows(c)).toEqual([
      "item|PRTSCN #77",
      "rank|41 / 4,440 (top 1%)",
      "price|0.044 ETH ($106)",
      "floor|0.042 ETH (+5%)",
      "expires|in 6h",
    ])
    expect(by(await run(rare({ rank: null, maxRank: null })), "rare")).toBeUndefined()
  })

  it("is not rare above 10% over the floor or outside the top 10%", async () => {
    expect(by(await run(rare({ priceWei: milli(0.047) })), "rare")).toBeUndefined()
    expect(by(await run(rare({ priceWei: milli(0.0462) })), "rare")).toBeDefined()
    expect(by(await run(rare({ rank: 445 })), "rare")).toBeUndefined()
    expect(by(await run(rare({ rank: 444 })), "rare")?.rankBps).toBe(1000)
  })

  it("shares one dedupe key with UNDER FLOOR, and a rare listing under the floor shows the discount", async () => {
    const cs = await run(rare({ priceWei: milli(0.037) }))
    const r = by(cs, "rare")!
    const u = by(cs, "under")!
    expect(r.dedupeKey).toBe(u.dedupeKey)
    expect(r.priority).toBeLessThan(u.priority)
    expect(rows(r)).toContain("floor|0.042 ETH (−12%)")
  })

  it("yields nothing for a listing that is neither rare nor under the floor", async () => {
    expect(await run(rare({ rank: null, maxRank: null, priceWei: milli(0.042) }))).toEqual([])
  })
})

describe("FLOOR UP / DOWN", () => {
  const stats = (o = {}) =>
    nftStats({
      floorWei: milli(0.427),
      floor24hAgoWei: milli(0.562),
      owners: 212,
      volume24hWei: milli(2.86),
      sales24h: 4,
      blockTimestamp: T0 + 60,
      ...o,
    })

  it("fires on a 24% drop with the expected rows", async () => {
    const [c] = await run(stats())
    expect(c).toMatchObject({
      alert: "floor",
      priority: 4,
      floorDir: "down",
      floorBps: 2402,
      dedupeKey: `floor:${C}:down:${Math.floor((T0 + 60) / 21600)}`,
    })
    expect(card(c).title).toBe("FLOOR DOWN 24%")
    expect(rows(c)).toEqual([
      "floor|0.427 ETH ($1.0K)",
      "24h ago|0.562 ETH",
      "volume|2.86 ETH ($6.9K) (24h)",
      "sales|4 (24h)",
      "holders|212",
    ])
  })

  it("fires up, and not at 9%, with no 24h-ago floor, or after 30 minutes", async () => {
    const [up] = await run(stats({ floorWei: milli(0.7), floor24hAgoWei: milli(0.5) }))
    expect(up!.floorDir).toBe("up")
    expect(card(up).title).toBe("FLOOR UP 40%")
    expect(await run(stats({ floorWei: milli(0.545), floor24hAgoWei: milli(0.5) }))).toEqual([])
    expect(await run(stats({ floor24hAgoWei: null }))).toEqual([])
    expect(await run(stats({ floorWei: null }))).toEqual([])
    expect(await run(stats(), T0 + 60 + 1801)).toEqual([])
  })
})

describe("SWEEP", () => {
  const buyer = addr(0xb1)
  const sale = (i: number, o = {}) =>
    nftSale({
      buyer,
      tokenId: String(100 + i),
      blockTimestamp: T0 + i * 40,
      priceWei: milli(0.0016),
      floorWei: milli(0.0016),
      txHash: hash(0x500 + i),
      ...o,
    })

  it("fires at the 5th item in 10 minutes, with the same key at the 6th", async () => {
    let last: Candidate[] = []
    for (let i = 0; i < 4; i++) expect(by(await run(sale(i), T0 + i * 40), "sweep")).toBeUndefined()
    last = await run(sale(4), T0 + 160)
    const c = by(last, "sweep")!
    expect(c).toMatchObject({ alert: "sweep", priority: 3, sweepItems: 5, target: C })
    expect(c.dedupeKey).toBe(`sweep:${C}:${buyer}:${Math.floor(T0 / 3600)}`)
    expect(card(c).title).toBe("SWEEP")
    expect(rows(c)).toEqual([
      "buyer|0x0000…00b1",
      "bought|5 items in 2m",
      "spent|0.008 ETH ($19) · avg 0.0016 ETH",
      "floor|0.0016 ETH",
    ])
    const sixth = by(await run(sale(5), T0 + 200), "sweep")!
    expect(sixth.dedupeKey).toBe(c.dedupeKey)
    expect(sixth.sweepItems).toBe(6)
  })

  it("counts only the last 10 minutes and one buyer's items in one collection", async () => {
    for (let i = 0; i < 4; i++) await run(sale(i, { blockTimestamp: T0 + i * 300 }), T0 + i * 300)
    // Four sales spread over 15 minutes, then a 5th: only those within 600 s of it count.
    const c = by(await run(sale(4, { blockTimestamp: T0 + 1500 }), T0 + 1500), "sweep")
    expect(c).toBeUndefined()
    await run(sale(5, { buyer: addr(0xb2), blockTimestamp: T0 + 1501 }), T0 + 1501)
    expect(
      by(
        await run(sale(6, { contract: addr(0xc9), blockTimestamp: T0 + 1502 }), T0 + 1502),
        "sweep",
      ),
    ).toBeUndefined()
  })

  it("is dropped after 30 minutes", async () => {
    for (let i = 0; i < 4; i++) await run(sale(i), T0 + 5000)
    expect(by(await run(sale(4), T0 + 5000), "sweep")).toBeUndefined()
  })
})

describe("SOLD and BIG SALE", () => {
  const sold = (o = {}) =>
    nftSale({
      itemName: "INKverse #219",
      priceWei: milli(0.0069),
      floorWei: milli(0.0055),
      rank: 866,
      maxRank: 999,
      buyer: addr(0x12ab34cd),
      seller: addr(0x9f3e07aa),
      blockTimestamp: T0 + 60,
      ...o,
    })

  it("yields a SOLD candidate carrying the price, with the expected rows", async () => {
    const cs = await run(sold())
    const c = by(cs, "sale")!
    expect(c).toMatchObject({
      alert: "sale",
      priority: 5,
      salePriceWei: BigInt(milli(0.0069)),
      target: C,
    })
    expect(c.dedupeKey).toMatch(/^sale:0x[0-9a-f]+:\d+:1$/)
    expect(card(c).title).toBe("SOLD")
    expect(rows(c)).toEqual([
      "item|INKverse #219",
      "price|0.0069 ETH ($17)",
      "floor|0.0055 ETH (+25%)",
      "rank|866 / 999",
      "buyer|0x0000…34cd",
      "seller|0x0000…07aa",
    ])
    expect(by(cs, "bigsale")).toBeUndefined()
  })

  it("leaves floor and rank out when unknown", async () => {
    const c = by(await run(sold({ floorWei: null, rank: null, maxRank: null })), "sale")
    expect(rows(c).map((r) => r.split("|")[0])).toEqual(["item", "price", "buyer", "seller"])
  })

  it("yields BIG SALE from 0.05 ETH, with the floor multiple and no seller", async () => {
    const cs = await run(
      sold({
        itemName: "PRTSCN #1755",
        priceWei: milli(0.72),
        floorWei: milli(0.562),
        rank: 796,
        maxRank: 877,
      }),
    )
    const c = by(cs, "bigsale")!
    expect(c).toMatchObject({
      alert: "bigsale",
      priority: 3,
      salePriceWei: BigInt(milli(0.72)),
      feedEligible: true,
    })
    expect(card(c).title).toBe("BIG SALE")
    expect(rows(c)).toEqual([
      "item|PRTSCN #1755",
      "price|0.72 ETH ($1.7K)",
      "floor|0.562 ETH (1.3x)",
      "rank|796 / 877",
      "buyer|0x0000…34cd",
    ])
    expect(by(cs, "sale")).toBeDefined()
    expect(by(await run(sold({ priceWei: milli(0.05) })), "bigsale")).toBeDefined()
    expect(by(await run(sold({ priceWei: milli(0.049) })), "bigsale")).toBeUndefined()
  })

  it("marks a BIG SALE of a collection that does not pass the checks as not feed-eligible", async () => {
    state.apply({ id: String(++n), p: nftCollection({ verdict: "filtered" }) })
    const c = by(await run(sold({ priceWei: milli(0.2) })), "bigsale")
    expect(c!.feedEligible).toBe(false)
  })

  it("uses the item image and falls back to the collection image", async () => {
    expect(
      card(by(await run(sold({ imageUrl: "https://i.example/item.png" })), "sale")).imageUrl,
    ).toBe("https://i.example/item.png")
    expect(card(by(await run(sold()), "sale")).imageUrl).toBe("https://i.example/hornet.png")
  })

  it("is dropped after 30 minutes", async () => {
    expect(await run(sold(), T0 + 60 + 1801)).toEqual([])
  })
})

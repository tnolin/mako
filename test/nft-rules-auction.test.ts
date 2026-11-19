import type { NftAuctionEvent, NftEvent } from "@ink-indexer/events"
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest"
import type { Sql } from "../src/db"
import type { Row } from "../src/history"
import type { NftAlertCard } from "../src/nft/card"
import { BID_RAISE_GAP_S } from "../src/nft/policy"
import { auctionRules, bidRaiseWalk, endingSoonCard } from "../src/nft/rules/auction"
import { mintRules } from "../src/nft/rules/mint"
import { createNftState, loadNftState, type NftState } from "../src/nft/state"
import type { Prices } from "../src/prices"
import { type Candidate, rulesFor } from "../src/rules/index"
import { insertEvents, resetDb } from "./helpers/db"
import { hash, NATIVE } from "./helpers/events"
import { loadNftx } from "./helpers/fixtures"

const fx = loadNftx()
const { inktrons: A } = fx
const LD = fx.lilDudes.collection.contract
const AU = A.created.auction
const H = 3600
const prices: Prices = { usd: (q) => (q === NATIVE ? 2400 : null), symbol: () => "ETH" }
const real = fx.lilDudes.collection
const card = (c: Candidate | undefined) => c!.card as NftAlertCard
const rows = (c: Candidate | undefined) => card(c).rows.map(([l, v]) => `${l}|${v}`)
const only = (cs: Candidate[]) => {
  expect(cs).toHaveLength(1)
  return cs[0]!
}

let sql: Sql
let state: NftState
let n = 0
beforeEach(async () => {
  await sql?.end()
  sql = await resetDb(inject("databaseUrl"))
  state = createNftState()
  n = 0
  state.apply({ id: String(++n), p: real })
})
afterAll(() => sql.end())

/** The poller's order: store the event, apply it to the state, then run the rules. */
async function run(p: NftAuctionEvent, nowS: number, st: NftState = state): Promise<Candidate[]> {
  const [id] = await insertEvents(sql, [p])
  const ev = { id: id!, p } as Row<NftAuctionEvent>
  st.apply(ev)
  return auctionRules(ev, { sql, prices, log: () => {}, nft: st, now: () => nowS })
}

describe("UPCOMING AUCTION", () => {
  it("created gives UPCOMING AUCTION · NFTX with starts Nov 5 13:00 UTC (in 13h 9m), ends, supply 1,100 NFTs and min bid 0.0001 ETH ($0.24)", async () => {
    const c = only(await run(A.created, A.created.blockTimestamp))
    expect(c).toMatchObject({
      alert: "upcoming",
      target: LD,
      dedupeKey: `auction:${AU}:upcoming`,
      priority: 3,
      eventTs: A.created.blockTimestamp,
      feedEligible: true,
    })
    expect(c.separate).toBeUndefined()
    expect(card(c)).toMatchObject({
      title: "UPCOMING AUCTION",
      name: "Lil Dudes",
      marketplace: "NFTX",
      link: "nftx",
      nftxSlug: "lil-dudes",
      extra: [],
      contract: LD,
    })
    expect(rows(c)).toEqual([
      "starts|Nov 5 13:00 UTC (in 13h 9m)",
      "ends|Nov 6 13:00 UTC",
      "supply|1,100 NFTs",
      "min bid|0.0001 ETH ($0.24)",
    ])
  })

  it("gives nothing when the start is under 10 minutes ahead", async () => {
    const at = (t: number, i: number) => ({
      ...A.created,
      blockTimestamp: t,
      txHash: hash(0x100 + i),
    })
    const soon = at(A.created.startsAt - 599, 1)
    expect(await run(soon, soon.blockTimestamp)).toEqual([])
    const ten = at(A.created.startsAt - 600, 2)
    expect(await run(ten, ten.blockTimestamp)).toHaveLength(1)
  })

  it("is dropped after 30 minutes in the queue", async () => {
    expect(await run(A.created, A.created.blockTimestamp + 1801)).toEqual([])
  })

  it("carries the collection's links, and the other auction cards carry none", async () => {
    const links = { twitter: "@dudes", website: "https://dudes.example", discord: null }
    state.apply({ id: String(++n), p: { ...real, links } })
    const up = only(await run(A.created, A.created.blockTimestamp))
    expect(card(up).links.map((l) => l.label)).toEqual(["X", "Website"])
    const live = only(await run(A.live, A.live.blockTimestamp))
    expect(card(live).links.map((l) => l.label)).toEqual(["X", "Website"])
    const ended = only(await run(A.ended, A.ended.blockTimestamp + 60))
    expect(card(ended).links).toEqual([])
  })

  it("reads the collection's name from the NFTX open when OpenSea has none", async () => {
    // With neither a page nor an open the name is the short contract.
    const bare = createNftState()
    bare.apply({ id: "1", p: { ...real, name: null, imageUrl: null } })
    const none = only(await run(A.created, A.created.blockTimestamp, bare))
    expect(card(none).name).toBe("0x2538…c373")
    state.apply({ id: String(++n), p: { ...real, name: null, imageUrl: null } })
    state.apply({ id: String(++n), p: fx.lilDudes.launch })
    expect(card(only(await run(A.live, A.live.blockTimestamp))).name).toBe("Lil Dudes")
  })
})

describe("rulesFor", () => {
  it("sends an nft.auction event to the auction rules", async () => {
    const [id] = await insertEvents(sql, [A.live])
    const ev = { id: id!, p: A.live } as Row<NftAuctionEvent>
    state.apply(ev)
    const cs = await rulesFor(ev, {
      sql,
      prices,
      log: () => {},
      nft: state,
      now: () => A.live.blockTimestamp,
    })
    expect(cs.map((c) => c.dedupeKey)).toEqual([`auction:${AU}:live`])
  })
})

describe("AUCTION LIVE", () => {
  it("live gives AUCTION LIVE with Remind me and ends Nov 6 13:00 UTC (in 1d)", async () => {
    const c = only(await run(A.live, A.live.blockTimestamp))
    expect(c).toMatchObject({
      alert: "mintstart",
      dedupeKey: `auction:${AU}:live`,
      priority: 2,
      eventTs: A.live.blockTimestamp,
      feedEligible: true,
    })
    expect(card(c)).toMatchObject({ title: "AUCTION LIVE", marketplace: "NFTX", remind: true })
    expect(rows(c)).toEqual([
      "min bid|0.0001 ETH ($0.24)",
      "ends|Nov 6 13:00 UTC (in 1d)",
      "supply|1,100 NFTs",
    ])
  })

  it("is dropped after 3 minutes in the queue", async () => {
    expect(await run(A.live, A.live.blockTimestamp + 181)).toEqual([])
    expect(await run({ ...A.live, txHash: hash(2) }, A.live.blockTimestamp + 179)).toHaveLength(1)
  })

  it("created after the start gives AUCTION LIVE stamped now with key auction:<a>:live, and the later live phase sends nothing more", async () => {
    const now = A.created.startsAt + 60
    const c = only(await run(A.created, now))
    expect(c).toMatchObject({
      alert: "mintstart",
      dedupeKey: `auction:${AU}:live`,
      eventTs: now,
      feedEligible: true,
    })
    expect(card(c)).toMatchObject({ title: "AUCTION LIVE", remind: true })
    expect(rows(c)[1]).toBe("ends|Nov 6 13:00 UTC (in 23h 59m)")
    // The live phase that follows carries the same key, so the delivery table keeps it from going out twice.
    const later = only(await run(A.live, now))
    expect(later.dedupeKey).toBe(c.dedupeKey)
  })

  it("created after endsAt gives nothing", async () => {
    expect(await run(A.created, A.created.endsAt + 1)).toEqual([])
  })
})

describe("AUCTION ENDED", () => {
  it("gives AUCTION ENDED with price 0.0001 ETH ($0.24) per NFT, sold 101 / 1,100 (9%), raised 0.0102 ETH ($24), bidders 11 and claims from 13:05 UTC", async () => {
    const c = only(await run(A.ended, A.ended.blockTimestamp + 60))
    expect(c).toMatchObject({
      alert: "soldout",
      dedupeKey: `auction:${AU}:ended`,
      priority: 1,
      eventTs: A.ended.blockTimestamp,
      feedEligible: true,
    })
    expect(card(c)).toMatchObject({ title: "AUCTION ENDED", marketplace: "NFTX", link: "nftx" })
    expect(rows(c)).toEqual([
      "price|0.0001 ETH ($0.24) per NFT",
      "sold|101 / 1,100 (9%)",
      "raised|0.0102 ETH ($24)",
      "bidders|11",
      "claims|from 13:05 UTC",
    ])
  })

  it("a failed auction gives result minimum not raised, bids refunded and raised <raised> / <required> ETH (synthetic)", async () => {
    const failed = {
      ...A.ended,
      graduated: false,
      cleared: "0",
      raisedWei: "4100000000000000000",
      requiredRaiseWei: "10000000000000000000",
      bidders: 52,
    }
    const c = only(await run(failed, failed.blockTimestamp + 60))
    expect(rows(c)).toEqual([
      "result|minimum not raised, bids refunded",
      "raised|4.1 / 10 ETH",
      "bidders|52",
    ])
  })

  it("is dropped after 30 minutes in the queue", async () => {
    expect(await run(A.ended, A.ended.blockTimestamp + 1801)).toEqual([])
  })
})

describe("MINIMUM BID RAISED", () => {
  const T = A.live.blockTimestamp
  /** A `price` phase on the INKTRONS auction (synthetic: the recorded one never raised the minimum bid). */
  const bid = (i: number, wei: bigint | number, at: number, o: Partial<NftAuctionEvent> = {}) => ({
    ...A.price,
    txHash: hash(0x500 + i),
    logIndex: i,
    blockNumber: String(60385228 + i * 100),
    blockTimestamp: at,
    clearingPriceWei: String(wei),
    bidders: 3 + i,
    raisedWei: String(10n ** 17n * BigInt(i + 1)),
    ...o,
  })
  const start = BigInt(A.price.minBidWei)

  it("fires at +25% over the starting minimum bid and reads (+25%)", async () => {
    const p = bid(1, 125_000_000_000_000n, T + 600)
    const c = only(await run(p, p.blockTimestamp))
    expect(c).toMatchObject({
      alert: "minted",
      bidRaise: true,
      dedupeKey: `auction:${AU}:raise:${p.blockNumber}`,
      eventTs: p.blockTimestamp,
      feedEligible: false,
    })
    expect(c.markBps).toBeUndefined()
    expect(card(c)).toMatchObject({ title: "MINIMUM BID RAISED", marketplace: "NFTX", links: [] })
    expect(rows(c)).toEqual([
      "min bid|0.000125 ETH ($0.30) (+25%)",
      "bidders|4",
      "raised|0.2 ETH ($480)",
      "ends|in 23h 50m",
    ])
  })

  it("does not fire at +24%", async () => {
    const p = bid(1, (start * 124n) / 100n, T + 600)
    expect(await run(p, p.blockTimestamp)).toEqual([])
  })

  it("does not fire twice within 30 minutes, and fires on the next price event after the gap against the last alerted bid", async () => {
    const t1 = T + 600
    const first = bid(1, 125_000_000_000_000n, t1)
    const inside = bid(2, 160_000_000_000_000n, t1 + 600)
    const after = bid(3, 160_000_000_000_000n, t1 + BID_RAISE_GAP_S)
    expect(only(await run(first, t1)).dedupeKey).toContain(":raise:")
    expect(await run(inside, inside.blockTimestamp)).toEqual([])
    const c = only(await run(after, after.blockTimestamp))
    expect(c.dedupeKey).toBe(`auction:${AU}:raise:${after.blockNumber}`)
    // The step is measured from the last alerted bid: 1.28x the 0.000125 ETH, not from the start.
    const noGap = bid(4, 190_000_000_000_000n, after.blockTimestamp + BID_RAISE_GAP_S)
    expect(await run(noGap, noGap.blockTimestamp)).toEqual([])
  })

  it("the second alert at 1.6x the start reads (+60%), measured from the start", async () => {
    const t1 = T + 600
    await run(bid(1, 125_000_000_000_000n, t1), t1)
    const p = bid(2, 160_000_000_000_000n, t1 + BID_RAISE_GAP_S + 1)
    expect(rows(only(await run(p, p.blockTimestamp)))[0]).toBe("min bid|0.00016 ETH ($0.38) (+60%)")
  })

  it("is dropped after 30 minutes in the queue", async () => {
    const p = bid(1, 125_000_000_000_000n, T + 600)
    expect(await run(p, p.blockTimestamp + 1801)).toEqual([])
  })

  it("ends reads in <x> (synthetic price events on the INKTRONS auction)", async () => {
    const p = bid(1, 125_000_000_000_000n, A.live.endsAt - 9 * H - 12 * 60)
    expect(rows(only(await run(p, p.blockTimestamp))).at(-1)).toBe("ends|in 9h 12m")
  })

  it("replaying the same price events after a state reload fires the same events and no others", async () => {
    const t1 = T + 600
    const events = [
      bid(1, 125_000_000_000_000n, t1),
      bid(2, 160_000_000_000_000n, t1 + 600),
      bid(3, 160_000_000_000_000n, t1 + BID_RAISE_GAP_S),
      bid(4, 200_000_000_000_000n, t1 + BID_RAISE_GAP_S + 60),
      bid(5, 200_000_000_000_000n, t1 + 2 * BID_RAISE_GAP_S + 120),
    ]
    const [colId] = await insertEvents(sql, [real])
    const ids = await insertEvents(sql, events)
    /** Applies each event to `st` in id order and returns the keys each one fires. */
    const walk = async (st: NftState, from: number) => {
      const out: string[][] = []
      for (const [j, p] of events.slice(from).entries()) {
        const i = j + from
        st.apply({ id: ids[i]!, p })
        const cs = await auctionRules({ id: ids[i]!, p } as Row<NftAuctionEvent>, {
          sql,
          prices,
          log: () => {},
          nft: st,
          now: () => p.blockTimestamp,
        })
        out.push(cs.map((c) => c.dedupeKey))
      }
      return out
    }
    const fresh = createNftState()
    fresh.apply({ id: "0", p: real })
    const first = await walk(fresh, 0)
    expect(first.flat()).toHaveLength(3)
    // A restart rebuilds the state from the stored rows up to its cursor and walks the rest again.
    expect(await walk(await loadNftState(sql, ids[1]!), 2)).toEqual(first.slice(2))
    // And walking everything again from the collection row gives the same answer.
    expect(await walk(await loadNftState(sql, colId!), 0)).toEqual(first)
  })
})

describe("no auction card without verdict real", () => {
  it("a Thinkers copycat's auction (verdict filtered) gives no card, watched or not", async () => {
    const copycat = "0xea8fa1eb53e0465d67c9cd4e77a3f4f6f39220ea" as const
    const st = createNftState()
    st.apply({ id: "1", p: { ...real, contract: copycat, name: "Thinkers", verdict: "filtered" } })
    let i = 0
    for (const p of [A.created, A.live, A.price, A.ended]) {
      const ev = { ...p, contract: copycat, txHash: hash(0x800 + i), logIndex: i++ }
      expect(await run(ev, ev.blockTimestamp, st)).toEqual([])
    }
    // A pending collection is held back the same way.
    st.apply({ id: "2", p: { ...real, contract: copycat, verdict: "pending" } })
    expect(
      await run({ ...A.live, contract: copycat, txHash: hash(0x900) }, A.live.blockTimestamp, st),
    ).toEqual([])
  })

  it("gives nothing for an auction the state did not take (an ERC-20 currency)", async () => {
    const erc20 = { ...A.live, currency: "0x2222222222222222222222222222222222222222" as const }
    expect(await run(erc20, erc20.blockTimestamp)).toEqual([])
  })
})

describe("an event the state has replaced", () => {
  it("gives nothing", async () => {
    const [id] = await insertEvents(sql, [A.created])
    const old = { id: id!, p: A.created } as Row<NftAuctionEvent>
    state.apply(old)
    state.apply({ id: String(++n), p: A.live })
    const ctx = { sql, prices, log: () => {}, nft: state, now: () => A.created.blockTimestamp }
    expect(await auctionRules(old, ctx)).toEqual([])
  })
})

describe("catch-up when the verdict turns real", () => {
  let now = 0
  const pending = { ...real, verdict: "pending" as const, manual: false }
  const ctx = () => ({ nft: state, now: () => now, nftSince: 0, prices })
  /** The poller's order for an NFT event: apply it, then run the mint rules with the previous snapshot. */
  function process(p: NftEvent): Candidate[] {
    const ev: Row<NftEvent> = { id: String(++n), p }
    const prev = state.apply(ev)
    return mintRules(ev as never, prev, ctx())
  }
  beforeEach(() => {
    state.apply({ id: String(++n), p: pending })
  })

  it("turning real 2 hours before the start sends UPCOMING AUCTION once", () => {
    process(A.created)
    now = A.created.startsAt - 2 * H
    const c = only(process({ ...real, blockTimestamp: now }))
    expect(c).toMatchObject({
      alert: "upcoming",
      dedupeKey: `auction:${AU}:upcoming`,
      eventTs: now,
      feedEligible: true,
      separate: true,
    })
    expect(card(c)).toMatchObject({ title: "UPCOMING AUCTION", marketplace: "NFTX" })
    expect(rows(c)[0]).toBe("starts|Nov 5 13:00 UTC (in 2h)")
  })

  it("turning real during the auction sends AUCTION LIVE once", () => {
    process(A.created)
    process(A.live)
    now = A.live.startsAt + 2 * H
    const c = only(process({ ...real, blockTimestamp: now }))
    expect(c).toMatchObject({
      alert: "mintstart",
      dedupeKey: `auction:${AU}:live`,
      eventTs: now,
      separate: true,
    })
    expect(card(c)).toMatchObject({ title: "AUCTION LIVE", remind: true })
    expect(rows(c)[1]).toBe("ends|Nov 6 13:00 UTC (in 22h)")
  })

  it("turning real after the auction ended, or 5 minutes before the start with no live phase, sends nothing", () => {
    process(A.created)
    now = A.created.startsAt - 300
    expect(process({ ...real, blockTimestamp: now })).toEqual([])
    // Back to pending, then the auction ends before it turns real.
    process({ ...pending, blockTimestamp: now + 1 })
    process(A.ended)
    now = A.ended.blockTimestamp + 60
    expect(process({ ...real, blockTimestamp: now })).toEqual([])
    // An auction still showing a live phase after its end is not sent either.
    process({ ...pending, blockTimestamp: now + 1 })
    process({ ...A.live, txHash: hash(0xa1) })
    now = A.live.endsAt + 5
    expect(process({ ...real, blockTimestamp: now })).toEqual([])
  })

  it("an auction already marked ended sends no catch-up whatever its times say", () => {
    now = A.created.startsAt - 2 * H
    process({ ...A.ended, startsAt: now + H, endsAt: now + 25 * H })
    expect(process({ ...real, blockTimestamp: now })).toEqual([])
  })

  it("a second real snapshot sends no second catch-up, and a real → filtered → real flip repeats the same key", () => {
    process(A.created)
    now = A.created.startsAt - 2 * H
    const first = only(process({ ...real, blockTimestamp: now }))
    expect(process({ ...real, blockTimestamp: now + 1 })).toEqual([])
    expect(process({ ...real, verdict: "filtered", blockTimestamp: now + 2 })).toEqual([])
    const again = only(process({ ...real, blockTimestamp: now + 3 }))
    expect(again.dedupeKey).toBe(first.dedupeKey)
  })

  it("sends nothing for a collection with no auction", () => {
    now = A.created.startsAt - 2 * H
    expect(process({ ...real, blockTimestamp: now })).toEqual([])
  })
})

describe("bidRaiseWalk", () => {
  const w = (wei: number, ts: number) => ({ wei: BigInt(wei), ts })

  it("an empty list does not fire and keeps the starting bid as the base", () => {
    expect(bidRaiseWalk([], 100n)).toEqual({ fires: false, baseWei: 100n, lastFireTs: null })
  })

  it("one event at exactly +25% fires, one at +24.99% does not", () => {
    expect(bidRaiseWalk([w(125, 10)], 100n)).toEqual({ fires: true, baseWei: 125n, lastFireTs: 10 })
    expect(bidRaiseWalk([w(124, 10)], 100n)).toEqual({
      fires: false,
      baseWei: 100n,
      lastFireTs: null,
    })
  })

  it("a rise inside the gap waits, and a later one fires against the last fired bid", () => {
    const walk = [w(125, 0), w(160, 600), w(160, BID_RAISE_GAP_S)]
    expect(bidRaiseWalk(walk.slice(0, 2), 100n)).toEqual({
      fires: false,
      baseWei: 125n,
      lastFireTs: 0,
    })
    expect(bidRaiseWalk(walk, 100n)).toEqual({
      fires: true,
      baseWei: 160n,
      lastFireTs: BID_RAISE_GAP_S,
    })
  })

  it("carries the base after a fire: a later bid under +25% of it does not fire", () => {
    const walk = [w(125, 0), w(150, BID_RAISE_GAP_S + 1)]
    expect(bidRaiseWalk(walk, 100n).fires).toBe(false)
  })

  it("a starting bid of 0 does not fire on an unchanged 0", () => {
    expect(bidRaiseWalk([w(0, 5)], 0n).fires).toBe(false)
  })
})

describe("AUCTION ENDING SOON card", () => {
  it("reads ends, min bid, bidders and raised, with the dollars", () => {
    const st = state.get(LD)!
    st.auction = A.ended
    const c = endingSoonCard(
      st,
      { ...A.price, bidders: 11, raisedWei: A.ended.raisedWei },
      A.ended.endsAt - H,
      2400,
    )
    expect(c).toMatchObject({
      alert: "reminder",
      title: "AUCTION ENDING SOON",
      marketplace: "NFTX",
      link: "nftx",
      nftxSlug: "lil-dudes",
      links: [],
    })
    expect(c.rows.map(([l, v]) => `${l}|${v}`)).toEqual([
      "ends|13:00 UTC (in 1h)",
      "min bid|0.0001 ETH ($0.24)",
      "bidders|11",
      "raised|0.0102 ETH ($24)",
    ])
  })

  it("shows ETH only without a fresh price", () => {
    const c = endingSoonCard(state.get(LD)!, A.ended, A.ended.endsAt - H, null)
    expect(c.rows[1]).toEqual(["min bid", "0.0001 ETH"])
  })
})

describe("absurd numbers", () => {
  it("render without a throw or NaN: supply 0, cleared above supply, no required raise, a 78-digit price", async () => {
    const odd = {
      ...A.ended,
      supply: "0",
      cleared: "5000",
      requiredRaiseWei: "0",
      clearingPriceWei: "9".repeat(78),
      raisedWei: "9".repeat(78),
    }
    const c = only(await run(odd, odd.blockTimestamp + 60))
    for (const [, v] of card(c).rows) expect(v).not.toMatch(/NaN|undefined/)
    const failed = { ...odd, txHash: hash(0xb1), graduated: false, requiredRaiseWei: "0" }
    const f = only(await run(failed, failed.blockTimestamp + 60))
    for (const [, v] of card(f).rows) expect(v).not.toMatch(/NaN|undefined/)
    const zero = { ...A.price, txHash: hash(0xb2), minBidWei: "0", clearingPriceWei: "5" }
    const z = only(await run(zero, zero.blockTimestamp))
    for (const [, v] of card(z).rows) expect(v).not.toMatch(/NaN|undefined|Infinity/)
  })
})

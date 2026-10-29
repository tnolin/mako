import { afterAll, beforeEach, describe, expect, inject, it } from "vitest"
import type { Card } from "../src/cards/card"
import type { Sql } from "../src/db"
import { eventsAfter } from "../src/history"
import { createNftState } from "../src/nft/state"
import type { Prices } from "../src/prices"
import { type Candidate, rulesFor, swapCtx, withDevHolds } from "../src/rules/index"
import { insertEvents, resetDb } from "./helpers/db"
import { addr, bond, hash, launch, NATIVE, swap, T0, trade } from "./helpers/events"
import { loadFixture } from "./helpers/fixtures"

const prices: Prices = {
  usd: (q) => (q === NATIVE ? 2500 : null),
  symbol: (q) => (q === NATIVE ? "ETH" : "NVDAx"),
}
const warnings: string[] = []
const ctx = (sql: Sql) => ({
  sql,
  prices,
  log: (_l: string, msg: string) => void warnings.push(msg),
  nft: createNftState(),
  now: () => T0,
})
const eth = (n: number) => String(BigInt(Math.round(n * 1000)) * 10n ** 15n)
const C = addr(0xc1)
const L = launch({
  creator: C,
  txHash: hash(0x1a),
  blockTimestamp: T0,
  links: { twitter: "https://x.com/goblo", telegram: "javascript:x", website: null },
})

let sql: Sql
beforeEach(async () => {
  await sql?.end()
  sql = await resetDb(inject("databaseUrl"))
})
afterAll(() => sql.end())

/** Inserts events into a fresh database (beforeEach), runs the rules on the last one. */
async function run(events: Parameters<typeof insertEvents>[1]): Promise<Candidate[]> {
  await insertEvents(sql, events)
  const all = await eventsAfter(sql, "0")
  return rulesFor(all.at(-1)!, ctx(sql))
}
const pick = (cs: Candidate[], alert: string) => cs.find((c) => c.alert === alert)

describe("NEW TOKEN", () => {
  it("builds pair, target, dev buy in the launch tx, dev history and safe links", async () => {
    const other = addr(0xd2)
    await insertEvents(sql, [
      launch({ token: other, creator: C }),
      bond({ token: other }),
      L,
      trade({
        txHash: L.txHash,
        trader: C,
        side: "buy",
        quoteAmount: eth(0.25),
        tokenAmount: String(41n * 10n ** 24n),
      }),
    ])
    const evs = await eventsAfter(sql, "0")
    const [c] = await rulesFor(evs[2]!, ctx(sql))
    expect(c).toMatchObject({ alert: "new", dedupeKey: `new:${L.token}`, priority: 5, eventTs: T0 })
    expect(c!.card.title).toBe("NEW TOKEN")
    expect(c!.card.rows).toEqual([
      ["pair", "GOBLO/ETH"],
      ["bonds at", "3.00 ETH ($7.5K)"],
      ["dev buy", "0.25 ETH (4.1%)"],
      ["dev", "2 launches | 1 bonded"],
    ])
    expect(c!.card.links).toEqual([{ label: "X", url: "https://x.com/goblo" }])
  })

  it("leaves out the bond target for a token that starts in a pool", async () => {
    const [c] = await run([launch({ targetRaise: null, startsInPool: true, poolId: hash(9) })])
    expect(c!.card.rows.map(([label]) => label)).toEqual(["pair", "dev"])
  })
})

describe("trade rules", () => {
  it("fires BONDING at the crossed mark with 1h stats", async () => {
    const cs = await run([
      L,
      trade({ soldBps: 7000, blockTimestamp: T0 + 60, quoteAmount: eth(0.1) }),
      trade({
        soldBps: 8040,
        blockTimestamp: T0 + 120,
        quoteAmount: eth(0.5),
        trader: addr(0xe2),
        marketCap: eth(84.8),
      }),
    ])
    const b = cs.filter((c) => c.alert === "bonding")
    expect(b.map((c) => c.mark)).toEqual([8000])
    expect(b[0]!.card.title).toBe("BONDING 80%")
    expect(b[0]!.dedupeKey).toBe(`bonding:8000:${L.token}`)
    expect(b[0]!.card.rows).toEqual([
      ["curve", "■■■■■■■■□□ 80%"],
      ["mcap", "$212K"],
      ["volume", "$1.5K (1h)"],
      ["trades", "2 buys | 0 sells (1h)"],
      ["age", "2m"],
      ["dev", "0 buys | 0 sells"],
    ])
  })

  it("emits one BONDING candidate per mark crossed in one trade", async () => {
    const cs = await run([L, trade({ soldBps: 4000 }), trade({ soldBps: 9500 })])
    expect(cs.filter((c) => c.alert === "bonding").map((c) => c.mark)).toEqual([5000, 8000, 9000])
  })

  it("fires PUMPING against the launch-tx baseline for a young token", async () => {
    const cs = await run([
      L,
      trade({ txHash: L.txHash, trader: C, soldBps: 2000, blockTimestamp: T0 }),
      trade({ soldBps: 2500, blockTimestamp: T0 + 100, quoteAmount: eth(0.1) }),
      trade({ soldBps: 3600, blockTimestamp: T0 + 300, quoteAmount: eth(0.2), marketCap: eth(10) }),
    ])
    const p = pick(cs, "pumping")!
    expect(p.card.rows).toEqual([
      ["pumped", "+16% (4m)"],
      ["curve", "■■■□□□□□□□ 36%"],
      ["mcap", "$25.0K"],
      ["volume", "$750 (4m)"],
      ["trades", "2 buys | 0 sells (4m)"],
      ["age", "5m"],
    ])
  })

  it("never fires PUMPING or BIG for trades in the launch transaction", async () => {
    const cs = await run([
      L,
      trade({ txHash: L.txHash, trader: C, soldBps: 5000, quoteAmount: eth(1) }),
    ])
    expect(pick(cs, "pumping")).toBeUndefined()
    expect(pick(cs, "big")).toBeUndefined()
  })

  it("fires BIG BUY at 5% of target with the curve change", async () => {
    const cs = await run([
      L,
      trade({ soldBps: 1000 }),
      trade({ soldBps: 1500, quoteAmount: eth(0.15), blockTimestamp: T0 + 700, marketCap: eth(4) }),
    ])
    const b = pick(cs, "big")!
    expect(b.sizeBps).toBe(500)
    expect(b.card.title).toBe("BIG BUY")
    expect(b.card.rows).toEqual([
      ["bought", "0.15 ETH ($375)"],
      ["curve", "■□□□□□□□□□ 15% (+5%)"],
      ["mcap", "$10.0K"],
    ])
  })

  it("ignores trades under 2.5% of target", async () => {
    const cs = await run([L, trade({ quoteAmount: eth(0.06), blockTimestamp: T0 + 900 })])
    expect(pick(cs, "big")).toBeUndefined()
  })

  it("fires DEV SELL with average-cost PnL and asks for dev holds", async () => {
    const cs = await run([
      L,
      trade({
        txHash: L.txHash,
        trader: C,
        side: "buy",
        tokenAmount: String(10n ** 26n),
        quoteAmount: eth(1),
        soldBps: 1000,
      }),
      trade({
        trader: C,
        side: "sell",
        tokenAmount: String(5n * 10n ** 25n),
        quoteAmount: eth(2),
        soldBps: 6100,
        marketCap: eth(65.6),
        blockTimestamp: T0 + 900,
      }),
    ])
    const d = pick(cs, "devsell")!
    expect(pick(cs, "big")).toBeUndefined()
    expect(d.card.rows).toEqual([
      ["sold", "50.0M (5.0%)"],
      ["dev pnl", "+1.50 ETH (+300%)"], // 0.5 ETH cost basis of the half sold, 2 ETH proceeds
      ["dev", "1 buy | 1 sell"],
      ["curve", "■■■■■■□□□□ 61%"],
      ["mcap", "$164K"],
    ])
    expect(d.holds).toMatchObject({ token: L.token, holder: C, totalSupply: L.totalSupply })
    const filled = withDevHolds(d.card as Card, { pct: 6.8, now: true })
    expect(filled.rows[3]).toEqual(["dev holds", "6.8% (now)"])
    expect(withDevHolds(d.card as Card, { pct: 6.8, now: false }).rows[3]).toEqual([
      "dev holds",
      "6.8%",
    ])
    expect(withDevHolds(d.card as Card, null)).toBe(d.card)
  })
})

describe("BONDED", () => {
  it("summarises launch to bond and supersedes pending BONDING", async () => {
    const cs = await run([
      L,
      trade({ txHash: L.txHash, trader: C, quoteAmount: eth(1) }),
      trade({ trader: addr(0xe1), quoteAmount: eth(1) }),
      trade({ trader: addr(0xe2), quoteAmount: eth(1) }),
      trade({ trader: addr(0xe1), side: "sell", quoteAmount: eth(0.5), marketCap: eth(38.48) }),
      bond({
        blockTimestamp: T0 + 3 * 3600 + 12 * 60,
        liquidityQuote: eth(2.1),
        liquidityTokens: String(214n * 10n ** 24n),
      }),
    ])
    expect(cs).toHaveLength(1)
    expect(cs[0]).toMatchObject({
      alert: "bonded",
      dedupeKey: `bonded:${L.token}`,
      priority: 1,
      supersedesBonding: true,
    })
    expect(cs[0]!.card.rows).toEqual([
      ["age", "3h 12m"],
      ["mcap", "$96.2K"],
      ["pool", "2.10 ETH + 214M GOBLO"],
      ["volume", "$8.8K"],
      ["trades", "4"],
      ["dev", "1 buy | 0 sells"],
    ])
  })
})

describe("swap context", () => {
  it("loads the launch, bond, the last 600 s of swaps and, for the creator, the dev's history", async () => {
    await insertEvents(sql, [
      L,
      trade({ trader: C, blockTimestamp: T0 + 10 }),
      bond({ blockTimestamp: T0 + 100 }),
      swap({ blockTimestamp: T0 + 1000 }),
      swap({ blockTimestamp: T0 + 1500 }),
      swap({ trader: C, side: "sell", blockTimestamp: T0 + 2000 }),
    ])
    const evs = await eventsAfter(sql, "0")
    const s = await swapCtx(evs[5] as never, ctx(sql))
    expect(s!.launch.id).toBe(evs[0]!.id)
    expect(s!.bond!.id).toBe(evs[2]!.id)
    expect(s!.swaps.map((r) => r.id)).toEqual([evs[4]!.id, evs[5]!.id])
    expect(s!.dev!.trades.map((r) => r.id)).toEqual([evs[1]!.id])
    expect(s!.dev!.swaps.map((r) => r.id)).toEqual([evs[5]!.id])
    const other = await swapCtx(evs[4] as never, ctx(sql))
    expect(other!.dev).toBeNull()
    expect(other!.swaps.map((r) => r.id)).toEqual([evs[3]!.id, evs[4]!.id])
  })

  it("skips a swap whose launch event is missing, with a warning and no throw", async () => {
    await insertEvents(sql, [swap({ token: addr(0xbeef) })])
    const [ev] = await eventsAfter(sql, "0")
    expect(await rulesFor(ev!, ctx(sql))).toEqual([])
    expect(warnings.at(-1)).toMatch(/without a launch/)
  })
})

describe("pool trades", () => {
  const X = addr(0x943b)
  const withXstock: Prices = {
    usd: (q) => (q === NATIVE ? 2500 : q === X ? 180 : null),
    symbol: (q) => (q === NATIVE ? "ETH" : "NVDAx"),
  }
  async function runWith(p: Prices, events: Parameters<typeof insertEvents>[1]) {
    await insertEvents(sql, events)
    const all = await eventsAfter(sql, "0")
    return rulesFor(all.at(-1)!, { ...ctx(sql), prices: p })
  }
  const bonded = [L, trade({ txHash: L.txHash, trader: C }), bond()]

  it("pool BIG BUY at 5% of the quote side", async () => {
    const s = swap({ quoteAmount: eth(0.2), quoteLiquidity: eth(4.2) })
    const cs = await run([...bonded, s])
    const b = pick(cs, "big")!
    expect(b).toMatchObject({
      sizeBps: 500,
      dedupeKey: `big:${s.txHash}:${s.logIndex}`,
      target: L.token,
      priority: 4,
    })
    expect(b.card.title).toBe("BIG BUY")
    expect(b.card.rows).toEqual([
      ["bought", "0.20 ETH ($500)"],
      ["mcap", "$50.0K"],
      ["liquidity", "$21.0K"],
    ])
  })

  it("pool BIG SELL measures against the quote side before the trade", async () => {
    const cs = await run([
      ...bonded,
      swap({ side: "sell", quoteAmount: eth(0.4), quoteLiquidity: eth(3.6) }),
    ])
    const b = pick(cs, "big")!
    expect(b.sizeBps).toBe(1000)
    expect(b.card.title).toBe("BIG SELL")
    expect(b.card.rows).toEqual([
      ["sold", "0.40 ETH ($1.0K)"],
      ["mcap", "$50.0K"],
      ["liquidity", "$18.0K"],
    ])
  })

  it("no pool BIG under $500", async () => {
    const cs = await run([...bonded, swap({ quoteAmount: eth(0.1), quoteLiquidity: eth(2.1) })])
    expect(pick(cs, "big")).toBeUndefined()
  })

  it("no pool BIG under the smallest threshold", async () => {
    const cs = await run([...bonded, swap({ quoteAmount: eth(0.4), quoteLiquidity: eth(20.4) })])
    expect(pick(cs, "big")).toBeUndefined()
  })

  it("no pool BIG while ETH/USD is stale", async () => {
    const stale: Prices = { usd: () => null, symbol: () => "ETH" }
    const cs = await runWith(stale, [
      ...bonded,
      swap({ quoteAmount: eth(2), quoteLiquidity: eth(6) }),
    ])
    expect(pick(cs, "big")).toBeUndefined()
  })

  it("pool BIG BUY on an xStock-quoted pool", async () => {
    const xl = launch({ ...L, quoteAsset: X })
    const cs = await runWith(withXstock, [
      xl,
      bond({ quoteAsset: X }),
      swap({ quoteAsset: X, quoteAmount: eth(3), quoteLiquidity: eth(63) }),
    ])
    const b = pick(cs, "big")!
    expect(b.sizeBps).toBe(500)
    expect(b.card.rows).toEqual([
      ["bought", "3.00 NVDAx ($540)"],
      ["mcap", "$3.6K"],
      ["liquidity", "$22.7K"],
    ])
  })

  it("pool BIG SELL by the creator becomes DEV SELL", async () => {
    const s = swap({
      trader: C,
      side: "sell",
      tokenAmount: String(5n * 10n ** 25n),
      quoteAmount: eth(2),
      quoteLiquidity: eth(4),
      marketCap: eth(80),
    })
    const cs = await run([
      L,
      trade({
        txHash: L.txHash,
        trader: C,
        tokenAmount: String(10n ** 26n),
        quoteAmount: eth(1),
      }),
      bond(),
      s,
    ])
    expect(pick(cs, "big")).toBeUndefined()
    const d = pick(cs, "devsell")!
    expect(d).toMatchObject({ dedupeKey: `devsell:${s.txHash}:${s.logIndex}`, priority: 0 })
    expect(d.card.title).toBe("DEV SELL")
    expect(d.card.rows).toEqual([
      ["sold", "50.0M (5.0%)"],
      ["dev pnl", "+1.50 ETH (+300%)"],
      ["dev", "1 buy | 1 sell"],
      ["mcap", "$200K"],
    ])
    expect(d.holds).toEqual({
      token: L.token,
      holder: C,
      block: s.blockNumber,
      totalSupply: L.totalSupply,
    })
    expect(withDevHolds(d.card as Card, { pct: 4.2, now: false }).rows[3]).toEqual([
      "dev holds",
      "4.2%",
    ])
  })

  it("dev pnl covers curve buys and pool sells", async () => {
    const cs = await run([
      L,
      trade({ txHash: L.txHash, trader: C, tokenAmount: String(10n ** 26n), quoteAmount: eth(1) }),
      bond(),
      swap({ trader: C, tokenAmount: String(10n ** 26n), quoteAmount: eth(3) }),
      swap({ trader: addr(0xe9), side: "sell", quoteAmount: eth(1) }),
      swap({ trader: C, side: "sell", tokenAmount: String(10n ** 26n), quoteAmount: eth(6) }),
    ])
    expect(pick(cs, "devsell")!.card.rows.slice(1, 3)).toEqual([
      ["dev pnl", "+4.00 ETH (+200%)"], // 2 ETH average cost of the half sold, 6 ETH proceeds
      ["dev", "2 buys | 1 sell"],
    ])
  })

  it("a pool sell by someone else is not a DEV SELL", async () => {
    const cs = await run([...bonded, swap({ side: "sell" })])
    expect(pick(cs, "devsell")).toBeUndefined()
  })

  it("curve BIG keeps the target-raise rule", async () => {
    // 0.15 ETH is 5% of the 3 ETH target, whatever the curve's quote balance.
    const cs = await run([L, trade({ quoteAmount: eth(0.15), blockTimestamp: T0 + 700 })])
    expect(pick(cs, "big")!.sizeBps).toBe(500)
    expect(pick(cs, "big")!.card.rows.map(([k]) => k)).toEqual(["bought", "curve", "mcap"])
  })
})

describe("robustness", () => {
  it("skips a trade whose launch event is missing, with a warning and no throw", async () => {
    await insertEvents(sql, [trade({ token: addr(0xbeef) })])
    const [ev] = await eventsAfter(sql, "0")
    expect(await rulesFor(ev!, ctx(sql))).toEqual([])
    expect(warnings.at(-1)).toMatch(/without a launch/)
  })

  it("finds all 13 dev sells in the ROCKSTAR history", async () => {
    await insertEvents(sql, loadFixture("devsells-rockstar"))
    const evs = await eventsAfter(sql, "0")
    const out = (await Promise.all(evs.map((e) => rulesFor(e, ctx(sql))))).flat()
    expect(out.filter((c) => c.alert === "devsell")).toHaveLength(13)
  })

  it.each([
    ["bonded-mim", { new: 1, bonding: 4, pumping: 31, big: 28, devsell: 1, bonded: 1 }],
    ["devsells-rockstar", { new: 1, devsell: 13 }],
  ])("the stored %s history still drives the same alerts", async (name, expected) => {
    await insertEvents(sql, loadFixture(name))
    const evs = await eventsAfter(sql, "0")
    const out = (await Promise.all(evs.map((e) => rulesFor(e, ctx(sql))))).flat()
    const kinds: Record<string, number> = {}
    for (const c of out) kinds[c.alert] = (kinds[c.alert] ?? 0) + 1
    expect(kinds).toEqual(expected)
  })

  it("shows xStock amounts without dollars when the price is missing", async () => {
    await insertEvents(sql, loadFixture("xstocks-xface"))
    const [first] = await eventsAfter(sql, "0")
    const [c] = await rulesFor(first!, ctx(sql))
    expect(c!.card.rows[0]![1]).toMatch(/\/NVDAx$/)
    expect(c!.card.rows[1]![1]).toMatch(/^[\d,.]+ NVDAx$/)
  })
})

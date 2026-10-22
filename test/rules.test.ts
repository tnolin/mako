import { afterAll, beforeEach, describe, expect, inject, it } from "vitest"
import type { Card } from "../src/cards/card"
import type { Sql } from "../src/db"
import { eventsAfter } from "../src/history"
import { createNftState } from "../src/nft/state"
import type { Prices } from "../src/prices"
import { type Candidate, rulesFor, withDevHolds } from "../src/rules/index"
import { insertEvents, resetDb } from "./helpers/db"
import { addr, bond, hash, launch, NATIVE, T0, trade } from "./helpers/events"
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

  it("shows xStock amounts without dollars when the price is missing", async () => {
    await insertEvents(sql, loadFixture("xstocks-xface"))
    const [first] = await eventsAfter(sql, "0")
    const [c] = await rulesFor(first!, ctx(sql))
    expect(c!.card.rows[0]![1]).toMatch(/\/NVDAx$/)
    expect(c!.card.rows[1]![1]).toMatch(/^[\d,.]+ NVDAx$/)
  })
})

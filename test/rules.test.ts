import type { LaunchEvent, SwapEvent, TradeEvent } from "@ink-indexer/events"
import { afterAll, beforeEach, describe, expect, inject, it } from "vitest"
import type { Card } from "../src/cards/card"
import type { Sql } from "../src/db"
import { eventsAfter } from "../src/history"
import { createNftState } from "../src/nft/state"
import { createPrices, type Prices } from "../src/prices"
import { hooksRow } from "../src/rules/hooks-row"
import { type Candidate, rulesFor, swapCtx, withDevHolds } from "../src/rules/index"
import { insertEvents, resetDb } from "./helpers/db"
import { addr, bond, ETH, hash, launch, NATIVE, swap, T0, trade } from "./helpers/events"
import { loadFixture, loadTsunami } from "./helpers/fixtures"
import {
  BLOOP,
  BLOOP_DEV_BUY,
  HKT,
  HMU,
  HMU_SPLIT_WAMZNX,
  HMU_SPLIT_WNVDAX,
  HOOC,
  HOOC_FIRST_BUY,
  INKY,
  INKY_USDG_SELL,
  INKY_WMSTRX_BUY,
  NO_MODULES,
  QCARD,
  QUILL,
  SYNTHETIC_CUSTOM,
  USDG,
  WAAPLX,
  WMSTRX,
  WNVDAX,
} from "./helpers/hookit"

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
    const at = { after: "dev" }
    const filled = withDevHolds(d.card as Card, { pct: 6.8, now: true }, at)
    expect(filled.rows[3]).toEqual(["dev holds", "6.8% (now)"])
    expect(withDevHolds(d.card as Card, { pct: 6.8, now: false }, at).rows[3]).toEqual([
      "dev holds",
      "6.8%",
    ])
    expect(withDevHolds(d.card as Card, null, at)).toBe(d.card)
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
    const s = swap({ quoteAmount: eth(0.4), quoteLiquidity: eth(8.4) })
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
      ["bought", "0.40 ETH ($1.0K)"],
      ["mcap", "$50.0K"],
      ["liquidity", "$42.0K"],
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

  it("no pool BIG under $1,000: a $999 trade sends nothing, a $1,000 one sends", async () => {
    // At $2,500 per ETH, each 5% of its pool's quote side before the trade.
    const worth = (usd: number) => {
      const quote = (BigInt(usd) * 10n ** 18n) / 2500n
      return swap({ quoteAmount: String(quote), quoteLiquidity: String(quote * 21n) })
    }
    expect(pick(await run([...bonded, worth(999)]), "big")).toBeUndefined()
    await sql`delete from indexer.events`
    expect(pick(await run([...bonded, worth(1000)]), "big")).toMatchObject({ sizeBps: 500 })
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

  it("pool BIG BUY on an xStock-quoted pool uses the xStock's own USD price", async () => {
    const xl = launch({ ...L, quoteAsset: X })
    const cs = await runWith(withXstock, [
      xl,
      bond({ quoteAsset: X }),
      swap({ quoteAsset: X, quoteAmount: eth(6), quoteLiquidity: eth(126) }),
    ])
    const b = pick(cs, "big")!
    expect(b.sizeBps).toBe(500)
    expect(b.card.rows).toEqual([
      ["bought", "6.00 NVDAx ($1.1K)"],
      ["mcap", "$3.6K"],
      ["liquidity", "$45.4K"],
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
    expect(
      withDevHolds(d.card as Card, { pct: 4.2, now: false }, { after: "dev" }).rows.map(([k]) => k),
    ).toEqual(["sold", "dev pnl", "dev", "dev holds", "mcap"])
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

describe("PUMPING after bonding", () => {
  const pumpSetup = [
    L,
    trade({ txHash: L.txHash, trader: C }),
    bond({ blockTimestamp: T0 + 3600 }),
    // Outside the 10-minute window of the last swap.
    swap({ marketCap: eth(25), blockTimestamp: T0 + 7000 }),
    swap({ marketCap: eth(20), blockTimestamp: T0 + 7200 }),
    // Another pool of the same token never sets the low.
    swap({ poolId: hash(8), marketCap: eth(10), blockTimestamp: T0 + 7300 }),
    swap({ marketCap: eth(22), side: "sell", trader: addr(0xe2), blockTimestamp: T0 + 7400 }),
  ]

  it("fires at +20% over the 10-minute low", async () => {
    const s = swap({
      marketCap: eth(24),
      athMarketCap: eth(30),
      trader: addr(0xe3),
      blockTimestamp: T0 + 7700,
    })
    const cs = await run([...pumpSetup, s])
    const p = pick(cs, "pumping")!
    expect(p).toMatchObject({
      dedupeKey: `pump:${s.txHash}:${s.logIndex}`,
      priority: 3,
      eventTs: T0 + 7700,
      pump: { token: L.token, gainBps: 2000 },
      mcapUsd: 60_000,
      holds: { token: L.token, holder: C, block: s.blockNumber, totalSupply: L.totalSupply },
    })
    expect(p.pump!.observeOnly).toBeUndefined()
    expect(p.card.title).toBe("PUMPING")
    // The window runs from the 20 ETH low at T0 + 7200: 500 s, shown as 9m.
    expect(p.card.rows).toEqual([
      ["pumped", "+20% (9m)"],
      ["mcap", "$60.0K"],
      ["ath", "$75.0K (−20%)"],
      ["liquidity", "$20.0K"],
      ["volume", "$500 (9m)"],
      ["trades", "3 buys | 1 sell (9m)"],
      ["buyers", "2 (9m)"],
      ["bonded", "1h 8m ago"],
    ])
  })

  it("observes a gain under +15% without a card", async () => {
    const cs = await run([...pumpSetup, swap({ marketCap: eth(22.9), blockTimestamp: T0 + 7700 })])
    const p = pick(cs, "pumping")!
    expect(p.pump).toEqual({ token: L.token, gainBps: 1450, observeOnly: true })
    expect(p.card.rows).toEqual([])
    expect(p.holds).toBeUndefined()
  })

  it("has no mcap in USD while ETH/USD is stale", async () => {
    await insertEvents(sql, [...pumpSetup, swap({ marketCap: eth(24), blockTimestamp: T0 + 7700 })])
    const all = await eventsAfter(sql, "0")
    const stale: Prices = { usd: () => null, symbol: () => "ETH" }
    const cs = await rulesFor(all.at(-1)!, { ...ctx(sql), prices: stale })
    expect(pick(cs, "pumping")).toMatchObject({ pump: { gainBps: 2000 }, mcapUsd: null })
  })

  it("shows age for a token that started in a pool", async () => {
    const cs = await run([
      launch({ ...L, startsInPool: true }),
      swap({ marketCap: eth(20), blockTimestamp: T0 + 100 }),
      swap({ marketCap: eth(30), blockTimestamp: T0 + 400 }),
    ])
    const rows = pick(cs, "pumping")!.card.rows
    expect(rows.at(-1)).toEqual(["age", "6m"])
    expect(rows.map(([k]) => k)).not.toContain("bonded")
  })

  it("withDevHolds puts dev holds before bonded on a PUMPING card", async () => {
    const cs = await run([...pumpSetup, swap({ marketCap: eth(24), blockTimestamp: T0 + 7700 })])
    const card = pick(cs, "pumping")!.card as Card
    expect(
      withDevHolds(card, { pct: 4.2, now: false }, { before: "bonded" }).rows.slice(-2),
    ).toEqual([
      ["dev holds", "4.2%"],
      ["bonded", "1h 8m ago"],
    ])
  })

  it("withDevHolds appends dev holds when the anchor is missing", () => {
    const card = { rows: [["a", "1"]] } as unknown as Card
    expect(withDevHolds(card, { pct: 1, now: false }, { before: "bonded" }).rows).toEqual([
      ["a", "1"],
      ["dev holds", "1.0%"],
    ])
    expect(withDevHolds(card, { pct: 1, now: false }, { after: "dev" }).rows).toEqual([
      ["a", "1"],
      ["dev holds", "1.0%"],
    ])
  })
})

describe("MCAP TARGET", () => {
  const DAY = 86_400
  /** 2d 4h after the launch, as on the spec's card. */
  const AT = T0 + 2 * DAY + 4 * 3600
  const at = (n: number) => ({ ...ctx(sql), now: () => n })
  /** A user (Telegram id 501) watching the token with a target set an hour before AT. */
  async function userTarget(usd: number, up: boolean, setUsd = 210_000, setAt = AT - 3600) {
    const [u] = await sql<{ id: string }[]>`
      insert into bot.users (platform_user_id, settings) values (501, '{}') returning id::text`
    await sql`
      insert into bot.subscriptions (user_id, kind, target, target_usd, target_up, target_set_usd, target_set_at)
      values (${u!.id}, 'watch', ${L.token}, ${usd}, ${up}, ${setUsd}, to_timestamp(${setAt}))`
    return u!.id
  }
  async function runAt(now: number, events: Parameters<typeof insertEvents>[1], p = prices) {
    await insertEvents(sql, events)
    const all = await eventsAfter(sql, "0")
    return rulesFor(all.at(-1)!, { ...at(now), prices: p })
  }
  const bonded = [L, bond({ blockTimestamp: T0 + 3600 })]

  it("fires on the way up, with the spec's card", async () => {
    const id = await userTarget(500_000, true)
    const s = swap({ marketCap: eth(204.8), blockTimestamp: AT })
    const cs = await runAt(AT + 60, [
      ...bonded,
      swap({ quoteAmount: eth(24.35), marketCap: eth(150), blockTimestamp: AT - 3000 }),
      // More than an hour back: not in the volume.
      swap({ quoteAmount: eth(100), marketCap: eth(150), blockTimestamp: AT - 3700 }),
      s,
    ])
    const m = pick(cs, "mcap")!
    expect(m).toMatchObject({
      target: L.token,
      dedupeKey: `mcap:u${id}:${L.token}:500000:${AT - 3600}.000000`,
      priority: 1,
      eventTs: AT,
      recipient: { user: id },
      mcapTarget: { usd: 500_000, setUsd: 210_000, setAt: `${AT - 3600}.000000` },
    })
    expect(m.card.title).toBe("MCAP TARGET")
    expect(m.card.rows).toEqual([
      ["mcap", "$512K"],
      ["target", "$500K (set at $210K)"],
      ["volume", "$61.0K (1h)"],
      ["age", "2d 4h"],
    ])
  })

  it("counts the last hour's curve trades in a pool swap's volume", async () => {
    await userTarget(500_000, true)
    const cs = await runAt(AT, [
      L,
      trade({ quoteAmount: eth(2), blockTimestamp: AT - 1800 }),
      // Before the hour: not counted.
      trade({ quoteAmount: eth(50), blockTimestamp: AT - 4000 }),
      bond({ blockTimestamp: AT - 1700 }),
      swap({ marketCap: eth(204.8), blockTimestamp: AT }),
    ])
    // 2 ETH of curve trades and the 0.05 ETH swap, at $2,500.
    expect(pick(cs, "mcap")!.card.rows[2]).toEqual(["volume", "$5.1K (1h)"])
  })

  it("fires on the way down", async () => {
    await userTarget(150_000, false)
    const cs = await runAt(AT, [...bonded, swap({ marketCap: eth(59), blockTimestamp: AT })])
    expect(pick(cs, "mcap")!.card.rows.slice(0, 2)).toEqual([
      ["mcap", "$148K"],
      ["target", "$150K (set at $210K)"],
    ])
  })

  it("does not fire short of the target", async () => {
    await userTarget(500_000, true)
    const cs = await runAt(AT, [...bonded, swap({ marketCap: eth(199), blockTimestamp: AT })])
    expect(pick(cs, "mcap")).toBeUndefined()
  })

  it("fires on a curve trade, with the curve row after mcap", async () => {
    await userTarget(10_000, true, 5_000)
    const cs = await runAt(AT, [
      L,
      trade({ soldBps: 4000, marketCap: eth(4.4), blockTimestamp: AT }),
    ])
    expect(pick(cs, "mcap")!.card.rows).toEqual([
      ["mcap", "$11.0K"],
      ["curve", "■■■■□□□□□□ 40%"],
      ["target", "$10.0K (set at $5.0K)"],
      ["volume", "$50 (1h)"],
      ["age", "2d 4h"],
    ])
  })

  it("an event from before target_set_at does not fire or clear the target", async () => {
    await userTarget(500_000, true, 210_000, AT + 10)
    const cs = await runAt(AT + 20, [
      ...bonded,
      swap({ marketCap: eth(204.8), blockTimestamp: AT }),
    ])
    expect(pick(cs, "mcap")).toBeUndefined()
  })

  it("an event older than 30 minutes does not fire", async () => {
    await userTarget(500_000, true)
    const cs = await runAt(AT + 1801, [
      ...bonded,
      swap({ marketCap: eth(204.8), blockTimestamp: AT }),
    ])
    expect(pick(cs, "mcap")).toBeUndefined()
  })

  it("does not fire while the price is stale", async () => {
    await userTarget(500_000, true)
    const stale: Prices = { usd: () => null, symbol: () => "ETH" }
    const cs = await runAt(
      AT,
      [...bonded, swap({ marketCap: eth(204.8), blockTimestamp: AT })],
      stale,
    )
    expect(pick(cs, "mcap")).toBeUndefined()
  })

  it("a group's target names the group", async () => {
    await sql`
      insert into bot.chat_token_watches (chat_id, target, target_usd, target_up, target_set_usd, target_set_at)
      values (-1001, ${L.token}, 500000, true, 210000, to_timestamp(${AT - 3600}))`
    const cs = await runAt(AT, [...bonded, swap({ marketCap: eth(204.8), blockTimestamp: AT })])
    expect(pick(cs, "mcap")).toMatchObject({
      recipient: { chat: "-1001" },
      dedupeKey: `mcap:c-1001:${L.token}:500000:${AT - 3600}.000000`,
    })
  })
})

describe("robustness", () => {
  it("skips a trade whose launch event is missing, with a warning and no throw", async () => {
    await insertEvents(sql, [trade({ token: addr(0xbeef) })])
    const [ev] = await eventsAfter(sql, "0")
    expect(await rulesFor(ev!, ctx(sql))).toEqual([])
    expect(warnings.at(-1)).toMatch(/without a launch/)
  })

  it("returns nothing for an event type it doesn't know, with no warning or error", async () => {
    // Shaped like a trade that crosses BONDING's 80% mark, once for a launched token and once for an unknown one.
    const odd = (token: `0x${string}`) =>
      ({ ...trade({ token, soldBps: 8100 }), type: "launchpad.migrate" }) as never
    await insertEvents(sql, [L, odd(L.token), odd(addr(0xbeef))])
    const all = await eventsAfter(sql, "0")
    const before = warnings.length
    expect(await rulesFor(all[1]!, ctx(sql))).toEqual([])
    expect(await rulesFor(all[2]!, ctx(sql))).toEqual([])
    expect(warnings.length).toBe(before)
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

describe("ink.fun", () => {
  it("shows bonds at 4.2 ETH and the seed buy as dev buy for an ink.fun launch", async () => {
    const inkfun = launch({
      launchpad: "inkfun",
      creator: C,
      txHash: hash(0x2b),
      targetRaise: String(4_200n * 10n ** 15n),
    })
    await insertEvents(sql, [
      inkfun,
      trade({
        launchpad: "inkfun",
        txHash: inkfun.txHash,
        trader: C,
        side: "buy",
        quoteAmount: eth(0.01),
        tokenAmount: String(10n ** 25n),
      }),
    ])
    const evs = await eventsAfter(sql, "0")
    const [c] = await rulesFor(evs[0]!, ctx(sql))
    expect(c!.card).toMatchObject({ launchpad: "ink.fun", launchpadKey: "inkfun" })
    expect(c!.card.rows).toEqual([
      ["pair", "GOBLO/ETH"],
      ["bonds at", "4.20 ETH ($10.5K)"],
      ["dev buy", "0.01 ETH (1.0%)"],
      ["dev", "1 launch | 0 bonded"],
    ])
  })
})

describe("Tsunami", () => {
  it("shows bonds at 4.2 ETH and the seed buy as dev buy for the SHITCOIN launch", async () => {
    const { launch: l, seedBuy } = loadTsunami().shitcoin
    await insertEvents(sql, [l, seedBuy])
    const evs = await eventsAfter(sql, "0")
    const [c] = await rulesFor(evs[0]!, ctx(sql))
    expect(c!.card).toMatchObject({ launchpad: "Tsunami", launchpadKey: "tsunami" })
    expect(c!.card.rows).toEqual([
      ["pair", "SHITCOIN/ETH"],
      ["bonds at", "4.20 ETH ($10.5K)"],
      ["dev buy", "0.02 ETH (1.1%)"],
      ["dev", "1 launch | 0 bonded"],
    ])
  })
})

describe("quote currencies", () => {
  const KBTC = "0x73e0c0d45e048d25fc26fa3159b0aa04bfa4db98" as const
  const USDG = "0xe343167631d89b6ffc58b88d6b7fb0228795491d" as const
  const USDC = "0x2d270e6886d130d724215a266106e6832161eaed" as const
  const WETH = "0x4200000000000000000000000000000000000006" as const
  const units = (n: number, decimals: number) => String(BigInt(n) * 10n ** BigInt(decimals))

  /** The bot's own price source, fed a fixed ETH/USD, with a clock the test can move. */
  async function livePrices() {
    let t = 0
    const prices = createPrices({
      fetch: (async (url: string | URL) =>
        new Response(
          JSON.stringify(
            String(url).includes("kraken")
              ? { error: [], result: { XETHZUSD: { c: ["2500", "1"] } } }
              : { assets: [{ wrapperAddress: addr(0x943b), symbol: "AAPLx", valuation: null }] },
          ),
        )) as unknown as typeof fetch,
      now: () => t,
      log: () => {},
    })
    await prices.refresh()
    return { prices, advance: (ms: number) => (t += ms) }
  }

  /** A bonded token quoted in `quote`, then a pool buy of `spent` into a pool holding `liquidity` after it. */
  async function poolBuy(
    p: Prices,
    quote: `0x${string}`,
    decimals: number,
    spent: number,
    liquidity: number,
  ) {
    const l = launch({ ...L, quoteAsset: quote })
    await insertEvents(sql, [
      l,
      bond({ quoteAsset: quote }),
      swap({
        quoteAsset: quote,
        quoteAmount: units(spent, decimals),
        quoteLiquidity: units(liquidity, decimals),
      }),
    ])
    const all = await eventsAfter(sql, "0")
    return pick(await rulesFor(all.at(-1)!, { ...ctx(sql), prices: p }), "big")
  }

  it("a kBTC-quoted pool BIG BUY is not sent", async () => {
    const { prices } = await livePrices()
    expect(await poolBuy(prices, KBTC, 8, 5, 105)).toBeUndefined()
  })

  it("a USDG-quoted pool BIG BUY over $1,000 is sent, and one under is not", async () => {
    const { prices } = await livePrices()
    expect((await poolBuy(prices, USDG, 6, 1200, 24_000))?.card.rows[0]).toEqual([
      "bought",
      "1,200.00 USDG ($1.2K)",
    ])
    await sql`delete from indexer.events`
    expect(await poolBuy(prices, USDG, 6, 900, 18_000)).toBeUndefined()
  })

  it("a USDC-quoted pool BIG BUY over $1,000 is sent", async () => {
    const { prices } = await livePrices()
    expect((await poolBuy(prices, USDC, 6, 1200, 24_000))?.card.rows[0]).toEqual([
      "bought",
      "1,200.00 USDC ($1.2K)",
    ])
  })

  it("a WETH-quoted pool BIG BUY uses the ETH price and is not sent while ETH is stale", async () => {
    const { prices, advance } = await livePrices()
    expect((await poolBuy(prices, WETH, 18, 1, 21))?.card.rows[0]).toEqual([
      "bought",
      "1.00 WETH ($2.5K)",
    ])
    await sql`delete from indexer.events`
    advance(11 * 60_000)
    expect(await poolBuy(prices, WETH, 18, 1, 21)).toBeUndefined()
  })

  /** The recorded USDC-quoted graduation (6 decimals), inserted up to and including `last`. */
  async function usdcGraduate(last: "bond" | "swap") {
    const { launch: l, closingBuy, bond: b, swap: sw } = loadTsunami().usdc
    await insertEvents(sql, last === "bond" ? [l, closingBuy, b] : [l, closingBuy, b, sw])
    const { prices } = await livePrices()
    const all = await eventsAfter(sql, "0")
    return rulesFor(all.at(-1)!, { ...ctx(sql), prices })
  }

  it("a USDC graduate's BONDED card reads its pool at 6 decimals", async () => {
    const bonded = pick(await usdcGraduate("bond"), "bonded")!
    expect(bonded.card.rows.find(([k]) => k === "pool")).toEqual(["pool", "12.00 USDC + 207M USDL"])
  })

  it("a USDC graduate's PUMPING market cap in dollars is read at 6 decimals", async () => {
    // The recorded swap leaves a market cap of 2,490,887 base units: $2.49.
    const pumping = pick(await usdcGraduate("swap"), "pumping")!
    expect(pumping.mcapUsd).toBeCloseTo(2.490887, 6)
  })

  describe("MCAP TARGET on a USDG token", () => {
    const AT = T0 + 3600
    async function fireAt(marketCap: bigint) {
      const [u] = await sql<{ id: string }[]>`
        insert into bot.users (platform_user_id, settings) values (501, '{}') returning id::text`
      await sql`
        insert into bot.subscriptions (user_id, kind, target, target_usd, target_up, target_set_usd, target_set_at)
        values (${u!.id}, 'watch', ${L.token}, 500000, true, 210000, to_timestamp(${AT - 600}))`
      const { prices } = await livePrices()
      await insertEvents(sql, [
        launch({ ...L, quoteAsset: USDG }),
        bond({ quoteAsset: USDG, blockTimestamp: T0 + 60 }),
        swap({ quoteAsset: USDG, marketCap: String(marketCap), blockTimestamp: AT }),
      ])
      const all = await eventsAfter(sql, "0")
      return pick(await rulesFor(all.at(-1)!, { ...ctx(sql), prices, now: () => AT }), "mcap")
    }

    it("compares dollars at 6 decimals", async () => {
      const m = await fireAt(512_000n * 10n ** 6n)
      expect(m?.card.rows.slice(0, 2)).toEqual([
        ["mcap", "$512K"],
        ["target", "$500K (set at $210K)"],
      ])
    })

    it("does not fire short of the target", async () => {
      expect(await fireAt(499_000n * 10n ** 6n)).toBeUndefined()
    })
  })
})

describe("Hookit hooks row", () => {
  const symbols: Record<string, string> = {
    [NATIVE]: "ETH",
    [WAAPLX]: "wAAPLx",
    [USDG]: "USDG",
  }
  const hp: Prices = { usd: (q) => (q === NATIVE ? 2500 : null), symbol: (q) => symbols[q] ?? "?" }
  const at = (n: number) => ({ ...ctx(sql), prices: hp, now: () => n })
  async function runHookit(events: Parameters<typeof insertEvents>[1], index = -1) {
    await insertEvents(sql, events)
    const all = await eventsAfter(sql, "0")
    const ev = index < 0 ? all.at(-1)! : all[index]!
    return rulesFor(ev, at(ev.p.blockTimestamp + 60))
  }
  const labels = (c: Candidate) => c.card.rows.map(([k]) => k)
  const poolSwap = (l: LaunchEvent, o: Partial<SwapEvent> = {}) =>
    swap({
      launchpad: "hookit",
      token: l.token,
      launchId: l.launchId,
      poolId: l.poolId as `0x${string}`,
      blockNumber: String(Number(l.blockNumber) + 10),
      blockTimestamp: l.blockTimestamp + 600,
      ...o,
    })
  const curveTrade = (l: LaunchEvent, o: Partial<TradeEvent> = {}) =>
    trade({
      launchpad: "hookit",
      token: l.token,
      launchId: l.launchId,
      blockTimestamp: l.blockTimestamp + 600,
      ...o,
    })

  describe("hooksRow", () => {
    it("is null for a launch on another launchpad", () => {
      expect(hooksRow(launch({ hookModules: ["Anti-Snipe"], startsInPool: true }))).toBeNull()
    })

    it.each([
      { name: "$HKT", l: HKT, value: "Anti-Snipe, Anti-MEV +3" },
      { name: "QUILL", l: QUILL, value: "Anti-Snipe, Anti-MEV +1" },
      { name: "INKY", l: INKY, value: "Anti-Snipe, Auto-Burn +4" },
      { name: "HMU", l: HMU, value: "Creator → Hook, Hook → Creator" },
      { name: "QCARD", l: QCARD, value: "Hook → Creator, Fixed Fees" },
    ])("$name reads $value", ({ l, value }) => {
      expect(hooksRow(l)).toEqual(["hooks", value])
    })

    it("a hooks value never passes 31 characters, for every recorded module set", () => {
      const recorded = [
        [
          "Anti-Snipe",
          "Backed Floor",
          "Max Tx",
          "Anti-MEV",
          "Deepen LPs",
          "Holder Airdrop",
          "Fixed Fees",
        ],
        ["Backed Floor", "Auto-Burn", "Fixed Fees"],
        ["Anti-Snipe", "Anti-MEV", "Auto-Burn", "Deepen LPs", "Creator → Hook"],
        ["Creator → Hook", "Hook → Creator"],
        ["Anti-Snipe", "Auto-Burn", "Deepen LPs", "Holder Airdrop", "Hook → Creator", "Fixed Fees"],
        ["Holder Airdrop", "Hook → Creator", "Fixed Fees"],
        ["Hook → Creator", "Fixed Fees"],
        ["Anti-Snipe", "Anti-MEV", "Holder Airdrop"],
        ["Anti-Snipe", "Dynamic Fees", "Max Tx", "Hook → Creator"],
      ]
      const values = recorded.map((hookModules) => hooksRow({ ...HKT, hookModules })![1])
      expect(values).toEqual([
        "Anti-Snipe, Backed Floor +5",
        "Backed Floor, Auto-Burn +1",
        "Anti-Snipe, Anti-MEV +3",
        "Creator → Hook, Hook → Creator",
        "Anti-Snipe, Auto-Burn +4",
        "Holder Airdrop +2",
        "Hook → Creator, Fixed Fees",
        "Anti-Snipe, Anti-MEV +1",
        "Anti-Snipe, Dynamic Fees +2",
      ])
      for (const v of values) expect(v.length).toBeLessThanOrEqual(31)
    })

    it("a Master token with no modules shows hooks Master (synthetic launch)", () => {
      expect(hooksRow(NO_MODULES)).toEqual(["hooks", "Master"])
      expect(hooksRow({ ...NO_MODULES, hookModules: null })).toEqual(["hooks", "Master"])
    })

    it("a malformed module list shows as Master and a module name over 31 characters is dropped", () => {
      const bad = (hookModules: unknown) => hooksRow({ ...HKT, hookModules } as LaunchEvent)
      expect(bad("Anti-Snipe")).toEqual(["hooks", "Master"])
      expect(bad({ 0: "Anti-Snipe" })).toEqual(["hooks", "Master"])
      expect(bad([42, null, "x".repeat(32)])).toEqual(["hooks", "Master"])
      expect(bad(["Anti-Snipe", "x".repeat(40), 7])).toEqual(["hooks", "Anti-Snipe"])
    })

    it("a custom-hook launch without a usable hook address does not throw (synthetic launch)", () => {
      for (const hook of [null, undefined, 7]) {
        const l = { ...SYNTHETIC_CUSTOM, hook } as unknown as LaunchEvent
        expect(hooksRow(l)).toEqual(["hooks", "custom"])
      }
    })

    it("a value that cannot fit 31 characters with its +N falls back to Master (synthetic modules)", () => {
      const long = "x".repeat(30)
      expect(hooksRow({ ...HKT, hookModules: [long, "y"] })).toEqual(["hooks", "Master"])
      expect(hooksRow({ ...HKT, hookModules: [long] })).toEqual(["hooks", long])
    })

    it("a custom-hook token's row reads custom 0x… (synthetic launch)", () => {
      expect(hooksRow(SYNTHETIC_CUSTOM)).toEqual(["hooks", "custom 0x1234…abcd"])
    })

    it("a Classic token reads Classic", () => {
      expect(hooksRow(HOOC)).toEqual(["hooks", "Classic"])
    })
  })

  describe("NEW TOKEN", () => {
    it("$HKT's NEW TOKEN has pair HKT/ETH, no bonds at, no mcap row, hooks row Anti-Snipe, Anti-MEV +3", async () => {
      const [c] = await runHookit([HKT])
      expect(c!.card.rows).toEqual([
        ["pair", "HKT/ETH"],
        ["dev", "1 launch | 0 bonded"],
        ["hooks", "Anti-Snipe, Anti-MEV +3"],
      ])
    })

    it('HMU\'s NEW TOKEN has pair HMU/wAAPLx +4 and hooks "Creator → Hook, Hook → Creator" with no +N', async () => {
      const [c] = await runHookit([HMU])
      expect(c!.card.rows).toEqual([
        ["pair", "HMU/wAAPLx +4"],
        ["dev", "1 launch | 0 bonded"],
        ["hooks", "Creator → Hook, Hook → Creator"],
      ])
    })

    it("BLOOP's NEW TOKEN shows its dev buy", async () => {
      const [c] = await runHookit([BLOOP, BLOOP_DEV_BUY], 0)
      expect(c!.card.rows).toEqual([
        ["pair", "BLOOP/ETH"],
        ["dev buy", "0.0010 ETH (0.0%)"],
        ["dev", "1 launch | 0 bonded"],
        ["hooks", "Backed Floor, Auto-Burn +1"],
      ])
    })

    it("NEW TOKEN's dev buy counts market 0's pool only, even when two markets share a quote (synthetic)", async () => {
      const other = `0x${"7".repeat(64)}` as `0x${string}`
      const twoEth = {
        ...HKT,
        markets: [
          { quoteAsset: NATIVE, poolId: HKT.poolId as `0x${string}` },
          { quoteAsset: NATIVE, poolId: other },
        ],
      }
      const buy = poolSwap(twoEth, {
        txHash: twoEth.txHash,
        blockNumber: twoEth.blockNumber,
        blockTimestamp: twoEth.blockTimestamp,
        trader: twoEth.creator,
        poolId: other,
        quoteAmount: eth(0.5),
      })
      const [c] = await runHookit([twoEth, buy], 0)
      expect(labels(c!)).not.toContain("dev buy")
    })

    it("a Master token with no modules shows hooks Master (synthetic launch)", async () => {
      const [c] = await runHookit([NO_MODULES])
      expect(c!.card.rows.at(-1)).toEqual(["hooks", "Master"])
    })

    it("a custom-hook launch's NEW TOKEN and pool swap candidates carry customHook (synthetic launch)", async () => {
      const buy = poolSwap(SYNTHETIC_CUSTOM, { side: "buy", trader: addr(0xb1) })
      await insertEvents(sql, [SYNTHETIC_CUSTOM, buy])
      const [launchRow, swapRow] = await eventsAfter(sql, "0")
      const at = (n: number) => ({ ...ctx(sql), prices: hp, now: () => n })
      const fromLaunch = await rulesFor(launchRow!, at(SYNTHETIC_CUSTOM.blockTimestamp + 60))
      const fromSwap = await rulesFor(swapRow!, at(buy.blockTimestamp + 60))
      expect(fromLaunch.length).toBeGreaterThan(0)
      expect(fromSwap.length).toBeGreaterThan(0)
      expect([...fromLaunch, ...fromSwap].every((c) => c.customHook === true)).toBe(true)
    })

    it("an approved Hookit launch's candidates do not carry customHook", async () => {
      const [c] = await runHookit([HKT])
      expect(c!.customHook).toBe(false)
    })

    it("a custom-hook token's row reads custom 0x… (synthetic launch)", async () => {
      const [c] = await runHookit([SYNTHETIC_CUSTOM])
      expect(c!.card.rows.at(-1)).toEqual(["hooks", "custom 0x1234…abcd"])
    })

    it("a dev buy counts only swaps in market 0's pool (multi-market launch transaction)", async () => {
      const other = HMU.markets![1]!
      const swapIn = (quoteAsset: `0x${string}`, poolId: `0x${string}`, quoteAmount: string) =>
        poolSwap(HMU, {
          txHash: HMU.txHash,
          blockNumber: HMU.blockNumber,
          blockTimestamp: HMU.blockTimestamp,
          trader: HMU.creator,
          quoteAsset,
          poolId,
          quoteAmount,
          tokenAmount: String(10n ** 24n),
        })
      const [c] = await runHookit(
        [
          HMU,
          swapIn(HMU.quoteAsset, HMU.poolId as `0x${string}`, eth(0.5)),
          swapIn(other.quoteAsset, other.poolId, eth(9)),
        ],
        0,
      )
      expect(c!.card.rows.find(([k]) => k === "dev buy")).toEqual(["dev buy", "0.50 wAAPLx (0.1%)"])
    })

    it("a Classic token's NEW TOKEN keeps bonds at and the dev buy, and ends with hooks Classic", async () => {
      const [c] = await runHookit([HOOC, HOOC_FIRST_BUY], 0)
      expect(c!.card.rows).toEqual([
        ["pair", "HOOC/ETH"],
        ["bonds at", "4.20 ETH ($10.5K)"],
        ["dev buy", "0.0007 ETH (0.1%)"],
        ["dev", "1 launch | 0 bonded"],
        ["hooks", "Classic"],
      ])
    })
  })

  describe("every Hookit alert card ends its rows with hooks", () => {
    const hooks = ["hooks", "Anti-Snipe, Anti-MEV +3"]
    const master = [HKT, poolSwap(HKT, { blockTimestamp: HKT.blockTimestamp + 300 })]

    it("pool BIG BUY", async () => {
      const cs = await runHookit([
        ...master,
        poolSwap(HKT, {
          quoteAmount: String(8n * 10n ** 17n),
          quoteLiquidity: String(8n * 10n ** 18n),
        }),
      ])
      expect(pick(cs, "big")!.card.rows.at(-1)).toEqual(hooks)
    })

    it("pool DEV SELL", async () => {
      const cs = await runHookit([
        ...master,
        poolSwap(HKT, {
          side: "sell",
          trader: HKT.creator,
          quoteLiquidity: String(8n * 10n ** 18n),
        }),
      ])
      const rows = pick(cs, "devsell")!.card.rows
      expect(rows.at(-1)).toEqual(hooks)
      expect(rows.map(([k]) => k)).toEqual(["sold", "dev pnl", "dev", "mcap", "hooks"])
    })

    it("pool PUMPING shows age and ends with hooks", async () => {
      const cs = await runHookit([
        HKT,
        poolSwap(HKT, { marketCap: eth(10), blockTimestamp: HKT.blockTimestamp + 100 }),
        poolSwap(HKT, { marketCap: eth(12.4), blockTimestamp: HKT.blockTimestamp + 300 }),
      ])
      const rows = pick(cs, "pumping")!.card.rows
      expect(rows.map(([k]) => k)).toEqual([
        "pumped",
        "mcap",
        "ath",
        "liquidity",
        "volume",
        "trades",
        "buyers",
        "age",
        "hooks",
      ])
      expect(rows.at(-1)).toEqual(hooks)
    })

    it("MCAP TARGET", async () => {
      const [u] = await sql<{ id: string }[]>`
        insert into bot.users (platform_user_id, settings) values (501, '{}') returning id::text`
      const ts = HKT.blockTimestamp + 300
      await sql`
        insert into bot.subscriptions (user_id, kind, target, target_usd, target_up, target_set_usd, target_set_at)
        values (${u!.id}, 'watch', ${HKT.token}, 500000, true, 210000, to_timestamp(${ts - 100}))`
      const cs = await runHookit([HKT, poolSwap(HKT, { marketCap: eth(300), blockTimestamp: ts })])
      expect(pick(cs, "mcap")!.card.rows.at(-1)).toEqual(hooks)
    })

    it("dev holds goes before hooks when the card has no anchor row", () => {
      const card = {
        rows: [
          ["mcap", "$1"],
          ["hooks", "Master"],
        ],
      } as unknown as Card
      const rows = withDevHolds(card, { pct: 4.2, now: false }, { before: "bonded" }).rows
      expect(rows).toEqual([
        ["mcap", "$1"],
        ["dev holds", "4.2%"],
        ["hooks", "Master"],
      ])
      const plain = { rows: [["mcap", "$1"]] } as unknown as Card
      expect(
        withDevHolds(plain, { pct: 4.2, now: false }, { before: "bonded" }).rows.at(-1),
      ).toEqual(["dev holds", "4.2%"])
    })

    it("the DEV HOLDS row lands before age and leaves hooks last", async () => {
      const cs = await runHookit([
        HKT,
        poolSwap(HKT, { marketCap: eth(10), blockTimestamp: HKT.blockTimestamp + 100 }),
        poolSwap(HKT, { marketCap: eth(12.4), blockTimestamp: HKT.blockTimestamp + 300 }),
      ])
      const filled = withDevHolds(
        pick(cs, "pumping")!.card as Card,
        { pct: 4.2, now: false },
        { before: ["bonded", "age"] },
      )
      expect(filled.rows.map(([k]) => k).slice(-3)).toEqual(["dev holds", "age", "hooks"])
    })

    const classic = (extra: Parameters<typeof insertEvents>[1]) => [HOOC, HOOC_FIRST_BUY, ...extra]
    const classicHooks = ["hooks", "Classic"]

    it("Classic BONDING", async () => {
      const cs = await runHookit(
        classic([curveTrade(HOOC, { soldBps: 5100, target: HOOC_FIRST_BUY.target })]),
      )
      expect(pick(cs, "bonding")!.card.rows.at(-1)).toEqual(classicHooks)
    })

    it("Classic BONDED", async () => {
      const cs = await runHookit(
        classic([bond({ launchpad: "hookit", token: HOOC.token, launchId: HOOC.launchId })]),
      )
      expect(pick(cs, "bonded")!.card.rows.at(-1)).toEqual(classicHooks)
    })

    it("Classic BIG BUY", async () => {
      const cs = await runHookit(
        classic([
          curveTrade(HOOC, { quoteAmount: String(2n * 10n ** 17n), target: HOOC_FIRST_BUY.target }),
        ]),
      )
      expect(pick(cs, "big")!.card.rows.at(-1)).toEqual(classicHooks)
    })

    it("Classic DEV SELL", async () => {
      const cs = await runHookit(
        classic([
          curveTrade(HOOC, { side: "sell", trader: HOOC.creator, target: HOOC_FIRST_BUY.target }),
        ]),
      )
      expect(pick(cs, "devsell")!.card.rows.at(-1)).toEqual(classicHooks)
    })

    it("Classic PUMPING", async () => {
      const cs = await runHookit(
        classic([curveTrade(HOOC, { soldBps: 1700, target: HOOC_FIRST_BUY.target })]),
      )
      expect(pick(cs, "pumping")!.card.rows.at(-1)).toEqual(classicHooks)
    })

    it("Classic MCAP TARGET", async () => {
      const [u] = await sql<{ id: string }[]>`
        insert into bot.users (platform_user_id, settings) values (502, '{}') returning id::text`
      const ts = HOOC.blockTimestamp + 600
      await sql`
        insert into bot.subscriptions (user_id, kind, target, target_usd, target_up, target_set_usd, target_set_at)
        values (${u!.id}, 'watch', ${HOOC.token}, 5, true, 2, to_timestamp(${ts - 100}))`
      const cs = await runHookit(
        classic([curveTrade(HOOC, { target: HOOC_FIRST_BUY.target, blockTimestamp: ts })]),
      )
      expect(pick(cs, "mcap")!.card.rows.at(-1)).toEqual(classicHooks)
    })

    it("a card of another launchpad has no hooks row", async () => {
      const cs = await run([L, trade({ soldBps: 4000 }), trade({ soldBps: 9500 })])
      for (const c of cs.filter((x) => x.alert === "bonding"))
        expect(labels(c)).not.toContain("hooks")
    })
  })
})

describe("multi-pair tokens", () => {
  const quoteUsd: Record<string, number> = {
    [NATIVE]: 2500,
    [WNVDAX]: 206.98,
    [WMSTRX]: 133.94,
    [USDG]: 1,
  }
  const mp: Prices = { usd: (q) => quoteUsd[q] ?? null, symbol: (q) => q.slice(0, 6) }
  const rulesAt = async (index: number, now: number) => {
    const all = await eventsAfter(sql, "0")
    return rulesFor(all[index]!, { ...ctx(sql), prices: mp, now: () => now })
  }
  const HMU_TS = HMU_SPLIT_WNVDAX.blockTimestamp
  const INKY_TS = INKY_USDG_SELL.blockTimestamp

  it("HMU's 10-minute volume is in USD and leaves out the unpriced wAMZNx leg (synthetic low swap)", async () => {
    // An earlier wNVDAx swap at half the market cap (synthetic) gives the window its low.
    const low = {
      ...HMU_SPLIT_WNVDAX,
      txHash: hash(0x501),
      logIndex: 1,
      blockNumber: "56521400",
      blockTimestamp: HMU_TS - 240,
      trader: addr(0xe1),
      quoteAmount: String(25n * 10n ** 16n),
      marketCap: "14000000000000000000",
      athMarketCap: "14000000000000000000",
    }
    await insertEvents(sql, [HMU, low, HMU_SPLIT_WAMZNX, HMU_SPLIT_WNVDAX])
    const c = pick(await rulesAt(3, HMU_TS + 30), "pumping")!
    expect(c.card.rows.map(([k, v]) => `${k} ${v}`).slice(0, 6)).toEqual([
      "pumped +103% (4m)",
      "mcap $5.9K",
      "ath $5.9K (0%)",
      // 0.597 wNVDAx of quote plus 5.02 wNVDAx of tokens, at $206.98.
      "liquidity $1.2K",
      // 0.25 + 0.597 wNVDAx at $206.98; the 0.512 wAMZNx has no price.
      "volume $175 (4m)",
      "trades 3 buys | 0 sells (4m)",
    ])
  })

  it("MCAP TARGET on a multi-pair token fires from the deepest pool only (synthetic)", async () => {
    const [u] = await sql<{ id: string }[]>`
      insert into bot.users (platform_user_id, settings) values (503, '{}') returning id::text`
    await sql`
      insert into bot.subscriptions (user_id, kind, target, target_usd, target_up, target_set_usd, target_set_at)
      values (${u!.id}, 'watch', ${INKY.token}, 5000, true, 4000, to_timestamp(${INKY_TS - 100}))`
    // A wMSTRx swap at 40 wMSTRx ($5.4K, synthetic) is over the target, but that pool is the shallower one.
    const over = {
      ...INKY_WMSTRX_BUY,
      txHash: hash(0x502),
      logIndex: 70,
      blockTimestamp: INKY_TS + 30,
      marketCap: "40000000000000000000",
      athMarketCap: "40000000000000000000",
    }
    await insertEvents(sql, [INKY, INKY_USDG_SELL, over])
    const deep = pick(await rulesAt(1, INKY_TS + 60), "mcap")!
    expect(deep.card.rows[0]).toEqual(["mcap", "$5.0K"])
    expect(pick(await rulesAt(2, INKY_TS + 60), "mcap")).toBeUndefined()
  })

  it("a swap in a shallower pool leaves PUMPING to the deepest pool's swaps (synthetic)", async () => {
    const low = {
      ...INKY_WMSTRX_BUY,
      txHash: hash(0x503),
      logIndex: 1,
      blockNumber: "60124700",
      blockTimestamp: INKY_TS - 60,
      marketCap: "20000000000000000000",
      athMarketCap: "20000000000000000000",
    }
    await insertEvents(sql, [INKY, INKY_USDG_SELL, low, INKY_WMSTRX_BUY])
    expect((await rulesAt(3, INKY_TS + 30)).filter((c) => c.alert === "pumping")).toEqual([])
  })

  it("BIG BUY is measured against its own pool, with the token side in its liquidity row (synthetic)", async () => {
    // 10 wMSTRx against 100 wMSTRx of quote (synthetic), after a swap in the deeper USDG pool.
    const buy = {
      ...INKY_WMSTRX_BUY,
      txHash: hash(0x504),
      logIndex: 71,
      quoteAmount: String(10n * ETH),
      quoteLiquidity: String(100n * ETH),
    }
    await insertEvents(sql, [INKY, INKY_USDG_SELL, buy])
    const c = pick(await rulesAt(2, INKY_TS + 30), "big")!
    expect(c.sizeBps).toBe(1111)
    // 100 wMSTRx plus 8.82 wMSTRx of tokens, at $133.94; twice the quote side would read $26.8K.
    expect(c.card.rows.at(-2)).toEqual(["liquidity", "$14.6K"])
    // At $14.6K this pool is now the deepest, so its 35.66 wMSTRx is the mcap shown.
    expect(c.card.rows.at(-3)).toEqual(["mcap", "$4.8K"])
  })

  it("BIG BUY in a shallower pool shows the deepest pool's mcap (synthetic)", async () => {
    // 7.6 wMSTRx against 8 wMSTRx of quote: $2.3K of liquidity, under the USDG pool's $2.5K.
    const buy = {
      ...INKY_WMSTRX_BUY,
      txHash: hash(0x606),
      logIndex: 72,
      quoteAmount: String(76n * 10n ** 17n),
      quoteLiquidity: String(8n * ETH),
    }
    await insertEvents(sql, [INKY, INKY_USDG_SELL, buy])
    const c = pick(await rulesAt(2, INKY_TS + 30), "big")!
    // The USDG pool's $5.0K, not this pool's 35.66 wMSTRx ($4.8K); liquidity stays this pool's own.
    expect(c.card.rows.slice(1, 3)).toEqual([
      ["mcap", "$5.0K"],
      ["liquidity", "$2.3K"],
    ])
  })

  it("DEV SELL leaves out dev pnl when the dev's fills span quotes, and reads mcap from the deepest pool (synthetic fills from INKY's legs)", async () => {
    // An 80 USDG dev buy in the USDG pool, then a sell in the wMSTRx pool: their raw amounts cannot be added.
    const buy = {
      ...INKY_USDG_SELL,
      side: "buy" as const,
      trader: INKY.creator,
      txHash: hash(0x601),
      logIndex: 5,
      blockNumber: "60124700",
      blockTimestamp: INKY_TS - 300,
      quoteAmount: "80000000",
    }
    const sell = {
      ...INKY_WMSTRX_BUY,
      side: "sell" as const,
      trader: INKY.creator,
      txHash: hash(0x602),
    }
    await insertEvents(sql, [INKY, buy, sell])
    const c = pick(await rulesAt(2, INKY_TS + 30), "devsell")!
    expect(c.card.rows.map(([k]) => k)).toEqual(["sold", "dev", "mcap", "hooks"])
    // The USDG pool's $5.0K, not the wMSTRx pool's 35.66 wMSTRx ($4.8K).
    expect(c.card.rows[2]).toEqual(["mcap", "$5.0K"])
  })

  it("DEV SELL keeps dev pnl on a single-market token even with fills in two quotes (synthetic)", async () => {
    const buy = {
      ...INKY_USDG_SELL,
      side: "buy" as const,
      token: HKT.token,
      launchId: HKT.launchId,
      trader: HKT.creator,
      txHash: hash(0x607),
      blockTimestamp: INKY_TS - 300,
      blockNumber: "60124700",
    }
    const sell = {
      ...INKY_WMSTRX_BUY,
      side: "sell" as const,
      token: HKT.token,
      launchId: HKT.launchId,
      trader: HKT.creator,
      txHash: hash(0x608),
    }
    await insertEvents(sql, [HKT, buy, sell])
    const c = pick(await rulesAt(2, INKY_TS + 30), "devsell")!
    expect(c.card.rows.map(([k]) => k)).toContain("dev pnl")
  })

  it("DEV SELL keeps dev pnl when every fill is in one quote (synthetic fills from INKY's legs)", async () => {
    const buy = {
      ...INKY_WMSTRX_BUY,
      trader: INKY.creator,
      txHash: hash(0x603),
      logIndex: 5,
      blockNumber: "60124700",
      blockTimestamp: INKY_TS - 300,
    }
    const sell = {
      ...INKY_WMSTRX_BUY,
      side: "sell" as const,
      trader: INKY.creator,
      txHash: hash(0x604),
    }
    await insertEvents(sql, [INKY, buy, sell])
    const c = pick(await rulesAt(2, INKY_TS + 30), "devsell")!
    expect(c.card.rows.map(([k]) => k)).toEqual(["sold", "dev pnl", "dev", "mcap", "hooks"])
  })

  it("a swap in an unpriced shallow pool still shows the deepest pool's dollar mcap (synthetic dev sell)", async () => {
    const sell = {
      ...HMU_SPLIT_WAMZNX,
      side: "sell" as const,
      trader: HMU.creator,
      txHash: hash(0x605),
    }
    await insertEvents(sql, [HMU, HMU_SPLIT_WNVDAX, sell])
    const c = pick(await rulesAt(2, HMU_TS + 30), "devsell")!
    expect(c.card.rows.find(([k]) => k === "mcap")).toEqual(["mcap", "$5.9K"])
  })

  it("a Tsunami swap without tokenLiquidity shows 2 × quote side (synthetic size)", async () => {
    const { launch: l, closingBuy, bond: b, swap: recorded } = loadTsunami().gm
    // The recorded swap is 0.495 ETH; 5 ETH (synthetic) crosses the BIG threshold. Its pool holds 24.63 ETH of quote.
    const big = { ...recorded, quoteAmount: String(5n * ETH) }
    await insertEvents(sql, [l, closingBuy, b, big])
    const c = pick(await rulesAt(3, big.blockTimestamp + 30), "big")!
    expect(c.card.rows.at(-1)).toEqual(["liquidity", "$123K"])
  })
})

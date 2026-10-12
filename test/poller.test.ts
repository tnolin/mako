import { afterAll, beforeEach, expect, inject, it, vi } from "vitest"
import type { Sql } from "../src/db"
import { initCursor, type PollerDeps, pollOnce } from "../src/delivery/poller"
import type { Prices } from "../src/prices"
import type { DevHolds } from "../src/rpc"
import { allOff, basicPreset } from "../src/settings"
import { addChat, addUser, listDeliveries, subscribe } from "./helpers/bot"
import { insertEvents, resetDb } from "./helpers/db"
import { addr, bond, hash, launch, NATIVE, T0, trade } from "./helpers/events"
import { connectAsBotRole } from "./helpers/roles"

const prices: Prices = { usd: () => 2500, symbol: (q) => (q === NATIVE ? "ETH" : "xStock") }
const eth = (n: number) => String(BigInt(Math.round(n * 1000)) * 10n ** 15n)
const C = addr(0xc1)
const L = launch({ creator: C, txHash: hash(0x1a) })
let sql: Sql
const report = vi.fn()
const deps = (over: Partial<PollerDeps> = {}): PollerDeps => ({
  sql,
  prices,
  log: () => {},
  report,
  readHolds: async () => ({ pct: 6.8, now: false }),
  ...over,
})

beforeEach(async () => {
  await sql?.end()
  sql = await resetDb(inject("databaseUrl"))
  report.mockClear()
  await sql`insert into bot.state (key, value) values ('events_cursor', '0')`
})
afterAll(() => sql.end())

const cursor = async () =>
  (await sql<{ value: string }[]>`select value from bot.state where key = 'events_cursor'`)[0]!
    .value
const byChat = async () => {
  const rows = await listDeliveries(sql)
  const m: Record<string, string[]> = {}
  for (const r of rows) {
    m[r.chat_id] ??= []
    m[r.chat_id]?.push(`${r.alert}:${r.status}`)
  }
  return m
}

it("starts at the newest event on first run, without replaying history", async () => {
  await sql`delete from bot.state`
  const ids = await insertEvents(sql, [L, trade()])
  expect(await initCursor(sql)).toBe(ids[1])
  expect(await pollOnce(deps())).toBe(0)
  expect(await listDeliveries(sql)).toEqual([])
})

it("routes to feeds, DM watchers, groups with topics and channels, minus mutes", async () => {
  await addUser(sql, 101)
  const watcher = await addUser(sql, 102, allOff(basicPreset()))
  const muter = await addUser(sql, 103)
  await subscribe(sql, watcher, "watch", L.token)
  await subscribe(sql, muter, "mute", L.token)
  await addChat(sql, -1001, "supergroup", { ...basicPreset(), thread: 7, routes: { new: 9 } })
  await addChat(sql, -1002, "channel")
  await addChat(sql, -1003, "supergroup", basicPreset(), { active: false })
  await insertEvents(sql, [L, trade({ soldBps: 8100, quoteAmount: eth(0.5) })])
  await pollOnce(deps())
  expect(await byChat()).toEqual({
    "101": ["bonding:pending", "new:pending"],
    "102": ["bonding:pending"],
    "-1001": ["bonding:pending", "new:pending"],
    "-1002": ["bonding:pending", "new:pending"],
  })
  const rows = await listDeliveries(sql)
  expect(rows.find((r) => r.chat_id === "-1001" && r.alert === "new")?.thread_id).toBe(9)
  expect(rows.find((r) => r.chat_id === "-1001" && r.alert === "bonding")?.thread_id).toBe(7)
  expect(rows.find((r) => r.chat_id === "-1002")?.thread_id).toBeNull()
  expect(rows.find((r) => r.chat_id === "101" && r.alert === "new")?.card).toMatchObject({
    type: "card",
    image: true,
  })
  expect(await cursor()).not.toBe("0")
})

it("applies each chat's BIG threshold and keeps the highest BONDING mark it has", async () => {
  const s = basicPreset()
  await addUser(sql, 201, {
    ...s,
    alerts: {
      ...s.alerts,
      bonding: { ...s.alerts.bonding, on: false },
      pumping: { ...s.alerts.pumping, on: false },
      big: { ...s.alerts.big, pctBps: 1000 },
    },
  })
  await addUser(sql, 202, {
    ...s,
    alerts: {
      ...s.alerts,
      bonding: { ...s.alerts.bonding, on: false },
      pumping: { ...s.alerts.pumping, on: false },
    },
  })
  await addUser(sql, 203, {
    ...s,
    alerts: {
      ...s.alerts,
      pumping: { ...s.alerts.pumping, on: false },
      bonding: { ...s.alerts.bonding, marks: [5000] },
    },
  })
  await insertEvents(sql, [
    L,
    trade({ soldBps: 4000, blockTimestamp: T0 + 2000 }),
    trade({ soldBps: 9500, quoteAmount: eth(0.15), blockTimestamp: T0 + 2100 }),
  ])
  await pollOnce(deps())
  const rows = await listDeliveries(sql)
  const mine = (id: string) =>
    rows.filter((r) => r.chat_id === id && r.alert !== "new").map((r) => r.dedupe_key)
  expect(mine("201")).toEqual([])
  expect(mine("202")).toEqual([expect.stringMatching(/^big:/)])
  expect(mine("203")).toEqual([`bonding:5000:${L.token}`])
})

it("prefers PUMPING over BIG for one trade, and honours the 60-minute PUMPING cooldown", async () => {
  const s = basicPreset()
  await addUser(sql, 301, {
    ...s,
    alerts: { ...s.alerts, bonding: { ...s.alerts.bonding, on: false } },
  })
  await insertEvents(sql, [
    L,
    trade({ soldBps: 2000, quoteAmount: eth(0.5), blockTimestamp: T0 + 60 }),
    trade({ soldBps: 4000, quoteAmount: eth(0.5), blockTimestamp: T0 + 120 }),
  ])
  await pollOnce(deps())
  const alerts = (await listDeliveries(sql)).filter((r) => r.alert !== "new").map((r) => r.alert)
  expect(alerts.sort()).toEqual(["big", "pumping"]) // first trade PUMPING, second BIG during the cooldown
})

it("supersedes pending BONDING when the token bonds, in the same or a later batch", async () => {
  await addUser(sql, 401)
  await insertEvents(sql, [L, trade({ soldBps: 9100 })])
  await pollOnce(deps())
  await insertEvents(sql, [bond()])
  await pollOnce(deps())
  expect((await byChat())["401"]).toEqual(["bonding:superseded", "new:pending", "bonded:pending"])
})

it("creates no duplicates when a reorg re-inserts the same events with new ids", async () => {
  await addUser(sql, 501)
  const events = [L, trade({ soldBps: 8100 })]
  await insertEvents(sql, events)
  await pollOnce(deps())
  await sql`delete from indexer.events`
  await insertEvents(sql, events)
  await pollOnce(deps())
  expect((await byChat())["501"]).toEqual(["bonding:pending", "new:pending"])
})

it("keeps going when a rule throws on one event", async () => {
  await addUser(sql, 601)
  const ids = await insertEvents(sql, [L, trade({ soldBps: 8100 })])
  const real = (await import("../src/rules/index")).rulesFor
  await pollOnce(
    deps({
      rules: async (ev, ctx) => {
        if (ev.id === ids[0]) throw new Error("bad payload")
        return real(ev, ctx)
      },
    }),
  )
  expect(report).toHaveBeenCalledTimes(1)
  expect((await byChat())["601"]).toEqual(["bonding:pending"])
  expect(await cursor()).toBe(ids[1])
})

it("reads dev holds outside any transaction and never blocks other alerts", async () => {
  await addUser(sql, 701)
  const ids = await insertEvents(sql, [
    L,
    trade({
      txHash: L.txHash,
      trader: C,
      tokenAmount: String(10n ** 26n),
      quoteAmount: eth(1),
      soldBps: 1000,
    }),
    trade({
      trader: C,
      side: "sell",
      tokenAmount: String(10n ** 25n),
      quoteAmount: eth(0.2),
      soldBps: 900,
      blockTimestamp: T0 + 900,
    }),
    trade({ soldBps: 8100, blockTimestamp: T0 + 950 }),
  ])
  let release!: (h: DevHolds) => void
  const gate = new Promise<DevHolds>((r) => {
    release = r
  })
  const run = pollOnce(deps({ readHolds: () => gate }))
  await vi.waitFor(async () => {
    expect((await byChat())["701"]).toEqual(["bonding:pending", "new:pending"])
  })
  expect(await cursor()).toBe(String(BigInt(ids[2]!) - 1n))
  const idle =
    await sql`select 1 from pg_stat_activity where datname = current_database() and state = 'idle in transaction'`
  expect(idle).toHaveLength(0)
  release({ pct: 9, now: false })
  await run
  const dev = (await listDeliveries(sql)).find((r) => r.alert === "devsell")!
  expect(dev.card.type === "card" && dev.card.card.rows).toContainEqual([
    "dev holds",
    "9.0% of supply",
  ])
  expect(await cursor()).toBe(ids[3])
})

it("recovers from a crash between the two writes with no lost or duplicate rows", async () => {
  await addUser(sql, 801)
  await insertEvents(sql, [
    L,
    trade({
      trader: C,
      side: "sell",
      tokenAmount: "1000",
      quoteAmount: eth(0.1),
      blockTimestamp: T0 + 900,
    }),
    trade({ soldBps: 8100, blockTimestamp: T0 + 950 }),
  ])
  let release!: (h: DevHolds) => void
  const hung = pollOnce(
    deps({
      readHolds: () =>
        new Promise<DevHolds>((r) => {
          release = r
        }),
    }),
  )
  await vi.waitFor(async () => expect((await byChat())["801"]).toContain("bonding:pending"))
  // The "crashed" process never finishes; a restarted poller runs the batch again from the first DEV SELL.
  await pollOnce(deps())
  expect((await byChat())["801"]?.sort()).toEqual([
    "bonding:pending",
    "devsell:pending",
    "new:pending",
  ])
  release(null)
  await hung
  expect((await listDeliveries(sql)).filter((r) => r.chat_id === "801")).toHaveLength(3)
})

it("runs as the bot role with only the production grants", async () => {
  await addUser(sql, 901)
  await insertEvents(sql, [L, trade({ soldBps: 8100 })])
  const bot = await connectAsBotRole(sql, inject("databaseUrl"))
  try {
    await pollOnce(deps({ sql: bot }))
  } finally {
    await bot.end()
  }
  expect((await byChat())["901"]).toEqual(["bonding:pending", "new:pending"])
})

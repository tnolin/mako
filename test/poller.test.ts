import { afterAll, beforeEach, expect, inject, it, vi } from "vitest"
import type { Sql } from "../src/db"
import { initCursor, type PollerDeps, pollOnce, startPoller } from "../src/delivery/poller"
import { deleteUserData } from "../src/menus/users"
import type { Prices } from "../src/prices"
import type { DevHolds } from "../src/rpc"
import { allOff, basicPreset } from "../src/settings"
import { addChat, addUser, listDeliveries, subscribe } from "./helpers/bot"
import { insertEvents, resetDb } from "./helpers/db"
import { addr, bond, hash, launch, NATIVE, nftSale, T0, trade } from "./helpers/events"
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

it("reads no event past maxId and leaves the cursor at the last one it read", async () => {
  await addUser(sql, 101)
  const ids = await insertEvents(sql, [L, trade({ soldBps: 8100, quoteAmount: eth(0.5) })])
  expect(await pollOnce(deps({ maxId: ids[0] }))).toBe(1)
  expect(await byChat()).toEqual({ "101": ["new:pending"] })
  expect(await cursor()).toBe(ids[0])
  expect(await pollOnce(deps({ maxId: ids[0] }))).toBe(0)
  expect(await pollOnce(deps())).toBe(1)
  expect(await byChat()).toEqual({ "101": ["new:pending", "bonding:pending"] })
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
  expect(dev.card.type === "card" && dev.card.card.rows).toContainEqual(["dev holds", "9.0%"])
  expect(await cursor()).toBe(ids[3])
})

it("writes no DM row for a user who deleted their data while the dev holds read ran", async () => {
  await addUser(sql, 702)
  await addUser(sql, 703)
  await insertEvents(sql, [
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
  ])
  await pollOnce(
    deps({
      readHolds: async () => {
        await deleteUserData(sql, 702)
        return { pct: 9, now: false }
      },
    }),
  )
  const rows = await listDeliveries(sql)
  expect(rows.filter((r) => r.alert === "devsell").map((r) => r.chat_id)).toEqual(["703"])
  expect(rows.some((r) => r.chat_id === "702")).toBe(false)
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

const pumpOnly = () => {
  const s = basicPreset()
  return { ...s, alerts: { ...s.alerts, bonding: { ...s.alerts.bonding, on: false } } }
}
const pumpTrade = () => trade({ soldBps: 2000, quoteAmount: eth(0.5), blockTimestamp: T0 + 60 })

it("keeps one PUMPING and no BIG when a batch is re-run after a crash", async () => {
  await addUser(sql, 1001, pumpOnly())
  await insertEvents(sql, [L, pumpTrade()])
  await pollOnce(deps())
  await initCursor(sql, "0")
  await pollOnce(deps())
  expect((await byChat())["1001"]).toEqual(["new:pending", "pumping:pending"])
})

it("keeps one PUMPING and no BIG when a reorg re-inserts the trade", async () => {
  await addUser(sql, 1002, pumpOnly())
  const events = [L, pumpTrade()]
  await insertEvents(sql, events)
  await pollOnce(deps())
  await sql`delete from indexer.events`
  await insertEvents(sql, events)
  await pollOnce(deps())
  expect((await byChat())["1002"]).toEqual(["new:pending", "pumping:pending"])
})

it("fails the batch on a database error and leaves the cursor where it was", async () => {
  await addUser(sql, 1101)
  await insertEvents(sql, [L, trade({ soldBps: 8100 })])
  const dbError = Object.assign(new Error("connection closed"), { code: "CONNECTION_CLOSED" })
  await expect(pollOnce(deps({ rules: async () => Promise.reject(dbError) }))).rejects.toBe(dbError)
  expect(await cursor()).toBe("0")
  expect(await listDeliveries(sql)).toEqual([])
})

it("sends rule-failure reports through the limiter, one per source while failing", async () => {
  await addUser(sql, 1201)
  await insertEvents(sql, [L, trade({ soldBps: 8100 }), trade({ soldBps: 8200 })])
  await pollOnce(deps({ rules: async () => Promise.reject(new Error("bad payload")) }))
  expect(report).toHaveBeenCalledTimes(1)
})

it("startPoller reports a failing batch once, keeps the cursor, and keeps looping", async () => {
  await addUser(sql, 1301)
  await insertEvents(sql, [L, trade({ soldBps: 8100 })])
  const real = (await import("../src/rules/index")).rulesFor
  const dbError = Object.assign(new Error("connection closed"), { code: "CONNECTION_CLOSED" })
  let calls = 0
  const rules: typeof real = async (ev, ctx) => {
    if (calls++ < 2) throw dbError
    return real(ev, ctx)
  }
  report.mockImplementationOnce(() => {
    throw new Error("report sink down")
  })
  const realTimeout = globalThis.setTimeout
  const until = async (ok: () => boolean | Promise<boolean>) => {
    for (let i = 0; i < 500 && !(await ok()); i++) await new Promise((r) => realTimeout(r, 10))
    expect(await ok()).toBe(true)
  }
  await Promise.all([1, 2, 3, 4].map(() => sql`select pg_sleep(0.05)`)) // open the pool before faking timers
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  let stop = () => {}
  try {
    stop = startPoller(deps({ rules }))
    await until(() => report.mock.calls.length === 1 && vi.getTimerCount() === 1)
    expect(await cursor()).toBe("0")
    await vi.advanceTimersByTimeAsync(5000)
    await until(() => calls >= 2 && vi.getTimerCount() === 1)
    expect(report).toHaveBeenCalledTimes(1) // second failure is inside the report window
    expect(await cursor()).toBe("0")
    await vi.advanceTimersByTimeAsync(5000)
    await until(async () => (await listDeliveries(sql)).length > 0 && vi.getTimerCount() === 1)
    expect(await cursor()).not.toBe("0")
    stop()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    stop()
    vi.useRealTimers()
  }
})

// Launch floods. MIN0 is a minute boundary, so a 25-launch flood 2 s apart stays in one minute bucket.
const MIN0 = Math.floor(T0 / 60) * 60
const flood = (n: number, o: { lp?: string; from?: number; ts0?: number } = {}) =>
  Array.from({ length: n }, (_, i) =>
    launch({
      token: addr(0x1000 + (o.from ?? 0) + i),
      name: `Flood ${i + 1}`,
      ticker: `F${i + 1}`,
      launchpad: (o.lp ?? "inkypump") as never,
      blockTimestamp: (o.ts0 ?? MIN0) + i * 2,
      blockNumber: String(2000 + (o.from ?? 0) + i),
      txHash: hash(0x5000 + (o.from ?? 0) + i),
    }),
  )
type FloodRow = {
  chat_id: string
  dedupe_key: string
  status: string
  // biome-ignore lint/suspicious/noExplicitAny: test reads jsonb payloads of several shapes
  card: any
  send_after: Date | null
  thread_id: number | null
}
const rowsBy = async (prefix: string) =>
  sql<FloodRow[]>`
    select chat_id::text, dedupe_key, status, card, send_after, thread_id from bot.deliveries
    where dedupe_key like ${`${prefix}%`} order by created_at, event_ts`
const NOTICE =
  "Lots of new tokens are launching on InkyPump at once. To avoid spam, NEW TOKEN alerts are grouped into one message per minute until it slows down."

it("sends individual NEW TOKEN up to 10 launches, then one notice and minute cards instead", async () => {
  await addUser(sql, 501)
  await insertEvents(sql, flood(25))
  await pollOnce(deps())
  expect(await rowsBy("new:")).toHaveLength(10)
  const notice = await rowsBy("flood:")
  expect(notice).toHaveLength(1)
  expect(notice[0]!.card.html).toBe(NOTICE)
  const cards = await rowsBy("newtokens:")
  expect(cards).toHaveLength(1)
  expect(cards[0]!.card.entries.map((e: { ticker: string }) => e.ticker)).toEqual(
    Array.from({ length: 15 }, (_, i) => `F${i + 11}`),
  )
  const minute = MIN0 / 60
  expect(cards[0]!.dedupe_key).toBe(`newtokens:inkypump:${minute}`)
  expect(cards[0]!.send_after!.getTime()).toBe(((minute + 1) * 60 + 30) * 1000)
})

it("splits a flood into one card per minute bucket", async () => {
  await addUser(sql, 501)
  await insertEvents(sql, flood(70)) // flooded launches 11..70 span MIN0+20 .. MIN0+138: three minute buckets
  await pollOnce(deps())
  const keys = (await rowsBy("newtokens:")).map((r) => r.dedupe_key)
  expect(new Set(keys).size).toBe(keys.length)
  expect(keys).toHaveLength(3)
})

it("is idempotent across a re-run of the same events", async () => {
  await addUser(sql, 501)
  await insertEvents(sql, flood(25))
  await pollOnce(deps())
  await sql`update bot.state set value = '0' where key = 'events_cursor'`
  await pollOnce(deps())
  expect(await rowsBy("flood:")).toHaveLength(1)
  expect((await rowsBy("newtokens:"))[0]!.card.entries).toHaveLength(15)
})

it("builds the same card when a flood spans two poll batches", async () => {
  await addUser(sql, 501)
  const ids = await insertEvents(sql, flood(25))
  await pollOnce(deps({ maxId: ids[12]! }))
  await pollOnce(deps())
  expect(await rowsBy("flood:")).toHaveLength(1)
  expect((await rowsBy("newtokens:"))[0]!.card.entries).toHaveLength(15)
})

it("leaves a quiet launchpad's NEW TOKEN alerts alone", async () => {
  await addUser(sql, 501)
  await insertEvents(sql, [...flood(15), ...flood(2, { lp: "other", from: 500 })])
  await pollOnce(deps())
  const individual = await rowsBy("new:")
  expect(individual.filter((r) => r.card.card?.launchpadKey === "other")).toHaveLength(2)
  expect(individual).toHaveLength(12)
})

it("routes to the NEW TOKEN topic and skips chats with NEW TOKEN off or paused", async () => {
  const s = basicPreset()
  await addChat(sql, -1001, "supergroup", { ...s, thread: 2, routes: { new: 3 } })
  await addChat(sql, -1002, "supergroup", {
    ...s,
    alerts: { ...s.alerts, new: { ...s.alerts.new, on: false } },
  })
  await addChat(sql, -1003, "supergroup", { ...s, pausedRoutes: ["new"] })
  await insertEvents(sql, flood(15))
  await pollOnce(deps())
  expect(new Set((await rowsBy("flood:")).map((r) => r.chat_id))).toEqual(new Set(["-1001"]))
  const cards = await rowsBy("newtokens:")
  expect(cards.map((r) => r.chat_id)).toEqual(["-1001"])
  expect(cards[0]!.thread_id).toBe(3)
})

it("drops a late launch for a card that was already sent, without throwing", async () => {
  await addUser(sql, 501)
  await insertEvents(sql, flood(15))
  await pollOnce(deps())
  await sql`update bot.deliveries set status = 'sent' where dedupe_key like 'newtokens:%'`
  await insertEvents(sql, flood(1, { from: 900, ts0: MIN0 + 40 }))
  await expect(pollOnce(deps())).resolves.toBeGreaterThan(0)
  const cards = await rowsBy("newtokens:")
  expect(cards).toHaveLength(1)
  expect(cards[0]!.card.entries).toHaveLength(5)
  expect(await rowsBy("new:")).toHaveLength(10)
})

it("sends one notice for a flood longer than 15 minutes polled in many passes", async () => {
  await addUser(sql, 501)
  // One launch every 10 s for 30 min: 180 launches, in flood from the 11th to the end.
  const long = Array.from({ length: 180 }, (_, i) =>
    launch({
      token: addr(0x3000 + i),
      ticker: `L${i}`,
      blockTimestamp: MIN0 + i * 10,
      blockNumber: String(5000 + i * 10),
      txHash: hash(0x7000 + i),
    }),
  )
  const ids = await insertEvents(sql, long)
  for (let i = 29; i < ids.length; i += 30) await pollOnce(deps({ maxId: ids[i]! }))
  await pollOnce(deps())
  expect(await rowsBy("flood:")).toHaveLength(1)
  expect(await rowsBy("new:")).toHaveLength(10)
})

it("queues the notice after individual alerts that share its second", async () => {
  await addUser(sql, 501)
  // The 10th and 11th launches share a second, as both real flood starts in the local data do.
  const tie = flood(15).map((e, i) => (i === 10 ? { ...e, blockTimestamp: MIN0 + 18 } : e))
  await insertEvents(sql, tie)
  await pollOnce(deps())
  const [last] = await sql<{ ts: Date }[]>`
    select max(event_ts) as ts from bot.deliveries where dedupe_key like 'new:%'`
  const [notice] = await sql<{ ts: Date }[]>`
    select event_ts as ts from bot.deliveries where dedupe_key like 'flood:%'`
  expect(notice!.ts.getTime()).toBeGreaterThan(last!.ts.getTime())
})

it("skips nft events without rules and advances the cursor", async () => {
  await addUser(sql, 101)
  // A sweep: one log, two sales, told apart by the events-v2 `sub` column.
  const tx = hash(0x5e)
  const ids = await insertEvents(
    sql,
    [nftSale({ txHash: tx, logIndex: 7 }), nftSale({ txHash: tx, logIndex: 7 })],
    {
      subs: ["0", "1"],
    },
  )
  expect(await pollOnce(deps())).toBe(2)
  expect(await cursor()).toBe(ids[1])
  expect(await listDeliveries(sql)).toEqual([])
  expect(report).not.toHaveBeenCalled()
})

import { afterAll, beforeEach, describe, expect, inject, it, vi } from "vitest"
import type { Sql } from "../src/db"
import { initCursor, type PollerDeps, pollOnce, startPoller } from "../src/delivery/poller"
import { TokenLaunchpads } from "../src/launchpads"
import { deleteUserData } from "../src/menus/users"
import type { Prices } from "../src/prices"
import type { DevHolds } from "../src/rpc"
import { PumpArm } from "../src/rules/pump-arm"
import { allOff, basicPreset } from "../src/settings"
import { addChat, addUser, listDeliveries, subscribe, watchToken } from "./helpers/bot"
import { insertEvents, resetDb } from "./helpers/db"
import {
  addr,
  bond,
  hash,
  launch,
  NATIVE,
  nftCollection,
  nftDrop,
  nftLaunch,
  nftMint,
  nftSale,
  swap,
  T0,
  trade,
} from "./helpers/events"
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
  const watcher = await addUser(sql, 102, allOff(basicPreset("private")))
  const muter = await addUser(sql, 103)
  await subscribe(sql, watcher, "watch", L.token)
  await subscribe(sql, muter, "mute", L.token)
  await addChat(sql, -1001, "supergroup", {
    ...basicPreset("supergroup"),
    thread: 7,
    routes: { new: 9 },
  })
  await addChat(sql, -1002, "channel")
  await addChat(sql, -1003, "supergroup", basicPreset("supergroup"), { active: false })
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
  const s = basicPreset("private")
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
  const s = basicPreset("private")
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
  const s = basicPreset("private")
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
  const s = basicPreset("supergroup")
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

// The indexer's NFT backfill writes old nft.* events as new rows; the bot must not alert on them.
const seen = () => {
  const types: string[] = []
  const rules: PollerDeps["rules"] = async (ev) => {
    types.push(`${ev.p.type}@${ev.p.blockTimestamp}`)
    return []
  }
  return { types, rules }
}
const storedSince = async () =>
  (await sql<{ value: string }[]>`select value from bot.state where key = 'nft_alerts_since'`)[0]
    ?.value

it("skips an nft event older than the cutoff, and the cursor advances", async () => {
  const s = seen()
  const ids = await insertEvents(sql, [
    nftSale({ blockTimestamp: T0 }),
    nftSale({ blockTimestamp: T0 + 200 }),
  ])
  expect(await pollOnce(deps({ now: () => T0 + 100, rules: s.rules }))).toBe(2)
  expect(s.types).toEqual([`nft.sale@${T0 + 200}`])
  expect(await cursor()).toBe(ids[1])
})

it("NFT_ALERTS_SINCE overrides the stored start time", async () => {
  const s = seen()
  await insertEvents(sql, [
    nftSale({ blockTimestamp: T0 + 40 }),
    nftSale({ blockTimestamp: T0 + 60 }),
  ])
  await pollOnce(deps({ now: () => T0 + 1000, nftAlertsSince: T0 + 50, rules: s.rules }))
  expect(s.types).toEqual([`nft.sale@${T0 + 60}`])
  expect(await storedSince()).toBeUndefined()
})

it("a restart keeps the first stored start time", async () => {
  const first = seen()
  await insertEvents(sql, [nftSale({ blockTimestamp: T0 + 150 })])
  await pollOnce(deps({ now: () => T0 + 100, rules: first.rules }))
  expect(await storedSince()).toBe(String(T0 + 100))
  // The bot was down; the next start's clock is far later, but the stored time stands.
  const second = seen()
  await insertEvents(sql, [nftSale({ blockTimestamp: T0 + 500 })])
  await pollOnce(deps({ now: () => T0 + 9999, rules: second.rules }))
  expect(second.types).toEqual([`nft.sale@${T0 + 500}`])
  expect(await storedSince()).toBe(String(T0 + 100))
})

it("launchpad events ignore the cutoff", async () => {
  const s = seen()
  await insertEvents(sql, [launch({ blockTimestamp: T0 }), nftSale({ blockTimestamp: T0 })])
  await pollOnce(deps({ now: () => T0 + 100, nftAlertsSince: T0 + 5000, rules: s.rules }))
  expect(s.types).toEqual([`launchpad.launch@${T0}`])
})

// NFT rules run end to end through the poller.
const NFT = addr(0xc0)
const nftRows = async () =>
  (
    await sql<
      {
        chat_id: string
        alert: string
        dedupe_key: string
        priority: number
        token: string
        card: { type: string }
      }[]
    >`
      select chat_id::text, alert, dedupe_key, priority, token, card from bot.deliveries order by created_at, dedupe_key`
  ).map((r) => ({ ...r, type: r.card.type }))

it("poller end to end: nft.drop then nft.mint rows land with the right keys and priorities", async () => {
  await addUser(sql, 101)
  await addChat(sql, -1001, "supergroup")
  await insertEvents(sql, [nftCollection(), nftDrop({ blockTimestamp: T0 + 60 })])
  expect(await pollOnce(deps({ now: () => T0 + 120, nftAlertsSince: 0 }))).toBe(2)
  // The allowlist stage opens first; the feed does not carry it.
  await insertEvents(sql, [nftMint({ blockTimestamp: T0 + 3600 })])
  await pollOnce(deps({ now: () => T0 + 3610, nftAlertsSince: 0 }))
  expect((await nftRows()).map((r) => r.alert)).toEqual(["upcoming"])
  await insertEvents(sql, [
    nftMint({
      stageIndex: 0,
      stageLabel: "Public",
      stagePriceWei: String(5n * 10n ** 14n),
      stageStartTs: T0 + 7200,
      blockTimestamp: T0 + 7200,
    }),
  ])
  await pollOnce(deps({ now: () => T0 + 7210, nftAlertsSince: 0 }))
  const rows = await nftRows()
  expect(rows).toEqual([
    expect.objectContaining({
      chat_id: "101",
      alert: "upcoming",
      dedupe_key: `upcoming:${NFT}`,
      priority: 3,
      token: NFT,
      type: "nftalert",
    }),
    expect.objectContaining({
      chat_id: "101",
      alert: "mintstart",
      dedupe_key: `mintstart:${NFT}:0`,
      priority: 2,
      token: NFT,
      type: "nftalert",
    }),
  ])
})

it("keeps the NFT state across passes, so a collection turning real is caught up once", async () => {
  await addUser(sql, 101)
  const shared = {}
  const d = (now: number) => deps({ now: () => now, nftAlertsSince: 0, nftState: shared })
  const pending = nftCollection({
    verdict: "pending",
    gates: {
      page: "pending",
      structure: "pending",
      traits: "pending",
      farm: "n/a",
      farmShareBps: null,
    },
  })
  await insertEvents(sql, [pending, nftDrop({ blockTimestamp: T0 + 60 })])
  await pollOnce(d(T0 + 120))
  expect(await nftRows()).toEqual([])
  await insertEvents(sql, [nftCollection({ verdict: "real", blockTimestamp: T0 + 130 })])
  await pollOnce(d(T0 + 140))
  expect((await nftRows()).map((r) => r.alert)).toEqual(["upcoming"])
  // Nothing more on a repeat snapshot.
  await insertEvents(sql, [nftCollection({ verdict: "real", blockTimestamp: T0 + 150 })])
  await pollOnce(d(T0 + 160))
  expect(await nftRows()).toHaveLength(1)
})

it("rebuilds the NFT state from the cursor after a failed pass, so a transition is still seen once", async () => {
  await addUser(sql, 101)
  const shared: { current?: unknown } = {}
  const pending = nftCollection({ verdict: "pending" })
  await insertEvents(sql, [pending, nftDrop({ blockTimestamp: T0 + 60 })])
  await pollOnce(deps({ now: () => T0 + 120, nftAlertsSince: 0, nftState: shared as never }))
  await insertEvents(sql, [nftCollection({ verdict: "real", blockTimestamp: T0 + 130 })])
  const failing = Object.assign(new Error("db down"), { code: "ECONNRESET" })
  await expect(
    pollOnce(
      deps({
        now: () => T0 + 140,
        nftAlertsSince: 0,
        nftState: shared as never,
        rules: async () => {
          throw failing
        },
      }),
    ),
  ).rejects.toThrow("db down")
  expect(shared.current).toBeUndefined()
  await pollOnce(deps({ now: () => T0 + 150, nftAlertsSince: 0, nftState: shared as never }))
  expect((await nftRows()).map((r) => r.alert)).toEqual(["upcoming"])
})

it("applies backfilled NFT history to the state but sends nothing for it", async () => {
  await addUser(sql, 101)
  // Old snapshot and drop (before the cutoff), then a live mint start for the same collection.
  await insertEvents(sql, [
    nftCollection({ blockTimestamp: T0 - 5000 }),
    nftDrop({ blockTimestamp: T0 - 4000 }),
  ])
  await pollOnce(deps({ now: () => T0 + 120, nftAlertsSince: T0 }))
  expect(await nftRows()).toEqual([])
  await insertEvents(sql, [
    nftMint({
      stageIndex: 0,
      stageLabel: "Public",
      stagePriceWei: String(5n * 10n ** 14n),
      stageStartTs: T0 + 7200,
      blockTimestamp: T0 + 7200,
    }),
  ])
  await pollOnce(deps({ now: () => T0 + 7210, nftAlertsSince: T0 }))
  // The mint start knows the collection is real because the old snapshot built the state.
  expect(await nftRows()).toEqual([expect.objectContaining({ alert: "mintstart", chat_id: "101" })])
})

it("sends no NEW COLLECTION for a backfilled launch whose page appears later", async () => {
  await addUser(sql, 101)
  await insertEvents(sql, [nftLaunch({ blockTimestamp: T0 - 4000 })])
  await pollOnce(deps({ now: () => T0 + 120, nftAlertsSince: T0 }))
  await insertEvents(sql, [nftCollection({ launchpad: "chimera", blockTimestamp: T0 + 600 })])
  await pollOnce(deps({ now: () => T0 + 610, nftAlertsSince: T0 }))
  expect(await nftRows()).toEqual([])
})

describe("a group that watches a token", () => {
  const off = (mod: (s: ReturnType<typeof basicPreset>) => void = () => {}) => {
    const s = allOff(basicPreset("supergroup"))
    mod(s)
    return s
  }
  const alertsOf = async (chat: string) =>
    (await listDeliveries(sql))
      .filter((r) => r.chat_id === chat)
      .map((r) => r.dedupe_key.split(":")[0])

  it("gets every alert type for it except NEW TOKEN, even with the switches off", async () => {
    await addChat(sql, -1001, "supergroup", off())
    await addChat(sql, -1002, "supergroup", off())
    await watchToken(sql, -1001, L.token)
    await insertEvents(sql, [
      L,
      trade({ soldBps: 8100, quoteAmount: eth(0.01), blockTimestamp: T0 + 2100 }),
      bond({ token: L.token, blockTimestamp: T0 + 2200 }),
    ])
    await pollOnce(deps())
    expect((await alertsOf("-1001")).sort()).toEqual(["bonded", "bonding"])
    expect(await alertsOf("-1002")).toEqual([])
  })

  it("uses the group's BONDING marks", async () => {
    await addChat(
      sql,
      -1001,
      "supergroup",
      off((s) => {
        s.alerts.bonding.marks = [9000]
      }),
    )
    await watchToken(sql, -1001, L.token)
    await insertEvents(sql, [L, trade({ soldBps: 8100, blockTimestamp: T0 + 2100 })])
    await pollOnce(deps())
    // A watching group also gets PUMPING for the jump; only BONDING follows its marks.
    expect(await alertsOf("-1001")).not.toContain("bonding")
    await insertEvents(sql, [trade({ soldBps: 9100, blockTimestamp: T0 + 2200 })])
    await pollOnce(deps())
    expect(
      (await listDeliveries(sql)).map((r) => r.dedupe_key).filter((k) => k.startsWith("bonding")),
    ).toEqual([`bonding:9000:${L.token}`])
  })

  it("uses the group's BIG BUY/SELL percentage", async () => {
    await addChat(sql, -1001, "supergroup", off())
    await addChat(
      sql,
      -1002,
      "supergroup",
      off((s) => {
        s.alerts.big.pctBps = 1000
      }),
    )
    await watchToken(sql, -1001, L.token)
    await watchToken(sql, -1002, L.token)
    await insertEvents(sql, [
      L,
      trade({ soldBps: 4000, blockTimestamp: T0 + 2000 }),
      trade({ soldBps: 4100, quoteAmount: eth(0.15), blockTimestamp: T0 + 2100 }),
    ])
    await pollOnce(deps())
    expect(await alertsOf("-1001")).toContain("big")
    expect(await alertsOf("-1002")).not.toContain("big")
  })

  it("keeps topic routes and paused routes", async () => {
    await addChat(
      sql,
      -1001,
      "supergroup",
      off((s) => {
        s.thread = 7
        s.routes = { bonding: 9 }
        s.pausedRoutes = ["bonded"]
      }),
    )
    await watchToken(sql, -1001, L.token)
    await insertEvents(sql, [
      L,
      trade({ soldBps: 8100, quoteAmount: eth(0.01), blockTimestamp: T0 + 2100 }),
      bond({ token: L.token, blockTimestamp: T0 + 2200 }),
    ])
    await pollOnce(deps())
    const rows = await listDeliveries(sql)
    expect(rows.map((r) => `${r.alert}:${r.thread_id}`)).toEqual(["bonding:9"])
  })

  it("never sends NEW TOKEN, whatever the group's switch says", async () => {
    await addChat(
      sql,
      -1001,
      "supergroup",
      off((s) => {
        s.alerts.new.on = false
      }),
    )
    await watchToken(sql, -1001, L.token)
    await insertEvents(sql, [L])
    await pollOnce(deps())
    expect(await alertsOf("-1001")).toEqual([])
  })
})

it("records the launchpad of every launch it reads", async () => {
  const launchpads = new TokenLaunchpads()
  const A = addr(0xa1)
  await insertEvents(sql, [launch({ token: A }), trade({ token: A })])
  await pollOnce(deps({ launchpads }))
  expect(launchpads.get(A)).toBe("inkypump")
  expect(launchpads.get(addr(0xa2))).toBeUndefined()
})

describe("events the indexer wrote long after their block", () => {
  const DAY = 86_400
  const now = T0 + 30 * DAY

  it("backfilled swaps written long after their block send nothing", async () => {
    await addUser(sql, 901)
    const s = basicPreset("private")
    await addChat(sql, -9001, "supergroup", s)
    await watchToken(sql, -9001, L.token)
    const ids = await insertEvents(sql, [L, bond()])
    await sql`update bot.state set value = ${ids[1]!} where key = 'events_cursor'`
    const late = []
    for (let i = 0; i < 25; i++) {
      // A pool pump from 10 ETH to 14 ETH market cap, with big trades on both sides.
      late.push(
        swap({
          quoteAmount: eth(1),
          quoteLiquidity: eth(5),
          marketCap: eth(10 + (i * 4) / 24),
          blockTimestamp: T0 + 7200 + i * 10,
        }),
        trade({
          trader: C,
          side: "sell",
          quoteAmount: eth(1),
          soldBps: 9000 - i,
          blockTimestamp: T0 + 7200 + i * 10,
        }),
      )
    }
    const lateIds = await insertEvents(sql, late, { writtenAt: now })
    const seen: string[] = []
    const rules: PollerDeps["rules"] = async (ev, ctx, prev) => {
      seen.push(ev.p.type)
      const { rulesFor } = await import("../src/rules/index")
      return rulesFor(ev, ctx, prev)
    }
    expect(await pollOnce(deps({ now: () => now, rules }))).toBe(50)
    expect(seen).toEqual([])
    expect(await sql`select 1 from bot.deliveries`).toHaveLength(0)
    expect(await cursor()).toBe(lateIds.at(-1))
  })

  it("a replay can keep rows written late", async () => {
    await addUser(sql, 903)
    const ids = await insertEvents(sql, [L, bond()])
    await sql`update bot.state set value = ${ids[1]!} where key = 'events_cursor'`
    await insertEvents(sql, [swap({ quoteAmount: eth(0.4), quoteLiquidity: eth(8.4) })], {
      writtenAt: now,
    })
    await pollOnce(deps({ now: () => now, keepLateWrites: true }))
    expect((await listDeliveries(sql)).map((r) => r.alert)).toEqual(["big"])
  })

  it("a swap written on time while the bot was behind still takes the normal path", async () => {
    await addUser(sql, 902)
    const ids = await insertEvents(sql, [L, bond()])
    await sql`update bot.state set value = ${ids[1]!} where key = 'events_cursor'`
    // Written 30 minutes after its block, the longest lag the rules still see.
    const s = swap({ quoteAmount: eth(0.4), quoteLiquidity: eth(8.4) })
    await insertEvents(sql, [s], { writtenAt: s.blockTimestamp + 1800 })
    await pollOnce(deps({ now: () => now }))
    expect((await listDeliveries(sql)).map((r) => r.alert)).toEqual(["big"])
  })

  it("a trade written 1801 s after its block is skipped", async () => {
    await addUser(sql, 904)
    const ids = await insertEvents(sql, [L])
    await sql`update bot.state set value = ${ids[0]!} where key = 'events_cursor'`
    const t = trade({ soldBps: 8100, quoteAmount: eth(0.5), blockTimestamp: T0 + 900 })
    const [id] = await insertEvents(sql, [t], { writtenAt: t.blockTimestamp + 1801 })
    const seen: string[] = []
    const rules: PollerDeps["rules"] = async (ev) => {
      seen.push(ev.id)
      return []
    }
    await pollOnce(deps({ now: () => now, rules }))
    expect(seen).toEqual([])
    expect(await cursor()).toBe(id)
  })
})

describe("launch and bond rows the indexer wrote long after their block", () => {
  const DAY = 86_400
  const now = T0 + 30 * DAY
  const old = T0 + 10 * DAY
  const inkfunLaunches = (n: number, gap: number) =>
    Array.from({ length: n }, (_, i) =>
      launch({
        launchpad: "inkfun",
        token: addr(0x2000 + i),
        creator: addr(0x3000 + i),
        name: `Backfill ${i + 1}`,
        ticker: `B${i + 1}`,
        blockTimestamp: old + i * gap,
        blockNumber: String(3000 + i),
        txHash: hash(0x6000 + i),
      }),
    )
  const alertsOf = async () => (await listDeliveries(sql)).map((r) => r.alert)

  it("backfilled ink.fun launches and trades send nothing", async () => {
    await addUser(sql, 905)
    const launches = inkfunLaunches(65, 600)
    const trades = launches.map((l, i) =>
      trade({
        launchpad: "inkfun",
        token: l.token,
        trader: addr(0x4000 + i),
        blockTimestamp: l.blockTimestamp + 60,
        blockNumber: String(Number(l.blockNumber) + 1),
        txHash: hash(0x7000 + i),
      }),
    )
    const ids = await insertEvents(sql, [...launches, ...trades], { writtenAt: now })
    await pollOnce(deps({ now: () => now }))
    expect(await sql`select 1 from bot.deliveries`).toHaveLength(0)
    expect(await cursor()).toBe(ids.at(-1))
  })

  it("a burst of backfilled launches posts no flood notice and no minute card", async () => {
    await addUser(sql, 906)
    const ids = await insertEvents(sql, inkfunLaunches(14, 2), { writtenAt: now })
    await pollOnce(deps({ now: () => now }))
    expect(await sql`select 1 from bot.deliveries`).toHaveLength(0)
    expect(await cursor()).toBe(ids.at(-1))
  })

  it("a skipped launch still maps its token to ink.fun", async () => {
    const launchpads = new TokenLaunchpads()
    const [l] = inkfunLaunches(1, 1)
    await insertEvents(sql, [l!], { writtenAt: now })
    await pollOnce(deps({ now: () => now, launchpads }))
    expect(launchpads.get(l!.token)).toBe("inkfun")
    expect(await alertsOf()).toEqual([])
  })

  it("a bond written long after its block sends no BONDED", async () => {
    await addUser(sql, 907)
    const ids = await insertEvents(sql, [L])
    await sql`update bot.state set value = ${ids[0]!} where key = 'events_cursor'`
    await insertEvents(sql, [bond({ blockTimestamp: L.blockTimestamp + 100 })], {
      writtenAt: now,
    })
    await pollOnce(deps({ now: () => now }))
    expect(await alertsOf()).toEqual([])
  })

  it("a launch written on time still sends NEW TOKEN", async () => {
    await addUser(sql, 908)
    await insertEvents(sql, [launch({ launchpad: "inkfun" })])
    await pollOnce(deps())
    expect(await alertsOf()).toEqual(["new"])
  })
})

describe("PUMPING after bonding", () => {
  /** A bonded token, with the cursor past its launch and bond. */
  const bonded = async () => {
    const ids = await insertEvents(sql, [L, trade({ txHash: L.txHash, trader: C }), bond()])
    await sql`update bot.state set value = ${ids[2]!} where key = 'events_cursor'`
  }
  /** A pool swap `at` seconds after T0 + 7200, at a market cap of `cap` ETH ($2,500 each). */
  const at = (at: number, cap: number, o: Parameters<typeof swap>[0] = {}) =>
    swap({ marketCap: eth(cap), blockTimestamp: T0 + 7200 + at, ...o })
  const pumpsTo = async (chat: string) =>
    (await listDeliveries(sql)).filter((r) => r.alert === "pumping" && r.chat_id === chat).length
  const pumpRows = async () =>
    (await listDeliveries(sql)).filter((r) => r.alert === "pumping").map((r) => r.chat_id)

  it("fires at +20% over the 10-minute low", async () => {
    await addUser(sql, 1201)
    await bonded()
    await insertEvents(sql, [at(0, 20), at(60, 23.9), at(120, 24)])
    await pollOnce(deps())
    expect(await pumpRows()).toEqual(["1201"])
  })

  it("does not fire again until the gain drops under +5%, then fires again after re-arm", async () => {
    await addUser(sql, 1202)
    await bonded()
    const arm = new PumpArm()
    await insertEvents(sql, [at(0, 20), at(60, 24)])
    await pollOnce(deps({ pumpArm: arm }))
    expect(await pumpsTo("1202")).toBe(1)
    // Still +25% and +21% over the low: armed state holds across batches.
    await insertEvents(sql, [at(120, 25), at(180, 24.2)])
    await pollOnce(deps({ pumpArm: arm }))
    expect(await pumpsTo("1202")).toBe(1)
    // +4.5% re-arms, then +20% fires again.
    await insertEvents(sql, [at(240, 20.9), at(300, 24)])
    await pollOnce(deps({ pumpArm: arm }))
    expect(await pumpsTo("1202")).toBe(2)
  })

  it("two qualifying swaps in one batch send one PUMPING", async () => {
    await addUser(sql, 1203)
    await bonded()
    await insertEvents(sql, [at(0, 20), at(60, 24), at(120, 24.4)])
    await pollOnce(deps())
    expect(await pumpsTo("1203")).toBe(1)
  })

  it("a dip under +5% between them sends two", async () => {
    await addUser(sql, 1204)
    await bonded()
    await insertEvents(sql, [at(0, 20), at(60, 24), at(120, 20.5), at(180, 24.4)])
    await pollOnce(deps())
    expect(await pumpsTo("1204")).toBe(2)
  })

  it("per-chat thresholds: a +30% chat skips a +24% pump", async () => {
    const s = basicPreset("private")
    await addUser(sql, 1205)
    await addUser(sql, 1206, {
      ...s,
      alerts: { ...s.alerts, pumping: { ...s.alerts.pumping, pctBps: 3000 } },
    })
    await bonded()
    await insertEvents(sql, [at(0, 20), at(60, 24.8)])
    await pollOnce(deps())
    expect(await pumpRows()).toEqual(["1205"])
  })

  it("feed floor blocks a $40K token but a watcher gets it", async () => {
    await addUser(sql, 1207)
    const w = await addUser(sql, 1208)
    await subscribe(sql, w, "watch", L.token)
    await addChat(sql, -1209, "supergroup", allOff(basicPreset("supergroup")))
    await watchToken(sql, -1209, L.token)
    await bonded()
    // 13 ETH to 16 ETH: +23%, at $40K.
    await insertEvents(sql, [at(0, 13), at(60, 16)])
    await pollOnce(deps())
    expect((await pumpRows()).sort()).toEqual(["-1209", "1208"])
  })

  it("a lower floor lets the feed have it", async () => {
    const s = basicPreset("private")
    await addUser(sql, 1210, {
      ...s,
      alerts: { ...s.alerts, pumping: { ...s.alerts.pumping, floorUsd: 25_000 } },
    })
    await bonded()
    await insertEvents(sql, [at(0, 13), at(60, 16)])
    await pollOnce(deps())
    expect(await pumpRows()).toEqual(["1210"])
  })

  it("a watcher still needs its own threshold", async () => {
    const s = basicPreset("private")
    const w = await addUser(sql, 1211, {
      ...s,
      alerts: { ...s.alerts, pumping: { ...s.alerts.pumping, pctBps: 5000 } },
    })
    await subscribe(sql, w, "watch", L.token)
    await bonded()
    await insertEvents(sql, [at(0, 20), at(60, 28)])
    await pollOnce(deps())
    expect(await pumpRows()).toEqual([])
  })

  it("stale price blocks the feed but not a watcher", async () => {
    await addUser(sql, 1212)
    const w = await addUser(sql, 1213)
    await subscribe(sql, w, "watch", L.token)
    await bonded()
    await insertEvents(sql, [at(0, 20), at(60, 30)])
    const stale: Prices = { usd: () => null, symbol: () => "ETH" }
    await pollOnce(deps({ prices: stale }))
    expect(await pumpRows()).toEqual(["1213"])
  })

  it("bonded PUMPING ignores the hourly cooldown", async () => {
    await addUser(sql, 1214)
    await bonded()
    await sql`
      insert into bot.deliveries (chat_id, chat_type, alert, token, dedupe_key, priority, event_ts, card)
      values (1214, 'private', 'pumping', ${L.token}, 'pump:earlier', 3, to_timestamp(${T0 + 7100}), '{}')`
    await insertEvents(sql, [at(0, 20), at(60, 24)])
    await pollOnce(deps())
    expect(await pumpsTo("1214")).toBe(2)
  })

  it("reads only the last two hours of PUMPING deliveries for the cooldown", async () => {
    for (const [key, ts] of [
      ["pump:old", T0 - 2 * 3600 - 1],
      ["pump:recent", T0 - 3599],
    ] as const)
      await sql`
        insert into bot.deliveries (chat_id, chat_type, alert, token, dedupe_key, priority, event_ts, card)
        values (1219, 'private', 'pumping', ${L.token}, ${key}, 3, to_timestamp(${ts}), '{}')`
    const { loadAudience } = await import("../src/delivery/recipients")
    const aud = await loadAudience(sql, [L.token], T0)
    expect(aud.lastPump.get(`1219:${L.token}`)?.map((p) => p.key)).toEqual(["pump:recent"])
  })

  it("curve PUMPING still uses the hourly cooldown", async () => {
    await addUser(sql, 1215)
    await insertEvents(sql, [L])
    await sql`
      insert into bot.deliveries (chat_id, chat_type, alert, token, dedupe_key, priority, event_ts, card)
      values (1215, 'private', 'pumping', ${L.token}, 'pump:earlier', 3, to_timestamp(${T0 + 30}), '{}')`
    await insertEvents(sql, [trade({ soldBps: 2000, blockTimestamp: T0 + 60 })])
    await pollOnce(deps({ now: () => T0 + 60 }))
    expect(await pumpsTo("1215")).toBe(1)
  })

  it("a failed write does not mark the recipient", async () => {
    await addUser(sql, 1216)
    await bonded()
    const arm = new PumpArm()
    await insertEvents(sql, [at(0, 20), at(60, 24)])
    await sql`alter table bot.deliveries add constraint no_pumps check (alert <> 'pumping') not valid`
    await expect(pollOnce(deps({ pumpArm: arm }))).rejects.toThrow()
    await sql`alter table bot.deliveries drop constraint no_pumps`
    await pollOnce(deps({ pumpArm: arm }))
    expect(await pumpsTo("1216")).toBe(1)
  })

  it("a failed second write keeps the re-arm from events before it", async () => {
    await addUser(sql, 1218)
    await bonded()
    const arm = new PumpArm()
    await insertEvents(sql, [at(0, 20), at(60, 24)])
    await pollOnce(deps({ pumpArm: arm }))
    expect(await pumpsTo("1218")).toBe(1)
    // A dip to +2.5% re-arms, then +22.5% pumps. The pump waits for the second write (it carries dev holds),
    // which fails; the dip was written by the first.
    await insertEvents(sql, [at(120, 20.5), at(180, 24.5)])
    await sql`alter table bot.deliveries add constraint no_pumps check (alert <> 'pumping') not valid`
    await expect(pollOnce(deps({ pumpArm: arm }))).rejects.toThrow()
    await sql`alter table bot.deliveries drop constraint no_pumps`
    await pollOnce(deps({ pumpArm: arm }))
    expect(await pumpsTo("1218")).toBe(2)
  })

  it("a bonded PUMPING card carries dev holds", async () => {
    await addUser(sql, 1217)
    await bonded()
    await insertEvents(sql, [at(0, 20), at(60, 24)])
    const asked: unknown[] = []
    await pollOnce(
      deps({
        readHolds: async (r) => {
          asked.push(r)
          return { pct: 4.2, now: false }
        },
      }),
    )
    const [row] = (await listDeliveries(sql)).filter((r) => r.alert === "pumping")
    expect(asked).toMatchObject([{ token: L.token, holder: C }])
    const rows = row!.card.type === "card" ? row!.card.card.rows : []
    expect(rows.map(([k]) => k)).toEqual([
      "pumped",
      "mcap",
      "ath",
      "liquidity",
      "volume",
      "trades",
      "buyers",
      "dev holds",
      "bonded",
    ])
    expect(rows[7]).toEqual(["dev holds", "4.2%"])
  })
})

describe("MCAP TARGET", () => {
  /** A bonded token with the cursor past its launch and bond; swaps run from T0 + 7200. */
  const bondedToken = async () => {
    const ids = await insertEvents(sql, [L, bond()])
    await sql`update bot.state set value = ${ids[1]!} where key = 'events_cursor'`
  }
  const AT = T0 + 7200
  const mc = (usd: number) => eth(usd / 2500)
  const over = (o: Parameters<typeof swap>[0] = {}) =>
    swap({ marketCap: mc(520_000), blockTimestamp: AT, ...o })
  const userTarget = async (tg: number, usd: number, up = true) => {
    const id = await addUser(sql, tg)
    await sql`
      insert into bot.subscriptions (user_id, kind, target, target_usd, target_up, target_set_usd, target_set_at)
      values (${id}, 'watch', ${L.token}, ${usd}, ${up}, 210000, to_timestamp(${T0}))`
    return id
  }
  const targets = async () =>
    (
      await sql<{ usd: number | null }[]>`
        select target_usd::float8 as usd from bot.subscriptions where kind = 'watch'
        union all select target_usd::float8 from bot.chat_token_watches`
    ).map((r) => r.usd)
  const mcapRows = async () =>
    (await listDeliveries(sql))
      .filter((r) => r.alert === "mcap")
      .map((r) => `${r.chat_id}:${r.thread_id ?? "-"}`)
  const at = (n: number) => deps({ now: () => n })

  it("fires once and clears: the next swap above target sends nothing", async () => {
    await userTarget(1301, 500_000)
    await bondedToken()
    await insertEvents(sql, [over(), over({ blockTimestamp: AT + 30 })])
    await pollOnce(at(AT + 60))
    expect(await mcapRows()).toEqual(["1301:-"])
    expect(await targets()).toEqual([null])
    await insertEvents(sql, [over({ blockTimestamp: AT + 90 })])
    await pollOnce(at(AT + 120))
    expect(await mcapRows()).toEqual(["1301:-"])
  })

  it("a replaced target is not cleared by an older crossing", async () => {
    const id = await userTarget(1302, 500_000)
    await bondedToken()
    await insertEvents(sql, [over()])
    // The user sets a new target while the batch is between its rules and its write.
    const rules: PollerDeps["rules"] = async (ev, ctx, prev) => {
      const { rulesFor } = await import("../src/rules/index")
      const out = await rulesFor(ev, ctx, prev)
      await sql`update bot.subscriptions set target_usd = 750000 where user_id = ${id}`
      return out
    }
    await pollOnce(deps({ now: () => AT, rules }))
    expect(await mcapRows()).toEqual([])
    expect(await targets()).toEqual([750_000])
  })

  it("the same target set again after it fired fires again", async () => {
    const id = await userTarget(1311, 500_000)
    await bondedToken()
    await insertEvents(sql, [over()])
    await pollOnce(at(AT))
    expect(await mcapRows()).toEqual(["1311:-"])
    // Set again, to the same amount, after the first crossing.
    await sql`
      update bot.subscriptions set target_usd = 500000, target_up = true, target_set_usd = 210000,
        target_set_at = to_timestamp(${AT + 60}) + interval '123456 microseconds'
      where user_id = ${id} and kind = 'watch'`
    await insertEvents(sql, [over({ blockTimestamp: AT + 120 })])
    await pollOnce(at(AT + 120))
    expect(await mcapRows()).toEqual(["1311:-", "1311:-"])
    expect(await targets()).toEqual([null])
  })

  it("the same target set again during a crossing's batch is kept for the next crossing", async () => {
    const id = await userTarget(1312, 500_000)
    await bondedToken()
    await insertEvents(sql, [over()])
    // Between the rules and the write, the user sets the same amount again: a new target, set after the crossing.
    const rules: PollerDeps["rules"] = async (ev, ctx, prev) => {
      const { rulesFor } = await import("../src/rules/index")
      const out = await rulesFor(ev, ctx, prev)
      await sql`update bot.subscriptions set target_set_at = to_timestamp(${AT + 30}) where user_id = ${id} and kind = 'watch'`
      return out
    }
    await pollOnce(deps({ now: () => AT, rules }))
    expect(await mcapRows()).toEqual([])
    expect(await targets()).toEqual([500_000])
    await insertEvents(sql, [over({ blockTimestamp: AT + 60 })])
    await pollOnce(at(AT + 60))
    expect(await mcapRows()).toEqual(["1312:-"])
    expect(await targets()).toEqual([null])
  })

  it("an event older than 30 minutes does not fire; the next fresh one does", async () => {
    await userTarget(1303, 500_000)
    await bondedToken()
    await insertEvents(sql, [over()])
    await pollOnce(at(AT + 1801))
    expect(await mcapRows()).toEqual([])
    expect(await targets()).toEqual([500_000])
    await insertEvents(sql, [over({ blockTimestamp: AT + 1900 })])
    await pollOnce(at(AT + 1910))
    expect(await mcapRows()).toEqual(["1303:-"])
  })

  it("stale price, then recovery past the target, fires once", async () => {
    await userTarget(1304, 500_000)
    await bondedToken()
    await insertEvents(sql, [over(), over({ blockTimestamp: AT + 30 })])
    const stale: Prices = { usd: () => null, symbol: () => "ETH" }
    await pollOnce(deps({ now: () => AT + 60, prices: stale }))
    expect(await mcapRows()).toEqual([])
    expect(await targets()).toEqual([500_000])
    await insertEvents(sql, [over({ blockTimestamp: AT + 90 }), over({ blockTimestamp: AT + 95 })])
    await pollOnce(at(AT + 100))
    expect(await mcapRows()).toEqual(["1304:-"])
    expect(await targets()).toEqual([null])
  })

  it("a group target goes to the group, not to members", async () => {
    await addUser(sql, 1305)
    await addChat(sql, -1306, "supergroup", { ...basicPreset("supergroup"), thread: 4 })
    await sql`
      insert into bot.chat_token_watches (chat_id, target, target_usd, target_up, target_set_usd, target_set_at)
      values (-1306, ${L.token}, 500000, true, 210000, to_timestamp(${T0}))`
    await bondedToken()
    await insertEvents(sql, [over()])
    await pollOnce(at(AT))
    expect(await mcapRows()).toEqual(["-1306:4"])
    expect(await targets()).toEqual([null])
  })

  it("a group target follows routes.mcap, and a paused mcap route keeps the target", async () => {
    const s = basicPreset("supergroup")
    await addChat(sql, -1307, "supergroup", { ...s, thread: 4, routes: { mcap: 8 } })
    await addChat(sql, -1308, "supergroup", { ...s, routes: { mcap: 8 }, pausedRoutes: ["mcap"] })
    for (const chat of [-1307, -1308])
      await sql`
        insert into bot.chat_token_watches (chat_id, target, target_usd, target_up, target_set_usd, target_set_at)
        values (${chat}, ${L.token}, 500000, true, 210000, to_timestamp(${T0}))`
    await bondedToken()
    await insertEvents(sql, [over()])
    await pollOnce(at(AT))
    expect(await mcapRows()).toEqual(["-1307:8"])
    const left = await sql<{ chat_id: string; usd: number | null }[]>`
      select chat_id::text, target_usd::float8 as usd from bot.chat_token_watches order by chat_id`
    expect(left).toEqual([
      { chat_id: "-1307", usd: null },
      { chat_id: "-1308", usd: 500_000 },
    ])
  })

  it("a muted user's target never fires", async () => {
    const id = await userTarget(1309, 500_000)
    await sql`insert into bot.subscriptions (user_id, kind, target) values (${id}, 'mute', ${L.token})`
    await bondedToken()
    await insertEvents(sql, [over()])
    await pollOnce(at(AT))
    expect(await mcapRows()).toEqual([])
  })

  it("MCAP TARGET and BIG BUY from one swap both reach a watcher", async () => {
    await userTarget(1310, 500_000)
    await bondedToken()
    await insertEvents(sql, [over({ quoteAmount: eth(0.4), quoteLiquidity: eth(8.4) })])
    await pollOnce(at(AT))
    expect(
      (await listDeliveries(sql))
        .filter((r) => r.chat_id === "1310")
        .map((r) => r.alert)
        .sort(),
    ).toEqual(["big", "mcap"])
  })
})

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import type { Sql } from "../src/db"
import {
  bondOf,
  creatorStats,
  cursorBlock,
  eventsAfter,
  hotNow,
  justBonded,
  launchesOf,
  launchOf,
  maxEventId,
  nearBonding,
  tradesOf,
} from "../src/history"
import { insertEvents, resetDb, setCursorBlock } from "./helpers/db"
import { addr, bond, launch, trade } from "./helpers/events"
import { loadFixture } from "./helpers/fixtures"

let sql: Sql
beforeAll(async () => {
  sql = await resetDb(inject("databaseUrl"))
})
afterAll(() => sql.end())

describe("synthetic events", () => {
  const C = addr(0xc1)
  const A = addr(0xa1)
  const B = addr(0xb1)
  let ids: string[] = []
  beforeAll(async () => {
    ids = await insertEvents(sql, [
      launch({ token: A, creator: C, blockNumber: "100" }),
      trade({ token: A, soldBps: 9000, blockNumber: "101" }),
      bond({ token: A, blockNumber: "102" }),
      launch({ token: B, creator: C, blockNumber: "103" }),
      trade({ token: B, soldBps: 4000, blockNumber: "104" }),
      trade({ token: B, soldBps: 4500, blockNumber: "105" }),
    ])
    await sql`update indexer.events set confirmed = false where id = ${ids[5]!}`
    await setCursorBlock(sql, 105)
  })

  it("stops at maxId when given", async () => {
    const evs = await eventsAfter(sql, ids[0]!, 500, ids[2]!)
    expect(evs.map((e) => e.id)).toEqual([ids[1], ids[2]])
  })

  it("reads confirmed events after a cursor, in id order", async () => {
    const evs = await eventsAfter(sql, ids[0]!)
    expect(evs.map((e) => e.p.type)).toEqual([
      "launchpad.trade",
      "launchpad.bond",
      "launchpad.launch",
      "launchpad.trade",
    ])
    expect(await maxEventId(sql)).toBe(ids[4])
  })

  it("reads a token's launch, trades up to an id, and bond", async () => {
    expect((await launchOf(sql, B))?.p.creator).toBe(C)
    expect((await tradesOf(sql, B, ids[4]!)).map((t) => t.p.soldBps)).toEqual([4000])
    expect((await tradesOf(sql, B)).length).toBe(2)
    expect((await bondOf(sql, A))?.p.type).toBe("launchpad.bond")
    expect(await bondOf(sql, B)).toBeNull()
    expect(await launchOf(sql, addr(0xdead))).toBeNull()
  })

  it("counts a creator's launches and bonds up to an id", async () => {
    expect(await creatorStats(sql, C, ids[3]!)).toEqual({ launches: 2, bonded: 1 })
    expect(await creatorStats(sql, C, ids[0]!)).toEqual({ launches: 1, bonded: 0 })
  })

  it("lists hot, near-bonding and bonded tokens", async () => {
    expect(await hotNow(sql)).toEqual([
      { token: B, trades: 2 },
      { token: A, trades: 1 },
    ])
    expect(await nearBonding(sql)).toEqual([{ token: B, soldBps: 4500 }])
    expect((await justBonded(sql)).map((b) => b.p.token)).toEqual([A])
    expect((await launchesOf(sql, [A, B])).get(B)?.creator).toBe(C)
    expect(await cursorBlock(sql)).toBe("105")
  })
})

describe("real fixtures", () => {
  it("loads the bonded MIM history", async () => {
    await resetDb(inject("databaseUrl")).then((s) => s.end())
    const evs = loadFixture("bonded-mim")
    await insertEvents(sql, evs)
    const token = evs[0]!.token
    expect((await tradesOf(sql, token)).length).toBe(133)
    expect(await bondOf(sql, token)).not.toBeNull()
  })
})

describe("id ordering", () => {
  it("orders by numeric id, not by the id's text form", async () => {
    // ids 1..120 cross 9 to 10 and 99 to 100, where text order differs from numeric order.
    const own = await resetDb(inject("databaseUrl"))
    try {
      const T = addr(0xe1)
      const ids = await insertEvents(
        own,
        Array.from({ length: 120 }, (_, i) =>
          trade({ token: T, soldBps: 1000 + i, blockNumber: String(100 + i) }),
        ),
      )
      const first = await eventsAfter(own, "0", 100)
      expect(first.map((e) => e.id)).toEqual(ids.slice(0, 100))
      expect((await tradesOf(own, T)).map((t) => t.id)).toEqual(ids)
      expect((await tradesOf(own, T, ids[99]!)).map((t) => t.id)).toEqual(ids.slice(0, 100))
    } finally {
      await own.end()
    }
  })
})

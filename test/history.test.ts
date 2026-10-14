import type { Address } from "@ink-indexer/events"
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
    expect(await hotNow(sql)).toEqual({
      window: "24h",
      rows: [
        { token: B, trades: 2 },
        { token: A, trades: 1 },
      ],
    })
    expect(await nearBonding(sql)).toEqual([{ token: B, soldBps: 4500 }])
    expect((await justBonded(sql)).map((b) => b.p.token)).toEqual([A])
    expect((await launchesOf(sql, [A, B])).get(B)?.creator).toBe(C)
    expect(await cursorBlock(sql)).toBe("105")
  })
})

describe("discovery windows", () => {
  const CUR = 1_000_000
  const DAY = 86_400
  const [H1, H2, N1, N2, N3, N4, N5] = [0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7].map(addr) as [
    Address,
    Address,
    Address,
    Address,
    Address,
    Address,
    Address,
  ]
  const at = (token: Address, soldBps: number, blocksAgo: number) =>
    trade({ token, soldBps, blockNumber: String(CUR - blocksAgo) })
  const withDb = async (events: ReturnType<typeof trade>[], fn: (s: Sql) => Promise<void>) => {
    const own = await resetDb(inject("databaseUrl"))
    try {
      await insertEvents(own, events)
      await setCursorBlock(own, CUR)
      await fn(own)
    } finally {
      await own.end()
    }
  }

  it("ranks hot tokens by trades in the last 24h", async () => {
    await withDb(
      [at(H1, 2000, 10), at(H2, 2000, 20), at(H2, 2100, 30), at(H1, 2000, DAY + 5)],
      async (s) => {
        expect(await hotNow(s)).toEqual({
          window: "24h",
          rows: [
            { token: H2, trades: 2 },
            { token: H1, trades: 1 },
          ],
        })
      },
    )
  })

  it("falls back to 7 days when nothing traded in 24h, and to nothing after that", async () => {
    await withDb(
      [at(H1, 2000, DAY + 5), at(H1, 2100, DAY * 3), at(H2, 2000, DAY * 6)],
      async (s) => {
        expect(await hotNow(s)).toEqual({
          window: "7d",
          rows: [
            { token: H1, trades: 2 },
            { token: H2, trades: 1 },
          ],
        })
      },
    )
    await withDb([at(H1, 2000, DAY * 8)], async (s) => {
      expect(await hotNow(s)).toEqual({ window: "7d", rows: [] })
    })
  })

  it("ranks unbonded tokens traded in 7 days by latest progress, from 10% up", async () => {
    await withDb(
      [
        // N1: latest trade is 55% (an earlier 90% sell-off does not count).
        at(N1, 9000, DAY * 3),
        at(N1, 5500, 100),
        // N2: 12%, six days ago.
        at(N2, 1200, DAY * 6),
        // N3: exactly 10%.
        at(N3, 1000, 50),
        // N4: 9.99%, N5: 0%, and a token with no trade in 7 days.
        at(N4, 999, 50),
        at(N5, 0, 50),
        at(H1, 8000, DAY * 8),
        // H2 bonded.
        at(H2, 9900, 50),
      ],
      async (s) => {
        await insertEvents(s, [bond({ token: H2, blockNumber: String(CUR - 40) })])
        expect(await nearBonding(s)).toEqual([
          { token: N1, soldBps: 5500 },
          { token: N2, soldBps: 1200 },
          { token: N3, soldBps: 1000 },
        ])
      },
    )
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

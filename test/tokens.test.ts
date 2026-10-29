import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import type { Sql } from "../src/db"
import { findTokens } from "../src/tokens"
import { insertEvents, resetDb } from "./helpers/db"
import { addr, bond, launch, swap, T0, trade } from "./helpers/events"

const OLD = addr(0xa1)
const NEW = addr(0xa2)
const BONDED = addr(0xa3)
const OTHER = addr(0xa4)
const QUIET = addr(0xa5)

let sql: Sql
beforeAll(async () => {
  sql = await resetDb(inject("databaseUrl"))
  await insertEvents(sql, [
    launch({ token: OLD, ticker: "GOBLO", name: "Goblo" }),
    launch({ token: NEW, ticker: "GOBLO", name: "Goblo two" }),
    launch({ token: BONDED, ticker: "GOB", name: "Goblo" }),
    launch({ token: OTHER, ticker: "PEPE", name: "Pepe" }),
    launch({ token: QUIET, ticker: "goblo", name: null }),
    trade({ token: OLD, blockTimestamp: T0 + 100 }),
    trade({ token: NEW, blockTimestamp: T0 + 500 }),
    trade({ token: BONDED, blockTimestamp: T0 + 50 }),
    bond({ token: BONDED }),
    swap({ token: BONDED, blockTimestamp: T0 + 9000 }),
  ])
})
afterAll(() => sql.end())

describe("findTokens", () => {
  it("findTokens ranks bonded first then recent trading", async () => {
    const hits = await findTokens(sql, "goblo")
    expect(hits.map((h) => h.token)).toEqual([BONDED, NEW, OLD, QUIET])
    expect(hits[0]).toEqual({
      token: BONDED,
      ticker: "GOB",
      name: "Goblo",
      bonded: true,
      lastTradeTs: T0 + 9000,
    })
    expect(hits[1]).toMatchObject({ bonded: false, lastTradeTs: T0 + 500 })
    expect(hits[3]).toMatchObject({ ticker: "goblo", name: null, lastTradeTs: null })
  })

  it("findTokens matches $TICKER and name case-insensitively", async () => {
    expect((await findTokens(sql, "$Pepe")).map((h) => h.token)).toEqual([OTHER])
    expect((await findTokens(sql, "PEPE")).map((h) => h.token)).toEqual([OTHER])
    expect((await findTokens(sql, "goblo TWO")).map((h) => h.token)).toEqual([NEW])
    expect(await findTokens(sql, "gob two")).toEqual([])
    expect(await findTokens(sql, "pep")).toEqual([])
  })

  it("returns at most 8 tokens", async () => {
    const own = await resetDb(inject("databaseUrl"))
    try {
      await insertEvents(
        own,
        Array.from({ length: 10 }, (_, i) => launch({ token: addr(0xb0 + i), ticker: "MANY" })),
      )
      expect(await findTokens(own, "many")).toHaveLength(8)
    } finally {
      await own.end()
    }
  })

  it("ranks a token that started in a pool with the bonded tokens", async () => {
    const own = await resetDb(inject("databaseUrl"))
    try {
      const POOL = addr(0xc5)
      await insertEvents(own, [
        launch({ token: OLD, ticker: "ZAP" }),
        launch({ token: POOL, ticker: "ZAP", startsInPool: true, targetRaise: null }),
        trade({ token: OLD, blockTimestamp: T0 + 500 }),
        swap({ token: POOL, blockTimestamp: T0 + 100 }),
      ])
      const hits = await findTokens(own, "zap")
      expect(hits.map((h) => [h.token, h.bonded])).toEqual([
        [POOL, true],
        [OLD, false],
      ])
    } finally {
      await own.end()
    }
  })
})

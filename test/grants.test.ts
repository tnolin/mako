import { afterAll, beforeAll, expect, inject, it } from "vitest"
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
import { connectAsBotRole } from "./helpers/roles"

let admin: Sql
let bot: Sql

beforeAll(async () => {
  admin = await resetDb(inject("databaseUrl"))
  await insertEvents(admin, [launch(), trade(), bond()])
  await setCursorBlock(admin, 2000)
  bot = await connectAsBotRole(admin, inject("databaseUrl"))
})
afterAll(async () => {
  await bot.end()
  await admin.end()
})

it("runs every indexer read as the bot role", async () => {
  const T = addr(0xd1)
  await eventsAfter(bot, "0")
  await maxEventId(bot)
  await launchOf(bot, T)
  await tradesOf(bot, T, "99")
  await bondOf(bot, T)
  await creatorStats(bot, addr(0xc1), "99")
  await cursorBlock(bot)
  await hotNow(bot)
  await nearBonding(bot)
  await justBonded(bot)
  await launchesOf(bot, [T])
})

it("cannot read any other indexer table", async () => {
  await admin`create table indexer.tokens (address text)`
  await expect(bot`select * from indexer.tokens`).rejects.toThrow(/permission denied/)
})

it("uses the bot indexes for creator lookups and the latest bonds", async () => {
  const plan = (q: string) =>
    bot.begin(async (tx) => {
      await tx`set local enable_seqscan = off`
      return (await tx.unsafe(`explain ${q}`)).map((r) => r["QUERY PLAN"]).join("\n")
    })
  expect(
    await plan(
      `select entity from indexer.events where type = 'launchpad.launch' and payload->>'creator' = '0xc1' and id <= 99`,
    ),
  ).toContain("events_launch_creator")
  expect(
    await plan(
      `select id, payload from indexer.events where type = 'launchpad.bond' order by id desc limit 5`,
    ),
  ).toContain("events_type_id")
})

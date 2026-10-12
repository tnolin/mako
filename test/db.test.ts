import { afterAll, beforeAll, expect, inject, it } from "vitest"
import { migrate, type Sql } from "../src/db"
import { insertEvents, resetDb } from "./helpers/db"
import { launch, trade } from "./helpers/events"

let sql: Sql
beforeAll(async () => {
  sql = await resetDb(inject("databaseUrl"))
})
afterAll(() => sql.end())

it("creates the bot schema once", async () => {
  expect(await migrate(sql)).toEqual([])
  const tables = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables where table_schema = 'bot' order by 1`
  expect(tables.map((t) => t.table_name)).toEqual([
    "chats",
    "commands_daily",
    "deliveries",
    "delivery_daily",
    "migrations",
    "notices",
    "state",
    "subscriptions",
    "user_actions",
    "users",
  ])
})

it("gives deliveries random uuid ids", async () => {
  const [a, b] = await sql<{ id: string }[]>`
    insert into bot.deliveries (chat_id, chat_type, alert, dedupe_key, priority, event_ts, card)
    values (1, 'private', 'new', 'k1', 5, now(), '{}'), (1, 'private', 'new', 'k2', 5, now(), '{}')
    returning id`
  expect(a?.id).toMatch(/^[0-9a-f-]{36}$/)
  expect(a?.id).not.toBe(b?.id)
})

it("inserts indexer events in order through the harness", async () => {
  const ids = await insertEvents(sql, [launch(), trade({ side: "buy" })])
  expect(ids).toHaveLength(2)
  const rows = await sql`select type, entity, confirmed from indexer.events order by id`
  expect(rows.map((r) => r.type)).toEqual(["launchpad.launch", "launchpad.trade"])
  expect(rows.every((r) => r.confirmed)).toBe(true)
})

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
    "chat_token_watches",
    "chats",
    "collection_mutes",
    "commands_daily",
    "deliveries",
    "delivery_daily",
    "migrations",
    "nft_watches",
    "notices",
    "reminders",
    "state",
    "subscriptions",
    "token_images",
    "user_actions",
    "users",
  ])
})

it("keeps chat token watches without a foreign key on chat_id", async () => {
  const fks = await sql`
    select 1 from information_schema.table_constraints
    where table_schema = 'bot' and table_name = 'chat_token_watches' and constraint_type = 'FOREIGN KEY'`
  expect(fks).toHaveLength(0)
  const idx = await sql<{ indexdef: string }[]>`
    select indexdef from pg_indexes where schemaname = 'bot' and tablename = 'chat_token_watches'`
  expect(idx.some((i) => i.indexdef.includes("(target)"))).toBe(true)
  await sql`insert into bot.chat_token_watches (chat_id, target) values (-1, '0xaa')`
  await expect(
    sql`insert into bot.chat_token_watches (chat_id, target) values (-1, '0xaa')`,
  ).rejects.toThrow()
  await sql`delete from bot.chat_token_watches`
})

it("keeps a market cap target on token watches only", async () => {
  const cols = await sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name from information_schema.columns
    where table_schema = 'bot' and column_name like 'target\\_%'
    order by table_name, column_name`
  const targets = ["target_set_at", "target_set_usd", "target_up", "target_usd"]
  expect(cols.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([
    ...targets.map((c) => `chat_token_watches.${c}`),
    ...targets.map((c) => `subscriptions.${c}`),
  ])
  const [u] = await sql<{ id: string }[]>`
    insert into bot.users (platform_user_id, settings) values (77, '{}') returning id::text`
  await expect(
    sql`insert into bot.subscriptions (user_id, kind, target, target_usd) values (${u!.id}, 'mute', '0xaa', 5)`,
  ).rejects.toThrow(/subscriptions_target_watch/)
  await sql`insert into bot.subscriptions (user_id, kind, target, target_usd) values (${u!.id}, 'watch', '0xaa', 5)`
  await sql`delete from bot.users where id = ${u!.id}`
})

it("stores one file_id per token and ignores a second insert", async () => {
  await sql`insert into bot.token_images (token, file_id) values ('0xaa', 'f1')`
  await sql`insert into bot.token_images (token, file_id) values ('0xaa', 'f2') on conflict do nothing`
  expect(await sql`select token, file_id from bot.token_images`).toEqual([
    { token: "0xaa", file_id: "f1" },
  ])
  await sql`delete from bot.token_images`
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

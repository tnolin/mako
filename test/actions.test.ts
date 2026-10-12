import { afterAll, beforeAll, expect, inject, it } from "vitest"
import { logAction } from "../src/actions"
import type { Sql } from "../src/db"
import { resetDb } from "./helpers/db"

let sql: Sql
beforeAll(async () => {
  sql = await resetDb(inject("databaseUrl"))
})
afterAll(() => sql.end())

it("stores no chat id for private chats and keeps it for groups and channels", async () => {
  await logAction(sql, { chatType: "private", chatId: 12345, action: "watch", token: "0xd1" })
  await logAction(sql, { chatType: "supergroup", chatId: -1001, action: "setup" })
  await logAction(sql, {
    chatType: "channel",
    chatId: -1002,
    action: "route",
    params: { alert: "new", on: true },
  })
  const rows =
    await sql`select chat_type, chat_id::text, action, token, params from bot.user_actions order by id`
  expect(rows).toEqual([
    { chat_type: "private", chat_id: null, action: "watch", token: "0xd1", params: {} },
    { chat_type: "supergroup", chat_id: "-1001", action: "setup", token: null, params: {} },
    {
      chat_type: "channel",
      chat_id: "-1002",
      action: "route",
      token: null,
      params: { alert: "new", on: true },
    },
  ])
  const cols =
    await sql`select column_name from information_schema.columns where table_schema = 'bot' and table_name = 'user_actions'`
  expect(cols.map((c) => c.column_name)).not.toContain("user_id")
})

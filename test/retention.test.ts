import { afterAll, beforeAll, expect, inject, it } from "vitest"
import type { Sql } from "../src/db"
import { msUntil0300Utc, runRetention } from "../src/delivery/retention"
import { resetDb } from "./helpers/db"

let sql: Sql
beforeAll(async () => {
  sql = await resetDb(inject("databaseUrl"))
})
afterAll(() => sql.end())

it("rolls deliveries older than 90 days into daily counts and deletes them", async () => {
  await sql`
    insert into bot.deliveries (chat_id, chat_type, alert, dedupe_key, priority, event_ts, card, status, created_at) values
      (1, 'private', 'new', 'a', 5, now(), '{}', 'sent', now() - interval '100 days'),
      (2, 'private', 'new', 'b', 5, now(), '{}', 'sent', now() - interval '100 days'),
      (3, 'supergroup', 'bonded', 'c', 1, now(), '{}', 'skipped', now() - interval '100 days'),
      (4, 'private', 'new', 'd', 5, now(), '{}', 'sent', now() - interval '10 days')`
  expect(await runRetention(sql)).toBe(3)
  expect(
    await sql`select alert, chat_type, status, count::int from bot.delivery_daily order by alert`,
  ).toEqual([
    { alert: "bonded", chat_type: "supergroup", status: "skipped", count: 1 },
    { alert: "new", chat_type: "private", status: "sent", count: 2 },
  ])
  expect((await sql`select chat_id::text from bot.deliveries`).map((r) => r.chat_id)).toEqual(["4"])
})

it("schedules the next run at 03:00 UTC", () => {
  expect(msUntil0300Utc(new Date("2026-10-12T01:00:00Z"))).toBe(2 * 3600_000)
  expect(msUntil0300Utc(new Date("2026-10-12T04:00:00Z"))).toBe(23 * 3600_000)
})

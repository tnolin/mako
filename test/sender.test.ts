import type postgres from "postgres"
import { afterAll, beforeEach, expect, inject, it, vi } from "vitest"
import type { Payload } from "../src/cards/card"
import type { Sql } from "../src/db"
import type { Notify } from "../src/delivery/notices"
import { pollOnce } from "../src/delivery/poller"
import { createSender, type SenderDeps, startSender } from "../src/delivery/sender"
import type { PendingRow, SendResult } from "../src/platforms/telegram/send"
import { basicPreset } from "../src/settings"
import { addChat, addUser } from "./helpers/bot"
import { insertEvents, resetDb } from "./helpers/db"
import { loadFixture } from "./helpers/fixtures"

let sql: Sql
let t = 1_000_000
const sent: PendingRow[] = []
let respond: (r: PendingRow) => SendResult = () => ({ ok: true })
const notify = vi.fn<Notify>(async () => {})
const report = vi.fn()

beforeEach(async () => {
  await sql?.end()
  sql = await resetDb(inject("databaseUrl"))
  sent.length = 0
  respond = () => ({ ok: true })
  notify.mockClear()
  report.mockClear()
  t = 1_000_000
})
afterAll(() => sql.end())

const sender = (over: Partial<SenderDeps> = {}) =>
  createSender({
    sql,
    send: async (r) => {
      sent.push(r)
      return respond(r)
    },
    notify,
    log: () => {},
    report,
    now: () => t,
    ...over,
  })

const card: Payload = { type: "text", html: "x" }
async function enqueue(
  chatId: number,
  alert: string,
  o: {
    chatType?: string
    priority?: number
    ageMin?: number
    thread?: number | null
    key?: string
    /** Seconds from now until the row may be sent; negative is in the past. */
    sendAfterSec?: number
  } = {},
) {
  const sendAfter = o.sendAfterSec === undefined ? null : `${o.sendAfterSec} seconds`
  await sql`
    insert into bot.deliveries (chat_id, chat_type, thread_id, alert, token, dedupe_key, priority, event_ts, send_after, card)
    values (${chatId}, ${o.chatType ?? "supergroup"}, ${o.thread ?? null}, ${alert}, '0xd1', ${o.key ?? `${alert}:${Math.random()}`},
            ${o.priority ?? 5}, now() - ${`${o.ageMin ?? 0} minutes`}::interval,
            now() + ${sendAfter}::interval, ${sql.json(card as unknown as postgres.JSONValue)})`
}
const statuses = async () =>
  (
    await sql<
      { alert: string; status: string }[]
    >`select alert, status from bot.deliveries order by created_at, alert`
  ).map((r) => `${r.alert}:${r.status}`)

it("sends each chat's highest priority first and spaces groups 3 s apart", async () => {
  await enqueue(-1, "new", { priority: 5 })
  await enqueue(-1, "devsell", { priority: 0 })
  await enqueue(-1, "bonding", { priority: 2 })
  const s = sender()
  await s.tick()
  await s.tick()
  expect(sent.map((r) => r.alert)).toEqual(["devsell"])
  t += 3000
  await s.tick()
  t += 3000
  await s.tick()
  expect(sent.map((r) => r.alert)).toEqual(["devsell", "bonding", "new"])
})

it("caps sends at 10 in flight and 25 per second", async () => {
  for (let i = 1; i <= 30; i++) await enqueue(i, "new", { chatType: "private" })
  const s = sender()
  await s.tick()
  expect(sent).toHaveLength(10)
  await s.tick()
  await s.tick()
  expect(sent).toHaveLength(25)
  t += 1000
  await s.tick()
  expect(sent).toHaveLength(30)
})

it("sends the most urgent heads first when more chats are ready than the budget", async () => {
  // Without the sort, heads come back in chat_id order and chat 500 would be 12th of 12.
  for (let i = 1; i <= 11; i++) await enqueue(-i, "new", { priority: 5 })
  await enqueue(500, "devsell", { chatType: "private", priority: 0 })
  await sender().tick()
  expect(sent).toHaveLength(10)
  expect(sent[0]).toMatchObject({ chat_id: "500", alert: "devsell" })
})

it("drops alerts 3 minutes after their event, DEV SELL and BONDED after 30", async () => {
  for (const id of [-1, -2, -3]) await addChat(sql, id, "supergroup")
  await enqueue(-1, "bonding", { ageMin: 4 })
  await enqueue(-2, "devsell", { ageMin: 4, priority: 0 })
  await enqueue(-3, "bonded", { ageMin: 31, priority: 1 })
  respond = () => ({ ok: false, kind: "retry_after", retryAfter: 60, description: "429" })
  await sender().tick()
  expect((await statuses()).sort()).toEqual(
    [
      "bonded:skipped",
      "bonding:skipped",
      "devsell:pending",
      "summary:pending",
      "summary:pending",
    ].sort(),
  )
})

it("summarises skips once per 10 minutes: neutral in groups, with My alerts in DMs", async () => {
  await addChat(sql, -1, "supergroup", { ...basicPreset(), thread: 4 })
  await enqueue(-1, "new", { ageMin: 5, thread: 9 })
  await enqueue(-1, "new", { ageMin: 5, thread: 9 })
  await enqueue(42, "new", { ageMin: 5, chatType: "private" })
  respond = () => ({ ok: false, kind: "retry_after", retryAfter: 60, description: "429" })
  const s = sender()
  await s.tick()
  const sums = await sql<{ chat_id: string; thread_id: number | null; card: Payload }[]>`
    select chat_id::text, thread_id, card from bot.deliveries where alert = 'summary' order by chat_id`
  expect(sums.map((r) => [r.chat_id, r.thread_id, r.card])).toEqual([
    ["-1", 4, { type: "text", html: "2 alerts skipped in the last 10 min due to high volume." }],
    [
      "42",
      null,
      {
        type: "text",
        html: "1 alert skipped in the last 10 min due to high volume.",
        buttons: [[{ text: "My alerts", data: "al:u" }]],
      },
    ],
  ])
  await enqueue(-1, "new", { ageMin: 5 })
  await s.tick()
  expect((await sql`select 1 from bot.deliveries where alert = 'summary'`).length).toBe(2)
})

it("asks for a throttled notice after 3 summaries in an hour, naming the top feed", async () => {
  await addChat(sql, -1, "supergroup")
  for (const m of [20, 40]) {
    await sql`
      insert into bot.deliveries (chat_id, chat_type, alert, dedupe_key, priority, event_ts, card, created_at, status)
      values (-1, 'supergroup', 'summary', ${`summary:${m}`}, 1, now(), '{}', now() - ${`${m} minutes`}::interval, 'sent')`
  }
  await enqueue(-1, "new", { ageMin: 5 })
  await enqueue(-1, "new", { ageMin: 5 })
  await enqueue(-1, "pumping", { ageMin: 5, priority: 3 })
  respond = () => ({ ok: false, kind: "retry_after", retryAfter: 60, description: "429" })
  await sender().tick()
  expect(notify).toHaveBeenCalledWith("-1", "throttled", { top: "new", topCount: 2, total: 3 })
})

it("waits retry_after on 429, retries transient errors and fails after 5 attempts", async () => {
  await enqueue(7, "new", { chatType: "private" })
  respond = () => ({ ok: false, kind: "transient", description: "Bad Gateway" })
  const log = vi.fn()
  const s = sender({ log })
  for (let i = 0; i < 5; i++) {
    await s.tick()
    t += 5000
  }
  expect(await statuses()).toEqual(["new:failed"])
  expect(sent).toHaveLength(5)
  expect(log.mock.calls.filter((c) => c[0] === "warn")).toHaveLength(1)
})

it("marks a user blocked and drops their queue", async () => {
  await addUser(sql, 77)
  await enqueue(77, "new", { chatType: "private" })
  await enqueue(77, "bonding", { chatType: "private", priority: 2 })
  respond = () => ({
    ok: false,
    kind: "blocked",
    description: "Forbidden: bot was blocked by the user",
  })
  await sender().tick()
  expect(
    (await sql`select blocked_at from bot.users where platform_user_id = 77`)[0]?.blocked_at,
  ).not.toBeNull()
  expect((await statuses()).sort()).toEqual(["bonding:skipped", "new:skipped"])
  expect((await sql`select 1 from bot.deliveries where alert = 'summary'`).length).toBe(0)
})

it("handles removal, lost rights and broken topics with a notice", async () => {
  await addChat(sql, -1, "supergroup")
  await addChat(sql, -2, "supergroup")
  await addChat(sql, -3, "supergroup", { ...basicPreset(), thread: 4, routes: { new: 9 } })
  await addChat(sql, -4, "supergroup", { ...basicPreset(), thread: 4 })
  await enqueue(-1, "new")
  await enqueue(-2, "new")
  await enqueue(-3, "new", { thread: 9 })
  await enqueue(-4, "bonding", { thread: 4, priority: 2 })
  respond = (r) =>
    r.chat_id === "-1"
      ? {
          ok: false,
          kind: "removed",
          description: "Forbidden: bot was kicked from the supergroup chat",
        }
      : r.chat_id === "-2"
        ? { ok: false, kind: "rights", description: "Bad Request: not enough rights" }
        : { ok: false, kind: "topic", description: "Bad Request: TOPIC_CLOSED" }
  await sender().tick()
  const chats = await sql<
    {
      chat_id: string
      active: boolean
      paused_reason: string | null
      removed: boolean
      settings: { pausedRoutes?: string[] }
    }[]
  >`
    select chat_id::text, active, paused_reason, removed_at is not null as removed, settings from bot.chats c order by c.chat_id desc`
  expect(
    chats.map((c) => [
      c.chat_id,
      c.active,
      c.paused_reason,
      c.removed,
      c.settings.pausedRoutes ?? [],
    ]),
  ).toEqual([
    ["-1", false, null, true, []],
    ["-2", false, "rights", false, []],
    ["-3", true, null, false, ["new"]],
    ["-4", false, "topic", false, []],
  ])
  expect(notify.mock.calls.map((c) => [c[0], c[1]])).toEqual(
    expect.arrayContaining([
      ["-1", "removed"],
      ["-2", "rights"],
      ["-3", "topic:new"],
      ["-4", "topic:bonding"],
    ]),
  )
})

it("moves a migrated group's queue to its new chat id", async () => {
  await addChat(sql, -5, "group")
  await enqueue(-5, "new", { chatType: "group" })
  respond = (r) =>
    r.chat_id === "-5"
      ? { ok: false, kind: "migrated", migrateTo: -1005, description: "upgraded" }
      : { ok: true }
  await sender().tick()
  expect((await sql`select chat_id::text from bot.chats`)[0]?.chat_id).toBe("-1005")
  expect((await sql`select chat_id::text, status from bot.deliveries`)[0]).toEqual({
    chat_id: "-1005",
    status: "pending",
  })
})

it("moves a migrated group onto an already registered supergroup without duplicates", async () => {
  await addChat(sql, -5, "group")
  await addChat(sql, -1005, "supergroup")
  await enqueue(-5, "new", { chatType: "group", key: "same" })
  await enqueue(-5, "bonding", { chatType: "group", priority: 2, key: "only-old" })
  await enqueue(-1005, "new", { key: "same" })
  respond = (r) =>
    r.chat_id === "-5"
      ? { ok: false, kind: "migrated", migrateTo: -1005, description: "upgraded" }
      : { ok: false, kind: "retry_after", retryAfter: 60, description: "429" }
  await sender().tick()
  const chats = await sql<{ chat_id: string; active: boolean; removed: boolean }[]>`
    select chat_id::text, active, removed_at is not null as removed from bot.chats order by chat_id desc`
  expect(chats.map((c) => [c.chat_id, c.active, c.removed])).toEqual([["-1005", true, false]])
  const rows = await sql`
    select chat_id::text, chat_type, dedupe_key, status from bot.deliveries order by dedupe_key, chat_id`
  expect(rows.map((r) => [r.chat_id, r.chat_type, r.dedupe_key, r.status])).toEqual([
    ["-1005", "supergroup", "only-old", "pending"],
    ["-1005", "supergroup", "same", "pending"],
  ])
})

it("posts no summary into an inactive, removed or unregistered group, but still into a DM", async () => {
  await addChat(sql, -1, "supergroup", basicPreset(), { active: false })
  await addChat(sql, -2, "supergroup")
  await sql`update bot.chats set removed_at = now() where chat_id = -2`
  await enqueue(-1, "new", { ageMin: 5 })
  await enqueue(-2, "new", { ageMin: 5 })
  await enqueue(-3, "new", { ageMin: 5 })
  await enqueue(42, "new", { ageMin: 5, chatType: "private" })
  respond = () => ({ ok: false, kind: "retry_after", retryAfter: 60, description: "429" })
  await sender().tick()
  const sums = await sql`select chat_id::text from bot.deliveries where alert = 'summary'`
  expect(sums.map((r) => r.chat_id)).toEqual(["42"])
})

it("runs the summary scan at most every 10 seconds", async () => {
  await addChat(sql, -1, "supergroup")
  await addChat(sql, -2, "supergroup")
  respond = () => ({ ok: false, kind: "retry_after", retryAfter: 600, description: "429" })
  const s = sender()
  await enqueue(-1, "new", { ageMin: 5 })
  await s.tick()
  await enqueue(-2, "new", { ageMin: 5 })
  t += 9000
  await s.tick()
  expect((await sql`select chat_id::text from bot.deliveries where alert = 'summary'`).length).toBe(
    1,
  )
  t += 1000
  await s.tick()
  expect((await sql`select chat_id::text from bot.deliveries where alert = 'summary'`).length).toBe(
    2,
  )
})

it("indexes unsummarised skips for the summary scan", async () => {
  const [i] =
    await sql`select 1 from pg_indexes where schemaname = 'bot' and indexname = 'deliveries_unsummarized'`
  expect(i).toBeDefined()
})

it("treats a removed or rights failure in a DM as the user blocking the bot", async () => {
  await addUser(sql, 77)
  await enqueue(77, "new", { chatType: "private" })
  await enqueue(77, "bonding", { chatType: "private", priority: 2 })
  respond = () => ({ ok: false, kind: "removed", description: "Bad Request: chat not found" })
  const s = sender()
  await s.tick()
  expect(
    (await sql`select blocked_at from bot.users where platform_user_id = 77`)[0]?.blocked_at,
  ).not.toBeNull()
  expect((await statuses()).sort()).toEqual(["bonding:skipped", "new:skipped"])
  expect(notify).not.toHaveBeenCalled()
  expect(await sql`select 1 from bot.notices`).toHaveLength(0)
  await addUser(sql, 78)
  await enqueue(78, "new", { chatType: "private" })
  respond = () => ({ ok: false, kind: "rights", description: "Forbidden: have no rights to send" })
  await s.tick()
  expect(
    (await sql`select blocked_at from bot.users where platform_user_id = 78`)[0]?.blocked_at,
  ).not.toBeNull()
  expect(notify).not.toHaveBeenCalled()
})

it("keeps a configured group's settings when it migrates onto an inactive supergroup row", async () => {
  const me = await addUser(sql, 9)
  await addChat(sql, -5, "group", { ...basicPreset(), thread: 4 }, { setupBy: me })
  await addChat(sql, -1005, "supergroup", basicPreset(), { active: false })
  await enqueue(-5, "new", { chatType: "group" })
  respond = (r) =>
    r.chat_id === "-5"
      ? { ok: false, kind: "migrated", migrateTo: -1005, description: "upgraded" }
      : { ok: true }
  await sender().tick()
  const rows = await sql`
    select chat_id::text, active, setup_by::text, settings->>'thread' as thread, removed_at from bot.chats`
  expect(rows).toEqual([
    { chat_id: "-1005", active: true, setup_by: me, thread: "4", removed_at: null },
  ])
})

it("renames a migrated group to a supergroup when the new id is free", async () => {
  await addChat(sql, -5, "group")
  await enqueue(-5, "new", { chatType: "group" })
  respond = (r) =>
    r.chat_id === "-5"
      ? { ok: false, kind: "migrated", migrateTo: -1005, description: "upgraded" }
      : { ok: true }
  await sender().tick()
  expect((await sql`select chat_id::text, kind from bot.chats`)[0]).toEqual({
    chat_id: "-1005",
    kind: "supergroup",
  })
  expect((await sql`select chat_type from bot.deliveries`)[0]?.chat_type).toBe("supergroup")
})

it("treats a migration without a new id as a failed send", async () => {
  await enqueue(-5, "new", { chatType: "group" })
  respond = () => ({ ok: false, kind: "migrated", description: "upgraded" })
  await sender().tick()
  expect(await statuses()).toEqual(["new:failed"])
  expect(report).toHaveBeenCalledOnce()
})

it("isolates a chat whose settle write fails: no re-send, other chats still settle", async () => {
  await enqueue(1, "new", { chatType: "private" })
  await enqueue(2, "new", { chatType: "private" })
  // The 'sent' update for chat 1 will violate this constraint; chat 2's is unaffected.
  await sql`alter table bot.deliveries add constraint no_sent_for_1 check (chat_id <> 1 or status <> 'sent')`
  const s = sender()
  await s.tick()
  await s.tick()
  expect(sent.map((r) => r.chat_id).sort()).toEqual(["1", "2"])
  const rows = await sql`select chat_id::text, status from bot.deliveries order by chat_id`
  expect(rows.map((r) => [r.chat_id, r.status])).toEqual([
    ["1", "pending"],
    ["2", "sent"],
  ])
  expect(report).toHaveBeenCalledOnce()
})

it("fails unclassified errors and reports them", async () => {
  await enqueue(8, "new", { chatType: "private" })
  respond = () => ({ ok: false, kind: "other", description: "Bad Request: can't parse entities" })
  await sender().tick()
  expect(await statuses()).toEqual(["new:failed"])
  expect(report).toHaveBeenCalledOnce()
})

it("turns the real 24 Aug launch burst into 10 alerts, one notice and one card per minute", async () => {
  await addUser(sql, 1001)
  const burst = loadFixture("burst-0824")
  await insertEvents(sql, burst)
  await sql`insert into bot.state (key, value) values ('events_cursor', '0')`
  const prices = { usd: () => 2500, symbol: () => "ETH" }
  while (
    (await pollOnce({ sql, prices, log: () => {}, report, readHolds: async () => null })) > 0
  ) {}
  const launched = burst.filter((e) => e.type === "launchpad.launch")
  const count = async (prefix: string) =>
    (await sql`select 1 from bot.deliveries where dedupe_key like ${`${prefix}%`}`).length
  expect(await count("new:")).toBe(10)
  expect(await count("flood:")).toBe(1)
  const cards = await sql<{ card: { entries: unknown[] } }[]>`
    select card from bot.deliveries where dedupe_key like 'newtokens:%'`
  const minutes = new Set(launched.slice(10).map((e) => Math.floor(e.blockTimestamp / 60)))
  expect(cards).toHaveLength(minutes.size)
  expect(cards.reduce((n, c) => n + c.card.entries.length, 0)).toBe(launched.length - 10)
  await sender().tick() // fixture events are from August, so every alert is already late
  const skipped = (await sql`select 1 from bot.deliveries where status = 'skipped'`).length
  expect(skipped).toBe(10 + 1 + cards.length)
  const summaries = await sql<
    { card: Payload }[]
  >`select card from bot.deliveries where alert = 'summary'`
  expect(summaries.map((s) => s.card)).toEqual([
    {
      type: "text",
      html: `${skipped} alerts skipped in the last 10 min due to high volume.`,
      buttons: [[{ text: "My alerts", data: "al:u" }]],
    },
  ])
})

it("keeps ticking when a tick fails and reporting itself throws", async () => {
  vi.useFakeTimers()
  try {
    const log = vi.fn(() => {
      throw new Error("log sink down")
    })
    const down = (() => {
      throw new Error("db down")
    }) as unknown as Sql
    const stop = startSender({ sql: down, send: async () => ({ ok: true }), notify, log, report })
    await vi.advanceTimersByTimeAsync(600)
    stop()
    expect(log.mock.calls.length).toBeGreaterThanOrEqual(3)
  } finally {
    vi.useRealTimers()
  }
})

it("holds a row until its send_after", async () => {
  await addChat(sql, -100, "supergroup")
  await enqueue(-100, "new", { key: "later", sendAfterSec: 3600 })
  await enqueue(-100, "new", { key: "now" })
  const s = sender()
  await s.tick()
  t += 5_000
  await s.tick()
  expect(sent).toHaveLength(1)
  const [held] = await sql<
    { status: string }[]
  >`select status from bot.deliveries where dedupe_key = 'later'`
  expect(held!.status).toBe("pending")
})

it("sends a held row once send_after has passed", async () => {
  await addChat(sql, -100, "supergroup")
  await enqueue(-100, "new", { key: "due", sendAfterSec: -1 })
  await sender().tick()
  expect(sent).toHaveLength(1)
})

it("orders same-pass rows of one chat by event time", async () => {
  await addChat(sql, -100, "supergroup")
  const now = Math.floor(Date.now() / 1000)
  await sql.begin(async (tx) => {
    // One transaction: identical created_at, as rows written in one poller pass have.
    for (const [key, ts] of [
      ["c", now - 1],
      ["a", now - 3],
      ["b", now - 2],
    ] as const) {
      await tx`insert into bot.deliveries (chat_id, chat_type, alert, dedupe_key, priority, event_ts, card)
        values (-100, 'supergroup', 'new', ${key}, 5, to_timestamp(${ts}), ${tx.json({ type: "text", html: key })})`
    }
  })
  const s = sender()
  for (let i = 0; i < 3; i++) {
    await s.tick()
    t += 5_000
  }
  expect(sent.map((r) => (r.card as { html: string }).html)).toEqual(["a", "b", "c"])
})

import { afterAll, beforeEach, expect, inject, it, vi } from "vitest"
import type { Sql } from "../src/db"
import { MENU_TEXT } from "../src/menus/main"
import { createBot } from "../src/platforms/telegram/bot"
import type { Prices } from "../src/prices"
import { addChat, addUser, subscribe } from "./helpers/bot"
import { resetDb } from "./helpers/db"
import { BOT_INFO, harness, type Payload } from "./helpers/tg"

const prices: Prices = { usd: () => 2500, symbol: () => "ETH" }
const report = vi.fn()
let sql: Sql
let h: ReturnType<typeof harness>

beforeEach(async () => {
  await sql?.end()
  sql = await resetDb(inject("databaseUrl"))
  report.mockClear()
  const bot = createBot({
    token: "1:test",
    botInfo: BOT_INFO,
    sql,
    prices,
    log: () => {},
    report,
    linksBase: "https://go.makobot.xyz",
  })
  h = harness(bot)
})
afterAll(() => sql.end())

const settingsOf = async (tg: number) =>
  (
    await sql<
      { settings: { alerts: Record<string, { on: boolean }> } }[]
    >`select settings from bot.users where platform_user_id = ${tg}`
  )[0]?.settings
const actions = () =>
  sql`select chat_type, chat_id, action, params from bot.user_actions order by id`
const buttons = (p: Payload | undefined) =>
  (p?.reply_markup?.inline_keyboard ?? []).flat().map((b: { text: string }) => b.text)

it("creates a new user with every alert on and shows the welcome card", async () => {
  await h.text("/start")
  expect(Object.values((await settingsOf(100))!.alerts).every((a) => a.on)).toBe(true)
  const msg = h.last("sendMessage")!
  expect(msg.text).toContain("NEW TOKEN")
  expect(msg.text).toContain("curve jumps 15%+ in 10 min")
  expect(buttons(msg)).toEqual([
    "✓ NEW TOKEN",
    "✓ BONDING",
    "✓ PUMPING",
    "✓ BONDED",
    "✓ DEV SELL",
    "✓ BIG BUY/SELL",
    "Turn all off",
    "Done → menu",
  ])
  expect(await actions()).toEqual([
    { chat_type: "private", chat_id: null, action: "start", params: { source: "none" } },
  ])
})

it("toggles an alert, turns all off, and logs preset choices", async () => {
  await h.text("/start")
  await h.tap("ob:new")
  expect((await settingsOf(100))!.alerts.new!.on).toBe(false)
  expect(buttons(h.last("editMessageText"))[0]).toBe("· NEW TOKEN")
  await h.tap("ob:off")
  expect(Object.values((await settingsOf(100))!.alerts).some((a) => a.on)).toBe(false)
  await h.tap("ob:done")
  expect(h.last("editMessageText")!.text).toBe(MENU_TEXT)
  expect((await actions()).map((a) => a.params)).toEqual([
    { source: "none" },
    { choice: "all_off" },
    { choice: "done" },
  ])
})

it("shows the main menu to a returning user", async () => {
  await h.text("/start")
  await h.text("/start")
  expect(buttons(h.last("sendMessage"))).toEqual([
    "Look up token",
    "Hot now",
    "Near bonding",
    "Just bonded",
    "My watchlist",
    "My alerts",
    "Groups & channels",
    "Settings",
    "Help",
    "Community",
  ])
})

it("deletes the user, their subscriptions and DM deliveries after confirming, and keeps group rows", async () => {
  const id = await addUser(sql, 100)
  await subscribe(sql, id, "watch", "0xd1")
  await addChat(sql, -1, "supergroup", undefined, { setupBy: id })
  await sql`
    insert into bot.deliveries (chat_id, chat_type, alert, dedupe_key, priority, event_ts, card)
    values (100, 'private', 'new', 'a', 5, now(), '{}'), (-1, 'supergroup', 'new', 'a', 5, now(), '{}')`
  await h.text("/deletedata")
  expect(h.last("sendMessage")!.text).toContain("deleted after 14 days")
  expect(await sql`select 1 from bot.users`).toHaveLength(1)
  await h.tap("dd:yes")
  expect(await sql`select 1 from bot.users`).toHaveLength(0)
  expect(await sql`select 1 from bot.subscriptions`).toHaveLength(0)
  expect((await sql`select chat_id::text from bot.deliveries`).map((r) => r.chat_id)).toEqual([
    "-1",
  ])
  expect((await sql`select setup_by from bot.chats`)[0]?.setup_by).toBeNull()
})

it("tells the truth about storage in the privacy help", async () => {
  await h.tap("h:privacy")
  const text = h.last("editMessageText")!.text as string
  expect(text).toContain("deleted after 14 days")
  expect(text).not.toMatch(/encrypt/i)
  expect(text).toContain("Telegram user id")
})

it("treats 'message is not modified' as success", async () => {
  h.on("editMessageText", () => ({
    error:
      "Bad Request: message is not modified: specified new message content and reply markup are exactly the same",
  }))
  await h.tap("h")
  await h.tap("h")
  expect(report).not.toHaveBeenCalled()
})

it("counts known commands per day and ignores unknown ones", async () => {
  await h.text("/start")
  await h.text("/menu")
  await h.text("/menu")
  await h.text("/whatever")
  expect(await sql`select command, count::int from bot.commands_daily order by command`).toEqual([
    { command: "menu", count: 2 },
    { command: "start", count: 1 },
  ])
})

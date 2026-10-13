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

it("offers the Menu button in a DM's help but not in a group's", async () => {
  const group = { id: -1001, type: "supergroup" as const, title: "Alpha" }
  await h.text("/help")
  expect(buttons(h.last("sendMessage"))).toContain("Menu")
  await h.tap("h:alerts")
  expect(buttons(h.last("editMessageText"))).toContain("Menu")
  h.clear()
  await h.text("/help", { chat: group })
  expect(buttons(h.last("sendMessage"))).toContain("Community")
  expect(buttons(h.last("sendMessage"))).not.toContain("Menu")
  await h.tap("h:alerts", { chat: group })
  expect(buttons(h.last("editMessageText"))).toEqual(["Help"])
  await h.tap("h", { chat: group })
  expect(buttons(h.last("editMessageText"))).not.toContain("Menu")
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

it("logs every handler failure but reports to Sentry once per window", async () => {
  const log = vi.fn()
  const bot = createBot({
    token: "1:test",
    botInfo: BOT_INFO,
    sql,
    prices,
    log,
    report,
    linksBase: "https://go.makobot.xyz",
  })
  const h2 = harness(bot)
  h2.on("sendMessage", () => ({ error: "Bad Request: something odd" }))
  // handleUpdate throws; bot.start would pass the error to the handler set with bot.catch.
  for (let i = 0; i < 3; i++) {
    const err = await h2.text("/help").then(
      () => null,
      (e) => e,
    )
    await bot.errorHandler(err)
  }
  expect(log.mock.calls.filter((c) => c[1] === "bot handler failed")).toHaveLength(3)
  expect(report).toHaveBeenCalledOnce()
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

const sources = async () =>
  (
    await sql<
      { params: { source?: string } }[]
    >`select params from bot.user_actions where action = 'start' order by id`
  ).map((r) => r.params.source)

it("logs only a safe source for /start payloads, never free text or ids", async () => {
  await h.text("/start free text here")
  await h.text("/start w_0xd1a5a3b3c0ffee00112233445566778899aabbcc", { from: 101 })
  await h.text("/start t_0xd1a5a3b3c0ffee00112233445566778899aabbcc", { from: 102 })
  await h.text("/start s_-100123456", { from: 103 })
  await h.text("/start promo_1", { from: 104 })
  await h.text("/start 0xAbCdEf0123456789aBcDeF0123456789abcdef01", { from: 105 })
  await h.text("/start -100987654", { from: 106 })
  await h.text("/start")
  expect(await sources()).toEqual(["other", "w", "t", "s", "promo_1", "other", "other", "none"])
  const dump = JSON.stringify(await sql`select * from bot.user_actions`)
  expect(dump).not.toMatch(/free|text|here|0xd1a5|0xabcdef|100123456|100987654/i)
})

it("does not recreate a deleted user when an old onboarding button is tapped", async () => {
  await h.text("/start")
  await h.text("/deletedata")
  await h.tap("dd:yes")
  await h.tap("ob:new")
  await h.tap("ob:off")
  expect(await sql`select 1 from bot.users`).toHaveLength(0)
  expect(h.last("editMessageText")!.text).toContain("Send /start")
})

it("reports a failing command counter as a warning and still handles the command", async () => {
  const log = vi.fn()
  const bot = createBot({
    token: "1:test",
    botInfo: BOT_INFO,
    sql,
    prices,
    log,
    report,
    linksBase: "x",
  })
  const h2 = harness(bot)
  await sql`alter table bot.commands_daily rename to commands_daily_x`
  try {
    await h2.text("/help")
  } finally {
    await sql`alter table bot.commands_daily_x rename to commands_daily`
  }
  expect(log).toHaveBeenCalledWith("warn", "command counter failed", expect.any(Object))
  expect(h2.last("sendMessage")!.text).toContain("Help")
})

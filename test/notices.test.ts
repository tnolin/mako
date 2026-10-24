import { afterAll, beforeEach, expect, inject, it, vi } from "vitest"
import type { Payload } from "../src/cards/card"
import type { Sql } from "../src/db"
import { createNotify, type NoticeApi, noticeText } from "../src/delivery/notices"
import { addChat, addUser } from "./helpers/bot"
import { resetDb } from "./helpers/db"

let sql: Sql
const log = vi.fn()
beforeEach(async () => {
  await sql?.end()
  sql = await resetDb(inject("databaseUrl"))
  log.mockClear()
})
afterAll(() => sql.end())

function api(
  o: Partial<{ member: string; admins: number[]; title: string; fail: boolean }> = {},
): NoticeApi {
  return {
    getChatMember: vi.fn(async () => {
      if (o.fail) throw new Error("chat not found")
      return { status: o.member ?? "administrator" }
    }),
    getChatAdministrators: vi.fn(async () => {
      if (o.fail) throw new Error("chat not found")
      return (o.admins ?? []).map((id) => ({ user: { id, is_bot: false } }))
    }),
    getChat: vi.fn(async () => {
      if (o.fail) throw new Error("chat not found")
      return { title: o.title ?? "Alpha <Group>" }
    }),
  }
}
const notices = () =>
  sql<{ chat_id: string; card: Payload; priority: number; alert: string }[]>`
    select chat_id::text, card, priority, alert from bot.deliveries where alert = 'notice'`

it("DMs the admin who ran /setup with an Open settings button, once per 24 h", async () => {
  const setup = await addUser(sql, 11)
  await addChat(sql, -1, "supergroup", undefined, { setupBy: setup })
  const notify = createNotify({ sql, api: api(), botUsername: "makoinkbot", log })
  await notify("-1", "rights")
  await notify("-1", "rights")
  const n = await notices()
  expect(n).toHaveLength(1)
  expect(n[0]).toMatchObject({ chat_id: "11", priority: 0 })
  expect(n[0]!.card).toEqual({
    type: "text",
    html: noticeText("rights", "Alpha &lt;Group&gt;", {}),
    buttons: [[{ text: "Open settings", url: "https://t.me/makoinkbot?start=s_-1" }]],
  })
})

it("falls back to another admin who started the bot when setup_by is no longer an admin", async () => {
  const setup = await addUser(sql, 11)
  await addUser(sql, 13)
  await addChat(sql, -1, "supergroup", undefined, { setupBy: setup })
  await createNotify({
    sql,
    api: api({ member: "member", admins: [12, 13] }),
    botUsername: "makoinkbot",
    log,
  })("-1", "topic:new", { alert: "new" })
  expect((await notices())[0]?.chat_id).toBe("13")
})

it("uses the last setup_by without a check when the bot was removed", async () => {
  const setup = await addUser(sql, 11)
  await addChat(sql, -1, "supergroup", undefined, { setupBy: setup })
  await createNotify({ sql, api: api({ fail: true }), botUsername: "makoinkbot", log })(
    "-1",
    "removed",
  )
  const n = await notices()
  expect(n[0]?.chat_id).toBe("11")
  expect(n[0]!.card.type === "text" && n[0]!.card.html).toContain("your chat")
})

it("logs instead of sending when no admin has started the bot", async () => {
  await addChat(sql, -1, "supergroup")
  await createNotify({ sql, api: api({ admins: [99] }), botUsername: "makoinkbot", log })(
    "-1",
    "rights",
  )
  expect(await notices()).toHaveLength(0)
  expect(log).toHaveBeenCalledWith(
    "info",
    expect.stringMatching(/not delivered/),
    expect.anything(),
  )
})

it("names the top skipped feed in the throttled notice", () => {
  expect(noticeText("throttled", "Alpha", { top: "new", topCount: 38, total: 41 })).toContain(
    "38 of 41 skipped were NEW TOKEN. Turn it off or /route it to its own topic.",
  )
})

it("tells channels to re-add MAKO from the DM menu, not to run /setup or /route", () => {
  const removed = noticeText("removed", "News", { channel: true })
  expect(removed).toContain("Add to a channel")
  expect(removed).not.toContain("/setup")
  const throttled = noticeText("throttled", "News", {
    top: "new",
    topCount: 38,
    total: 41,
    channel: true,
  })
  expect(throttled).toContain("38 of 41 skipped were NEW TOKEN. Turn that feed off")
  expect(throttled).not.toContain("/route")
  expect(noticeText("rights", "News", { channel: true })).not.toMatch(/\/setup|\/route/)
})

it("sends a channel its own removed notice", async () => {
  const setup = await addUser(sql, 11)
  await addChat(sql, -100500, "channel", undefined, { setupBy: setup })
  await createNotify({ sql, api: api({ title: "News" }), botUsername: "makoinkbot", log })(
    "-100500",
    "removed",
  )
  const [n] = await notices()
  expect((n!.card as { html: string }).html).toContain("Add to a channel")
})

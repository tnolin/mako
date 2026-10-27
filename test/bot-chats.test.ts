import { afterAll, beforeEach, describe, expect, inject, it, vi } from "vitest"
import type { Sql } from "../src/db"
import { NOT_ADMIN } from "../src/menus/alerts"
import { GUIDE, SETUP_LINE } from "../src/menus/chats"
import { createBot } from "../src/platforms/telegram/bot"
import type { Prices } from "../src/prices"
import { basicPreset, type Settings } from "../src/settings"
import { addChat, addUser } from "./helpers/bot"
import { resetDb } from "./helpers/db"
import { testImages } from "./helpers/images"
import { BOT_INFO, harness } from "./helpers/tg"

const prices: Prices = { usd: () => 2500, symbol: () => "ETH" }
const G = { id: -1001, type: "supergroup" as const, title: "Alpha" }
let sql: Sql
let h: ReturnType<typeof harness>

beforeEach(async () => {
  await sql?.end()
  sql = await resetDb(inject("databaseUrl"))
  h = harness(
    createBot({
      token: "1:t",
      botInfo: BOT_INFO,
      sql,
      prices,
      log: () => {},
      report: vi.fn(),
      linksBase: "https://go.makobot.xyz",
      images: testImages().images,
      channelRetryMs: 1,
    }),
  )
})
afterAll(() => sql.end())

const chat = async (id: number) =>
  (
    await sql<
      {
        active: boolean
        kind: string
        owner: string | null
        setup_by: string | null
        settings: Settings
        removed_at: Date | null
        paused_reason: string | null
      }[]
    >`
    select active, kind, owner::text, setup_by::text, settings, removed_at, paused_reason from bot.chats where chat_id = ${id}`
  )[0]
const member = (
  chatInfo: object,
  oldStatus: string,
  newStatus: string,
  from = 100,
  extra: object = {},
) => ({
  my_chat_member: {
    chat: chatInfo,
    from: { id: from, is_bot: false, first_name: "U" },
    date: 0,
    old_chat_member: { status: oldStatus, user: BOT_INFO },
    new_chat_member: { status: newStatus, user: BOT_INFO, ...extra },
  },
})
const nonAdmin = () =>
  h.on("getChatMember", (p) => ({
    status: "member",
    user: { id: p.user_id, is_bot: false, first_name: "A" },
  }))

describe("groups", () => {
  it("records a join as inactive with the preset and posts the setup line", async () => {
    const owner = await addUser(sql, 100)
    await h.update(member(G, "left", "member"))
    expect(await chat(G.id)).toMatchObject({ active: false, kind: "supergroup", owner })
    expect(h.last("sendMessage")).toMatchObject({
      chat_id: G.id,
      text: SETUP_LINE,
      reply_markup: {
        inline_keyboard: [[{ text: "How to set up", callback_data: "setup:guide" }]],
      },
    })
    await h.tap("setup:guide", { chat: G })
    expect(h.last("editMessageText")!.text).toBe(GUIDE)
  })

  it("keeps a restricted bot that is still a member, and removes one that is not", async () => {
    await addChat(sql, -5, "group")
    const g = { id: -5, type: "group" as const, title: "Old" }
    await h.update(member(g, "member", "restricted", 100, { is_member: true }))
    expect((await chat(-5))?.removed_at).toBeNull()
    await h.update(member(g, "member", "restricted", 100, { is_member: false }))
    expect((await chat(-5))?.removed_at).not.toBeNull()
  })

  it("treats a restricted member as inside when it joins", async () => {
    await h.update(member(G, "left", "restricted", 100, { is_member: true }))
    expect(await chat(G.id)).toMatchObject({ active: false, removed_at: null })
  })

  it("lets only admins run /setup, which captures the topic and activates the chat", async () => {
    const admin = await addUser(sql, 100)
    await h.update(member(G, "left", "member"))
    nonAdmin()
    await h.text("/setup", { chat: G, thread: 5 })
    expect(h.last("sendMessage")!.text).toBe("Only group admins can run /setup.")
    expect((await chat(G.id))?.active).toBe(false)
    h.on("getChatMember", (p) => ({
      status: "administrator",
      user: { id: p.user_id, is_bot: false, first_name: "A" },
    }))
    await h.text("/setup", { chat: G, thread: 5 })
    expect(await chat(G.id)).toMatchObject({ active: true, setup_by: admin, paused_reason: null })
    expect((await chat(G.id))?.settings.thread).toBe(5)
    expect(h.last("sendMessage")).toMatchObject({
      message_thread_id: 5,
      reply_markup: {
        inline_keyboard: [
          [{ text: "Open settings", url: `https://t.me/makoinkbot?start=s_${G.id}` }],
        ],
      },
    })
    expect(
      await sql`select chat_type, chat_id::text, action from bot.user_actions where action = 'setup'`,
    ).toEqual([{ chat_type: "supergroup", chat_id: String(G.id), action: "setup" }])
  })

  it("routes chosen alerts to a topic with /route", async () => {
    await addChat(sql, G.id, "supergroup", { ...basicPreset("supergroup"), thread: 5 })
    await h.text("/route", { chat: G, thread: 9 })
    expect(h.last("sendMessage")!.message_thread_id).toBe(9)
    await h.tap("rt:new", { chat: G, thread: 9 })
    expect((await chat(G.id))?.settings.routes).toEqual({ new: 9 })
    expect(h.last("editMessageReplyMarkup")!.reply_markup.inline_keyboard[0][0]).toEqual({
      text: "NEW TOKEN",
      callback_data: "rt:new",
      style: "success",
    })
    await h.tap("rt:new", { chat: G, thread: 9 })
    expect((await chat(G.id))?.settings.routes).toEqual({})
    expect(
      (await sql`select params from bot.user_actions where action = 'route' order by id`).map(
        (r) => r.params,
      ),
    ).toEqual([
      { alert: "new", on: true },
      { alert: "new", on: false },
    ])
  })

  describe("routing turns the alert on", () => {
    const setup = async (on: boolean) => {
      const s = basicPreset("supergroup")
      s.alerts.bonded.on = on
      await addChat(sql, G.id, "supergroup", { ...s, thread: 5, topicNames: { "9": "Mints" } })
      await h.text("/route", { chat: G, thread: 9 })
    }

    it("sets an off alert on in the same write and says so", async () => {
      await setup(false)
      await h.tap("rt:bonded", { chat: G, thread: 9 })
      const s = (await chat(G.id))!.settings
      expect(s.routes).toEqual({ bonded: 9 })
      expect(s.alerts.bonded.on).toBe(true)
      expect(h.last("answerCallbackQuery")).toMatchObject({
        text: "BONDED is on and posts in Mints.",
      })
    })

    it("leaves the alert on when the route is removed", async () => {
      await setup(false)
      await h.tap("rt:bonded", { chat: G, thread: 9 })
      await h.tap("rt:bonded", { chat: G, thread: 9 })
      const s = (await chat(G.id))!.settings
      expect(s.routes).toEqual({})
      expect(s.alerts.bonded.on).toBe(true)
    })

    it("changes nothing else for an alert that was on", async () => {
      await setup(true)
      const before = (await chat(G.id))!.settings
      await h.tap("rt:bonded", { chat: G, thread: 9 })
      expect((await chat(G.id))!.settings).toEqual({
        ...before,
        routes: { bonded: 9 },
        pausedRoutes: [],
      })
    })
  })

  it("lists the NFT kinds in /route, without MINT REMINDER, and routes them to the topic", async () => {
    await addChat(sql, G.id, "supergroup", { ...basicPreset("supergroup"), thread: 5 })
    await h.text("/route", { chat: G, thread: 9 })
    const kb = h.last("sendMessage")!.reply_markup.inline_keyboard.flat()
    expect(kb.map((b: { text: string }) => b.text)).toEqual([
      "NEW TOKEN",
      "BONDING",
      "PUMPING",
      "BONDED",
      "DEV SELL",
      "BIG BUY/SELL",
      "UPCOMING MINT",
      "MINT STARTING",
      "MINTED",
      "SOLD OUT",
      "NEW COLLECTION",
      "BIG SALE",
      "UNDER FLOOR",
      "RARE LISTING",
      "FLOOR MOVE",
      "SWEEP",
      "SOLD",
    ])
    await h.tap("rt:mintstart", { chat: G, thread: 9 })
    expect((await chat(G.id))?.settings.routes).toEqual({ mintstart: 9 })
  })

  it("stores the topic's name from /setup and /route, and follows a rename", async () => {
    await addUser(sql, 100)
    await h.update(member(G, "left", "member"))
    await h.text("/setup", { chat: G, thread: 5, topic: "Alerts" })
    expect((await chat(G.id))?.settings.topicNames).toEqual({ "5": "Alerts" })
    await h.text("/route", { chat: G, thread: 9, topic: "Mints" })
    expect((await chat(G.id))?.settings.topicNames).toEqual({ "5": "Alerts", "9": "Mints" })
    const renamed = (thread: number, name: string) =>
      h.update({
        message: {
          message_id: 77,
          date: 0,
          chat: G,
          from: { id: 100, is_bot: false, first_name: "U" },
          message_thread_id: thread,
          is_topic_message: true,
          forum_topic_edited: { name },
        },
      })
    await renamed(9, "NFT mints")
    // A topic MAKO doesn't post in is not stored.
    await renamed(12, "Off topic")
    expect((await chat(G.id))?.settings.topicNames).toEqual({ "5": "Alerts", "9": "NFT mints" })
  })

  it("names a routed topic on rename even when the route was saved before names", async () => {
    await addChat(sql, G.id, "supergroup", { ...basicPreset("supergroup"), routes: { new: 9 } })
    await h.update({
      message: {
        message_id: 77,
        date: 0,
        chat: G,
        from: { id: 100, is_bot: false, first_name: "U" },
        message_thread_id: 9,
        is_topic_message: true,
        forum_topic_edited: { name: "Launches" },
      },
    })
    expect((await chat(G.id))?.settings.topicNames).toEqual({ "9": "Launches" })
  })

  it("asks for a topic when /route runs outside one", async () => {
    await addChat(sql, G.id, "supergroup")
    await h.text("/route", { chat: G })
    expect(h.last("sendMessage")!.text).toContain("inside the topic")
  })

  it("marks the chat removed when the bot leaves, and follows a supergroup migration", async () => {
    await addChat(sql, -5, "group")
    await h.update(member({ id: -5, type: "group", title: "Old" }, "member", "kicked"))
    expect((await chat(-5))?.removed_at).not.toBeNull()
    await addChat(sql, -6, "group")
    await h.update({
      message: {
        message_id: 3,
        date: 0,
        chat: { id: -6, type: "group", title: "x" },
        migrate_to_chat_id: -1006,
      },
    })
    expect(await chat(-1006)).toBeDefined()
  })
})

describe("chat settings in the DM", () => {
  it("opens from the s_ deep link for admins only", async () => {
    await addUser(sql, 100) // a returning user, so /start shows no welcome card after the screen
    await addChat(sql, G.id, "supergroup")
    nonAdmin()
    await h.text(`/start s_${G.id}`)
    expect(h.last("sendMessage")!.text).toBe("Only admins of that chat can change its settings.")
    h.on("getChatMember", (p) => ({
      status: "creator",
      user: { id: p.user_id, is_bot: false, first_name: "A" },
    }))
    await h.text(`/start s_${G.id}`)
    expect(h.last("sendMessage")!.text).toContain("<b>Alerts for Test Group</b>")
  })

  it("toggles a chat's feed for admins and refuses others", async () => {
    await addChat(sql, G.id, "supergroup")
    await h.tap(`al:${G.id}:new:on`)
    expect((await chat(G.id))?.settings.alerts.new.on).toBe(false)
    nonAdmin()
    await h.tap(`al:${G.id}:new:on`)
    expect((await chat(G.id))?.settings.alerts.new.on).toBe(false)
    expect(h.last("answerCallbackQuery")).toMatchObject({
      text: "Only admins of that chat can change its settings.",
      show_alert: true,
    })
  })

  it("edits the user's own alerts: marks, BIG threshold, image and reset", async () => {
    await h.text("/start")
    await h.tap("al:u:p:bonding:0")
    await h.tap("al:u:p:big:2")
    await h.tap("al:u:pumping:img")
    const s = (await sql`select settings from bot.users`)[0]!.settings
    expect(s.alerts.bonding.marks).toEqual([5000, 8000, 9000])
    expect(s.alerts.big.pctBps).toBe(1000)
    expect(s.alerts.pumping.image).toBe(false)
    await h.tap("al:u:reset:tk")
    expect((await sql`select settings from bot.users`)[0]!.settings).toEqual(basicPreset("private"))
  })

  it("drops the chat's queued alerts when it is paused", async () => {
    await addChat(sql, G.id, "supergroup")
    await sql`
      insert into bot.deliveries (chat_id, chat_type, alert, dedupe_key, priority, event_ts, card)
      values (${G.id}, 'supergroup', 'new', 'a', 5, now(), '{}')`
    await h.tap(`gc:${G.id}:pause`)
    expect(
      await sql`select status, summarized from bot.deliveries where chat_id = ${G.id}`,
    ).toEqual([{ status: "skipped", summarized: true }])
  })

  it("pauses, resumes after a rights check, and removes", async () => {
    await addChat(sql, G.id, "supergroup")
    await h.tap(`gc:${G.id}:pause`)
    expect(await chat(G.id)).toMatchObject({ active: false, paused_reason: "paused" })
    await h.tap(`gc:${G.id}:resume`)
    expect(await chat(G.id)).toMatchObject({ active: true, paused_reason: null })
    await h.tap(`gc:${G.id}:remove`)
    expect(h.calls.some((c) => c.method === "leaveChat")).toBe(true)
    expect((await chat(G.id))?.removed_at).not.toBeNull()
  })

  it("lists the user's chats after a live admin check", async () => {
    const me = await addUser(sql, 100)
    await addChat(sql, G.id, "supergroup", basicPreset("supergroup"), { setupBy: me })
    await h.tap("gc")
    const kb = h.last("editMessageText")!.reply_markup.inline_keyboard
    expect(kb[0]).toEqual([{ text: "Test Group", callback_data: `gc:${G.id}` }])
    expect(kb[1]).toEqual([
      {
        text: "Add to a group",
        url: "https://t.me/makoinkbot?startgroup=setup&admin=post_messages+manage_topics",
      },
    ])
    expect(kb[2]).toEqual([{ text: "Add to a channel", callback_data: "gc:addch" }])
  })
})

describe("channels", () => {
  const CH = { id: -100777, type: "channel" as const, title: "News" }
  const shared = {
    message: {
      message_id: 9,
      date: 0,
      chat: { id: 100, type: "private" },
      from: { id: 100, is_bot: false, first_name: "U" },
      chat_shared: { request_id: 1, chat_id: CH.id, title: "News" },
    },
  }

  it("asks with the channel picker set to add MAKO as an admin that can post", async () => {
    await h.tap("gc:addch")
    const button = h.last("sendMessage")!.reply_markup.keyboard[0][0]
    expect(button.request_chat).toMatchObject({
      request_id: 1,
      chat_is_channel: true,
      bot_administrator_rights: expect.objectContaining({ can_post_messages: true }),
      user_administrator_rights: expect.objectContaining({
        can_post_messages: true,
        can_promote_members: true,
      }),
      request_title: true,
    })
    expect(button.request_chat).not.toHaveProperty("bot_is_member")
  })

  it("activates when my_chat_member arrives first (as observed live)", async () => {
    await h.update(member(CH, "left", "administrator", 100, { can_post_messages: true }))
    expect((await chat(CH.id))?.active).toBe(false)
    await h.update(shared)
    expect(await chat(CH.id)).toMatchObject({ active: true, kind: "channel" })
    const texts = h.calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text)
    expect(texts.at(-2)).toBe("MAKO will post alerts in News.")
    expect(texts.at(-1)).toContain("<b>MAKO</b> · real-time alerts")
  })

  it("activates when chat_shared arrives first and the rights follow", async () => {
    let calls = 0
    h.on("getChatMember", (p) =>
      p.user_id === BOT_INFO.id && ++calls <= 2
        ? { status: "left", user: BOT_INFO }
        : {
            status: "administrator",
            user: { id: p.user_id, is_bot: p.user_id === BOT_INFO.id, first_name: "A" },
            can_post_messages: true,
          },
    )
    await h.update(shared)
    await h.update(member(CH, "left", "administrator", 100, { can_post_messages: true }))
    expect(await chat(CH.id)).toMatchObject({ active: true, kind: "channel" })
  })

  it("does not activate without post rights and offers a retry", async () => {
    h.on("getChatMember", (p) => ({
      status: "administrator",
      user: { id: p.user_id, is_bot: false, first_name: "A" },
      can_post_messages: p.user_id !== BOT_INFO.id,
    }))
    await h.update(shared)
    expect((await chat(CH.id))?.active ?? false).toBe(false)
    const m = h.calls.filter((c) => c.method === "sendMessage").at(-1)!.payload
    expect(m.text).toBe("MAKO couldn't get posting rights in that channel.")
    expect(m.reply_markup.inline_keyboard).toEqual([
      [{ text: "Try again", callback_data: "gc:addch" }],
    ])
  })
})

describe("no user rows from old taps", () => {
  it("never recreates a deleted user from an alert-settings button", async () => {
    await h.text("/start")
    await h.tap("dd:yes")
    expect(await sql`select 1 from bot.users`).toHaveLength(0)
    for (const data of [
      "al:u",
      "al:u:new:on",
      "al:u:pumping:img",
      "al:u:tk",
      "al:u:na",
      "al:u:nw",
      "al:u:p:bonding:0",
      "al:u:p:big:2",
      "al:u:reset:tk",
      "gc",
    ]) {
      await h.tap(data)
      expect(h.last("editMessageText")!.text).toBe("Send /start to use MAKO.")
    }
    expect(await sql`select 1 from bot.users`).toHaveLength(0)
  })

  it("lets the typed /alerts command create the user, then shows the welcome card", async () => {
    await h.text("/alerts")
    expect(await sql`select 1 from bot.users`).toHaveLength(1)
    const texts = h.calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text)
    expect(texts).toHaveLength(2)
    expect(texts[0]).toContain("<b>My alerts</b>")
    expect(texts[1]).toContain("<b>MAKO</b> · real-time alerts")
    h.clear()
    await h.text("/alerts")
    expect(h.calls.filter((c) => c.method === "sendMessage")).toHaveLength(1)
  })
})

describe("chat settings details", () => {
  it("shows no topic line for channels and logs the real chat type on reset", async () => {
    const CH = -100777
    await addChat(sql, CH, "channel")
    await h.tap(`al:${CH}`)
    expect(h.last("editMessageText")!.text).not.toContain("Default topic")
    expect(h.last("editMessageText")!.text).not.toContain("Alerts</u>")
    await h.tap(`al:${CH}:reset:tk`)
    expect(
      await sql`select chat_type, chat_id::text, action, params from bot.user_actions where action = 'preset'`,
    ).toEqual([
      { chat_type: "channel", chat_id: String(CH), action: "preset", params: { choice: "reset" } },
    ])
  })

  it("shows the default topic and the routed and paused alerts by section, with topic names", async () => {
    await addChat(sql, G.id, "supergroup", {
      ...basicPreset("supergroup"),
      thread: 5,
      routes: { new: 9, bonding: 14, mintstart: 12 },
      pausedRoutes: ["bonding"],
      topicNames: { "5": "Alerts", "9": "Launches & <bonds>", "14": "Bonding" },
    })
    await h.tap(`gc:${G.id}`)
    const [, ...rest] = h.last("editMessageText")!.text.split("\n")
    expect(rest).toEqual([
      "",
      "Default topic: Alerts",
      "Any alerts not set to a specific topic will appear here.",
      "",
      "<u>Token Alerts</u>",
      "NEW TOKEN → Launches &amp; &lt;bonds&gt;",
      "BONDING paused: its topic is closed",
      "",
      "<u>NFT Alerts</u>",
      // Saved before names were stored.
      "MINT STARTING → topic 12",
    ])
  })

  it("leaves out a section with nothing routed, and reads General for the General topic", async () => {
    await addChat(sql, G.id, "supergroup", {
      ...basicPreset("supergroup"),
      thread: null,
      routes: { bigsale: 9 },
      topicNames: { "9": "Sales" },
    })
    await h.tap(`gc:${G.id}`)
    const text = h.last("editMessageText")!.text
    expect(text).toContain("Default topic: General\n")
    expect(text).not.toContain("Token Alerts")
    expect(text).toContain("<u>NFT Alerts</u>\nBIG SALE → Sales")
  })

  it("names the topic in /route's prompt, or says this topic when the name isn't known", async () => {
    await addChat(sql, G.id, "supergroup", { ...basicPreset("supergroup"), thread: 5 })
    await h.text("/route", { chat: G, thread: 9, topic: "Mints" })
    expect(h.last("sendMessage")!.text).toBe("Post these alerts in Mints:")
    // A reply in the topic carries no name: the stored one is used.
    await h.text("/route", { chat: G, thread: 9 })
    expect(h.last("sendMessage")!.text).toBe("Post these alerts in Mints:")
    await h.text("/route", { chat: G, thread: 11 })
    expect(h.last("sendMessage")!.text).toBe("Post these alerts in this topic:")
  })

  it("offers Resume for paused topics and clears them after the rights check", async () => {
    await addChat(sql, G.id, "supergroup", {
      ...basicPreset("supergroup"),
      thread: 5,
      routes: { new: 9 },
      pausedRoutes: ["new"],
    })
    await h.tap(`gc:${G.id}`)
    const kb = h.last("editMessageText")!.reply_markup.inline_keyboard.flat()
    expect(h.last("editMessageText")!.text).toContain("NEW TOKEN paused: its topic is closed")
    expect(kb.map((b: { text: string }) => b.text)).toContain("Resume")
    await h.tap(`gc:${G.id}:resume`)
    expect((await chat(G.id))?.settings.pausedRoutes).toEqual([])
  })

  it("names the pause reason only when it is not a plain pause", async () => {
    await addChat(sql, G.id, "supergroup")
    await h.tap(`gc:${G.id}:pause`)
    const paused = () => (h.last("editMessageText")!.text as string).split("\n")
    expect(paused()).toContain("Paused.")
    await sql`update bot.chats set paused_reason = 'rights' where chat_id = ${G.id}`
    await h.tap(`gc:${G.id}`)
    expect(paused()).toContain("Paused (rights).")
  })

  it("refuses to resume while MAKO cannot post", async () => {
    await addChat(sql, G.id, "supergroup", basicPreset("supergroup"), { active: false })
    h.on("getChatMember", (p) => ({
      status: p.user_id === BOT_INFO.id ? "left" : "administrator",
      user: { id: p.user_id, is_bot: false, first_name: "A" },
    }))
    await h.tap(`gc:${G.id}:resume`)
    expect(h.last("answerCallbackQuery")!.text).toContain("can't post there yet")
    expect((await chat(G.id))?.active).toBe(false)
  })

  it("refuses /route changes from non-admins", async () => {
    await addChat(sql, G.id, "supergroup")
    nonAdmin()
    await h.tap("rt:new", { chat: G, thread: 9 })
    expect((await chat(G.id))?.settings.routes).toBeUndefined()
    expect(h.last("answerCallbackQuery")!.text).toBe("Only group admins can change routing.")
  })

  it("carries token and collection watches and collection mutes to the new chat id", async () => {
    await addChat(sql, -6, "group")
    await sql`insert into bot.chat_token_watches (chat_id, target) values (-6, '0xa1'), (-6, '0xa2')`
    await sql`insert into bot.nft_watches (chat_id, contract) values (-6, '0xc1')`
    await sql`insert into bot.collection_mutes (chat_id, contract) values (-6, '0xc2')`
    await sql`insert into bot.nft_watches (chat_id, contract) values (-7, '0xc9')`
    await h.update({
      message: {
        message_id: 3,
        date: 0,
        chat: { id: -6, type: "group", title: "x" },
        migrate_to_chat_id: -1006,
      },
    })
    const ids = (t: string) => sql.unsafe(`select chat_id::text as c from bot.${t} order by 1`)
    expect((await ids("chat_token_watches")).map((r) => r.c)).toEqual(["-1006", "-1006"])
    expect((await ids("nft_watches")).map((r) => r.c)).toEqual(["-1006", "-7"])
    expect((await ids("collection_mutes")).map((r) => r.c)).toEqual(["-1006"])
  })

  it("merges the old chat's watches into a supergroup row that already exists", async () => {
    await addChat(sql, -6, "group")
    await addChat(sql, -1006, "supergroup")
    await sql`insert into bot.chat_token_watches (chat_id, target) values (-6, '0xa1'), (-6, '0xa2'), (-1006, '0xa2')`
    await sql`insert into bot.nft_watches (chat_id, contract) values (-6, '0xc1'), (-1006, '0xc1')`
    await h.update({
      message: {
        message_id: 3,
        date: 0,
        chat: { id: -6, type: "group", title: "x" },
        migrate_to_chat_id: -1006,
      },
    })
    expect(
      await sql`select chat_id::text, target from bot.chat_token_watches order by target`,
    ).toEqual([
      { chat_id: "-1006", target: "0xa1" },
      { chat_id: "-1006", target: "0xa2" },
    ])
    expect(await sql`select chat_id::text, contract from bot.nft_watches`).toEqual([
      { chat_id: "-1006", contract: "0xc1" },
    ])
  })

  it("merges into the supergroup row when it already exists at migration", async () => {
    await addChat(sql, -6, "group", { ...basicPreset("supergroup"), thread: 4 })
    await addChat(sql, -1006, "supergroup", basicPreset("supergroup"), { active: false })
    await h.update({
      message: {
        message_id: 3,
        date: 0,
        chat: { id: -6, type: "group", title: "x" },
        migrate_to_chat_id: -1006,
      },
    })
    expect(await chat(-6)).toBeUndefined()
    expect(await chat(-1006)).toMatchObject({ active: true, kind: "supergroup" })
    expect((await chat(-1006))?.settings.thread).toBe(4)
  })
})

describe("destructive chat buttons need a live admin check", () => {
  const rows = () =>
    sql`select chat_id::text, active, paused_reason, removed_at from bot.chats order by bot.chats.chat_id desc`
  const unchanged = [{ chat_id: String(G.id), active: true, paused_reason: null, removed_at: null }]

  it("refuses pause, resume and remove from a non-admin", async () => {
    await addChat(sql, G.id, "supergroup")
    nonAdmin()
    for (const action of ["pause", "resume", "remove"]) {
      await h.tap(`gc:${G.id}:${action}`)
      expect(h.last("answerCallbackQuery")).toMatchObject({ text: NOT_ADMIN, show_alert: true })
    }
    expect(await rows()).toEqual(unchanged)
    expect(h.calls.some((c) => c.method === "leaveChat")).toBe(false)
  })

  it("does not let an admin of one chat act on another", async () => {
    const B = -1002
    await addChat(sql, G.id, "supergroup")
    await addChat(sql, B, "supergroup")
    h.on("getChatMember", (p) => ({
      status: p.chat_id === G.id ? "administrator" : "member",
      user: { id: p.user_id, is_bot: false, first_name: "A" },
    }))
    await h.tap(`gc:${B}:remove`)
    await h.tap(`gc:${B}:pause`)
    expect(h.last("answerCallbackQuery")).toMatchObject({ text: NOT_ADMIN, show_alert: true })
    expect(await rows()).toEqual([
      { chat_id: String(G.id), active: true, paused_reason: null, removed_at: null },
      { chat_id: String(B), active: true, paused_reason: null, removed_at: null },
    ])
    expect(h.calls.some((c) => c.method === "leaveChat")).toBe(false)
  })
})

import { afterAll, beforeEach, describe, expect, inject, it, vi } from "vitest"
import type { Sql } from "../src/db"
import { dm, NOT_FOUND, popup, TARGET_TOKENS_ONLY, WATCH_LIMIT } from "../src/menus/copy"
import { loadNftState, type NftState } from "../src/nft/state"
import { watch } from "../src/nft/watches"
import { createBot } from "../src/platforms/telegram/bot"
import { nftAlertKeyboard } from "../src/platforms/telegram/render"
import type { Prices } from "../src/prices"
import { addChat, addUser } from "./helpers/bot"
import { insertEvents, resetDb } from "./helpers/db"
import { addr, launch, nftCollection } from "./helpers/events"
import { testImages } from "./helpers/images"
import { BOT_INFO, harness, type Payload } from "./helpers/tg"

const prices: Prices = { usd: () => 2500, symbol: () => "ETH" }
const C = addr(0xc0)
const N = "Ink Hornet"
let sql: Sql
let h: ReturnType<typeof harness>
let state: NftState
let userId: string

type B = { text: string; url?: string; callback_data?: string; style?: string }
const kbOf = (p: Payload | undefined) => (p?.reply_markup?.inline_keyboard ?? []) as B[][]
/** The alert keyboard a DM gets for a not-yet-watched collection, as Telegram hands it back on a tap. */
const alertKb: B[][] = [
  [
    { text: "View", url: "https://go.makobot.xyz/n/c/ink-hornet" },
    { text: "Watch", callback_data: `nwa:${C}` },
    { text: "Mute", callback_data: `nm:${C}` },
  ],
  [{ text: "Remind me", callback_data: `nrm:${C}` }],
]
const groupFrom = { id: -1001, type: "supergroup" as const, title: "Test Group" }

beforeEach(async () => {
  await sql?.end()
  sql = await resetDb(inject("databaseUrl"))
  const ids = await insertEvents(sql, [nftCollection({})])
  state = await loadNftState(sql, ids.at(-1)!)
  h = harness(
    createBot({
      token: "1:test",
      botInfo: BOT_INFO,
      sql,
      prices,
      log: () => {},
      report: vi.fn(),
      linksBase: "https://go.makobot.xyz",
      images: testImages().images,
      nft: () => state,
    }),
  )
  userId = await addUser(sql, 100)
})
afterAll(() => sql.end())

/** The pop-up text: the first answer with text (Telegram honours the first answer to a tap). */
const popupText = () =>
  h.calls.find((c) => c.method === "answerCallbackQuery" && c.payload.text)?.payload.text
const rows = (table: "nft_watches" | "collection_mutes" | "reminders") =>
  sql.unsafe(`select contract from bot.${table}`)

describe("copy", () => {
  it("pop-up copy per action", () => {
    expect(popup.watch("$TIDE")).toBe("Watching $TIDE. I'll send you every alert for it.")
    expect(dm.groupWatching(N)).toBe(
      "Watching Ink Hornet. I'll send every alert for it to this group.",
    )
    expect(popup.stop(N)).toBe("Stopped watching Ink Hornet. It can still appear in your feeds.")
    expect(popup.remind()).toBe("Reminder set. I'll message you 15 mins before each mint stage.")
    expect(popup.unremind(N)).toBe("Reminder removed for Ink Hornet.")
    expect(popup.mute(N)).toBe("Muted Ink Hornet. I won't send you alerts about it.")
    expect(popup.muteUnwatched(N)).toBe("Muted and unwatched Ink Hornet.")
    expect(popup.unmute(N)).toBe("Unmuted Ink Hornet.")
    expect(dm.watching("$TIDE", "token")).toBe(
      "<b>Watching $TIDE</b>\nI'll send you every alert for this token to your DMs.",
    )
    expect(dm.watching(N, "nft")).toBe(
      "<b>Watching Ink Hornet</b>\nI'll send you every alert for this collection to your DMs.",
    )
    expect(dm.alreadyWatching(N)).toBe("You're already watching Ink Hornet.")
    expect(dm.reminderSet(N)).toBe("Reminder set for Ink Hornet.")
  })
})

describe("buttons in a DM", () => {
  it("Watch turns green with Watching, and a second tap undoes it", async () => {
    await h.tap(`nwa:${C}`, { keyboard: alertKb })
    expect(h.last("answerCallbackQuery")!.text).toBe(popup.watch(N))
    expect(await rows("nft_watches")).toHaveLength(1)
    const on = kbOf(h.last("editMessageReplyMarkup"))
    expect(on[0]![1]).toEqual({
      text: "Watching",
      callback_data: `nws:${C}`,
      style: "success",
    })
    expect(on[0]![0]).toEqual(alertKb[0]![0])
    h.clear()
    await h.tap(`nws:${C}`, { keyboard: on })
    expect(h.last("answerCallbackQuery")!.text).toBe(popup.stop(N))
    expect(await rows("nft_watches")).toHaveLength(0)
    expect(kbOf(h.last("editMessageReplyMarkup"))).toEqual(alertKb)
  })

  it("Mute and Remind me flip to Muted and Reminder set the same way", async () => {
    await h.tap(`nm:${C}`, { keyboard: alertKb })
    expect(h.last("answerCallbackQuery")!.text).toBe(popup.mute(N))
    let kb = kbOf(h.last("editMessageReplyMarkup"))
    expect(kb[0]![2]).toEqual({ text: "Muted", callback_data: `nmu:${C}`, style: "success" })
    await h.tap(`nmu:${C}`, { keyboard: kb })
    expect(h.last("answerCallbackQuery")!.text).toBe(popup.unmute(N))
    expect(await rows("collection_mutes")).toHaveLength(0)
    await h.tap(`nrm:${C}`, { keyboard: alertKb })
    expect(h.last("answerCallbackQuery")!.text).toBe(popup.remind())
    kb = kbOf(h.last("editMessageReplyMarkup"))
    expect(kb[1]![0]).toEqual({
      text: "Reminder set",
      callback_data: `nrr:${C}`,
      style: "success",
    })
    expect(await rows("reminders")).toHaveLength(1)
    await h.tap(`nrr:${C}`, { keyboard: kb })
    expect(h.last("answerCallbackQuery")!.text).toBe(popup.unremind(N))
    expect(await rows("reminders")).toHaveLength(0)
    expect(kbOf(h.last("editMessageReplyMarkup"))[1]![0]!.text).toBe("Remind me")
  })

  it("mute of a watched item stops the watch and answers Muted and unwatched", async () => {
    await watch(sql, { userId }, C)
    const kb: B[][] = [
      [
        alertKb[0]![0]!,
        { text: "Watching", callback_data: `nws:${C}`, style: "success" },
        alertKb[0]![2]!,
      ],
    ]
    await h.tap(`nm:${C}`, { keyboard: kb })
    expect(h.last("answerCallbackQuery")!.text).toBe(popup.muteUnwatched(N))
    expect(await rows("nft_watches")).toHaveLength(0)
    const next = kbOf(h.last("editMessageReplyMarkup"))
    expect(next[0]![1]).toEqual({ text: "Watch", callback_data: `nwa:${C}` })
    expect(next[0]![2]!.text).toBe("Muted")
  })

  it("watch on a muted item unmutes it, and so does Remind me", async () => {
    await h.tap(`nm:${C}`, { keyboard: alertKb })
    await h.tap(`nwa:${C}`, { keyboard: alertKb })
    expect(h.last("answerCallbackQuery")!.text).toBe(popup.watch(N))
    expect(await rows("collection_mutes")).toHaveLength(0)
    await h.tap(`nws:${C}`, { keyboard: alertKb })
    await h.tap(`nm:${C}`, { keyboard: alertKb })
    await h.tap(`nrm:${C}`, { keyboard: alertKb })
    expect(await rows("collection_mutes")).toHaveLength(0)
    expect(await rows("reminders")).toHaveLength(1)
  })

  it("the 51st watch says the limit and adds nothing", async () => {
    for (let i = 0; i < 50; i++) await watch(sql, { userId }, addr(0x7000 + i))
    await h.tap(`nwa:${C}`, { keyboard: alertKb })
    expect(h.last("answerCallbackQuery")!.text).toBe(WATCH_LIMIT)
    expect(await rows("nft_watches")).toHaveLength(50)
    expect(h.last("editMessageReplyMarkup")).toBeUndefined()
  })

  it("logs the NFT actions with no user", async () => {
    await h.tap(`nwa:${C}`, { keyboard: alertKb })
    await h.tap(`nws:${C}`, { keyboard: alertKb })
    await h.tap(`nrm:${C}`, { keyboard: alertKb })
    await h.tap(`nrr:${C}`, { keyboard: alertKb })
    await h.tap(`nm:${C}`, { keyboard: alertKb })
    await h.tap(`nmu:${C}`, { keyboard: alertKb })
    const a = await sql`select action, token from bot.user_actions order by id`
    expect(a.map((r) => r.action)).toEqual([
      "watch_nft",
      "unwatch_nft",
      "remind",
      "unremind",
      "mute_collection",
      "unmute_collection",
    ])
    expect(a.every((r) => r.token === C)).toBe(true)
  })

  it("creates no user from a tap after Delete my data", async () => {
    await h.tap("dd:yes")
    for (const d of [`nwa:${C}`, `nm:${C}`, `nrm:${C}`]) {
      await h.tap(d, { keyboard: alertKb })
      expect(h.last("answerCallbackQuery")!.text).toBe("Send /start to use MAKO.")
    }
    expect(await sql`select 1 from bot.users`).toHaveLength(0)
  })
})

describe("from a group", () => {
  it("watch from a group deep link sends the DM message, not a pop-up", async () => {
    await h.text(`/start wn_${C}`)
    let m = h.last("sendMessage")!
    expect(m.text).toBe(dm.watching(N, "nft"))
    expect(m.parse_mode).toBe("HTML")
    expect(kbOf(m)).toEqual([
      [
        { text: "Watching", callback_data: `nws:${C}`, style: "success" },
        { text: "My alerts", callback_data: "al:u" },
      ],
    ])
    expect(await rows("nft_watches")).toHaveLength(1)
    h.clear()
    await h.text(`/start wn_${C}`)
    m = h.last("sendMessage")!
    expect(m.text).toBe(dm.alreadyWatching(N))
    expect(kbOf(m)[0]![0]!.text).toBe("Watching")
    expect(await rows("nft_watches")).toHaveLength(1)
  })

  it("Remind me from a group deep link sets the reminder and sends the message", async () => {
    await h.text(`/start rn_${C}`)
    const m = h.last("sendMessage")!
    expect(m.text).toBe(dm.reminderSet(N))
    expect(kbOf(m)).toEqual([
      [{ text: "Reminder set", callback_data: `nrr:${C}`, style: "success" }],
    ])
    expect(await rows("reminders")).toHaveLength(1)
    expect(await rows("nft_watches")).toHaveLength(0)
  })

  it("records the deep-link source as a kind, never the address", async () => {
    await h.text(`/start wn_${C}`)
    await h.text(`/start rn_${C}`)
    const a = await sql`select params from bot.user_actions where action = 'start' order by id`
    expect(a.map((r) => r.params.source)).toEqual(["wn", "rn"])
  })

  it("a deep link for an unknown collection says it was not found", async () => {
    await h.text(`/start wn_${addr(0x99)}`)
    expect(h.last("sendMessage")!.text).toBe(NOT_FOUND)
    expect(await rows("nft_watches")).toHaveLength(0)
  })

  it("group alert buttons never change state", () => {
    const card = { contract: C, alert: "upcoming", slug: "ink-hornet", tokenId: null } as never
    for (const chatType of ["group", "supergroup", "channel"] as const) {
      const kb = nftAlertKeyboard(card, {
        chatType,
        linksBase: "https://go.makobot.xyz",
        botUsername: "makoinkbot",
        state: { watching: true, muted: true, reminded: true },
      })
      for (const b of kb.inline_keyboard.flat()) {
        expect(b).toHaveProperty("url")
        expect(b).not.toHaveProperty("callback_data")
        expect(b).not.toHaveProperty("style")
      }
    }
  })

  it("/watch in a group by a non-admin is refused", async () => {
    h.on("getChatMember", (p) => ({
      status: "member",
      user: { id: p.user_id, is_bot: false, first_name: "A" },
    }))
    await h.text("/watch ink-hornet", { chat: groupFrom, from: 200 })
    expect(h.last("sendMessage")!.text).toBe("Only admins of that chat can change its settings.")
    expect(await rows("nft_watches")).toHaveLength(0)
  })

  it("/watch in a group by an admin watches the collection for the chat", async () => {
    await addChat(sql, -1001, "supergroup")
    await h.text("/watch ink-hornet", { chat: groupFrom, from: 200 })
    expect(await sql`select contract, chat_id::text from bot.nft_watches`).toEqual([
      { contract: C, chat_id: "-1001" },
    ])
    expect(h.last("sendMessage")!.text).toBe(dm.groupWatching(N))
    await h.text("/watch ink-hornet", { chat: groupFrom, from: 200 })
    expect(h.last("sendMessage")!.text).toBe(dm.alreadyWatching(N))
    await h.text("/watch nothing-here", { chat: groupFrom, from: 200 })
    expect(h.last("sendMessage")!.text).toBe(NOT_FOUND)
  })

  const nonAdmin = () =>
    h.on("getChatMember", (p) => ({
      status: "member",
      user: { id: p.user_id, is_bot: false, first_name: "A" },
    }))

  it("Watched NFTs for a group opens in the DM, titled with the chat name, with Back to the group's settings", async () => {
    await addChat(sql, -1001, "supergroup")
    await watch(sql, { chatId: "-1001" }, C)
    await h.tap("gl:-1001:n")
    const m = h.last("editMessageText")!
    expect(m.text).toBe(
      "<b>Watched NFTs for Test Group</b>\n\nThese are all the NFT collections you are currently watching. If you no longer wish to receive alerts for these, simply click Remove next to each collection.",
    )
    expect(kbOf(m)).toEqual([
      [
        { text: N, callback_data: `nc:${C}:zs1` },
        { text: "Remove", callback_data: `gl:-1001:n:${C}` },
      ],
      [{ text: "Back", callback_data: "al:-1001" }],
    ])
  })

  it("Watched NFTs for a group is admin-only", async () => {
    await addChat(sql, -1001, "supergroup")
    await watch(sql, { chatId: "-1001" }, C)
    nonAdmin()
    await h.tap("gl:-1001:n")
    expect(h.last("answerCallbackQuery")).toMatchObject({
      text: "Only admins of that chat can change its settings.",
      show_alert: true,
    })
    await h.tap(`gl:-1001:n:${C}`)
    expect(await rows("nft_watches")).toHaveLength(1)
  })

  it("Remove in a group's list answers the stop pop-up and redraws", async () => {
    await addChat(sql, -1001, "supergroup")
    await watch(sql, { chatId: "-1001" }, C)
    await h.tap(`gl:-1001:n:${C}`)
    expect(popupText()).toBe(popup.stop(N))
    expect(h.last("editMessageText")!.text).toBe(
      "<b>Watched NFTs for Test Group</b>\n\nYou're not watching anything yet. Tap Watch on any alert or card to add it here.",
    )
    expect(await rows("nft_watches")).toHaveLength(0)
  })

  it("a collection opened from a group's list arrives without Back", async () => {
    await addChat(sql, -1001, "supergroup")
    await watch(sql, { chatId: "-1001" }, C)
    await h.tap(`nc:${C}:zs1`)
    const kb = kbOf(h.last("sendPhoto") ?? h.last("sendMessage"))
    expect(kb.flat().some((b) => b.text === "Back")).toBe(false)
  })

  it("the Watched lists never open in a group", async () => {
    await addChat(sql, -1001, "supergroup")
    await watch(sql, { chatId: "-1001" }, C)
    h.clear()
    await h.tap("nwl", { chat: groupFrom, from: 200 })
    await h.tap(`nwl:rm:${C}`, { chat: groupFrom, from: 200 })
    await h.tap(`gl:-1001:n`, { chat: groupFrom, from: 200 })
    expect(h.calls.filter((c) => c.method === "editMessageText")).toHaveLength(0)
    expect(await rows("nft_watches")).toHaveLength(1)
  })
})

describe("/watch in a DM", () => {
  it("says what to send when /watch has nothing after it", async () => {
    await h.text("/watch")
    expect(h.last("sendMessage")!.text).toBe(
      "Send /watch followed by a token or NFT collection address.",
    )
  })

  it("watches a collection by slug and sends the DM message", async () => {
    await h.text("/watch ink-hornet")
    expect(h.last("sendMessage")!.text).toBe(dm.watching(N, "nft"))
    expect(await rows("nft_watches")).toHaveLength(1)
    await h.text(`/watch ${C}`)
    expect(h.last("sendMessage")!.text).toBe(dm.alreadyWatching(N))
  })

  it("/watch on an NFT collection with an amount refuses the target and watches nothing", async () => {
    await h.text("/watch ink-hornet 1000")
    expect(h.last("sendMessage")!.text).toBe(TARGET_TOKENS_ONLY)
    await h.text("/watch Ink Hornet $5k")
    expect(h.last("sendMessage")!.text).toBe(TARGET_TOKENS_ONLY)
    expect(await rows("nft_watches")).toHaveLength(0)
  })

  it("a collection and a token with the same name: the name watches the collection, $TICKER the token", async () => {
    const T = addr(0xd7)
    await insertEvents(sql, [launch({ token: T, ticker: "HORNET", name: "Ink Hornet" })])
    await h.text("/watch Ink Hornet")
    expect(h.last("sendMessage")!.text).toBe(dm.watching(N, "nft"))
    expect(await rows("nft_watches")).toHaveLength(1)
    expect(await sql`select target from bot.subscriptions`).toEqual([])
    await h.text("/watch $HORNET")
    expect(h.last("sendMessage")!.text).toBe(dm.watching("$HORNET", "token"))
    expect(await sql`select target from bot.subscriptions`).toEqual([{ target: T }])
  })

  it("a token name that only partly matches a collection watches the token", async () => {
    const T = addr(0xd8)
    await insertEvents(sql, [launch({ token: T, ticker: "INK", name: "Ink" })])
    await h.text("/watch ink")
    expect(h.last("sendMessage")!.text).toBe(dm.watching("$INK", "token"))
    expect(await rows("nft_watches")).toHaveLength(0)
  })

  it("says it was not found for a name or address nothing matches", async () => {
    await h.text("/watch zzzzzz")
    expect(h.last("sendMessage")!.text).toBe(NOT_FOUND)
    await h.text(`/watch ${addr(0x99)}`)
    expect(h.last("sendMessage")!.text).toBe(NOT_FOUND)
  })
})

describe("Watched NFTs and Muted NFTs", () => {
  const WATCHED_INTRO =
    "These are all the NFT collections you are currently watching. If you no longer wish to receive alerts for these, simply click Remove next to each collection."

  it("Watched NFTs copy is exact, with a Name and Remove row and Back", async () => {
    await watch(sql, { userId }, C)
    await h.tap("nwl")
    const m = h.last("editMessageText")!
    expect(m.text).toBe(`<b>Watched NFTs</b>\n\n${WATCHED_INTRO}`)
    expect(kbOf(m)).toEqual([
      [
        { text: N, callback_data: `nc:${C}:w` },
        { text: "Remove", callback_data: `nwl:rm:${C}` },
      ],
      [{ text: "Back", callback_data: "al:u" }],
    ])
  })

  it("cuts a long name to 17 characters and an ellipsis", async () => {
    const long = "A very long collection name indeed"
    const ids = await insertEvents(sql, [nftCollection({ contract: addr(0xc1), name: long })])
    state = await loadNftState(sql, ids.at(-1)!)
    await watch(sql, { userId }, addr(0xc1))
    await h.tap("nwl")
    expect(kbOf(h.last("editMessageText"))[0]![0]!.text).toBe("A very long colle…")
  })

  it("Remove answers the stop pop-up and redraws, with the empty copy at the end", async () => {
    await watch(sql, { userId }, C)
    await h.tap(`nwl:rm:${C}`)
    expect(popupText()).toBe(popup.stop(N))
    expect(h.last("editMessageText")!.text).toBe(
      "<b>Watched NFTs</b>\n\nYou're not watching anything yet. Tap Watch on any alert or card to add it here.",
    )
    expect(await rows("nft_watches")).toHaveLength(0)
  })

  it("Muted NFTs lists with Unmute, and Unmute answers the unmute pop-up", async () => {
    await h.tap(`nm:${C}`, { keyboard: alertKb })
    await h.tap("nml")
    const m = h.last("editMessageText")!
    expect(m.text).toBe(
      "<b>Muted NFTs</b>\n\nI won't send you any alerts about these. Tap Unmute to undo.",
    )
    expect(kbOf(m)).toEqual([
      [
        { text: N, callback_data: `nc:${C}:x` },
        { text: "Unmute", callback_data: `nml:um:${C}` },
      ],
      [{ text: "Back", callback_data: "al:u" }],
    ])
    h.clear()
    await h.tap(`nml:um:${C}`)
    expect(popupText()).toBe(popup.unmute(N))
    expect(h.last("editMessageText")!.text).toBe("<b>Muted NFTs</b>\n\nYou haven't muted anything.")
  })

  it("a collection opened from a list arrives without Back", async () => {
    await watch(sql, { userId }, C)
    await h.tap(`nc:${C}:w`)
    const kb = kbOf(h.last("sendPhoto") ?? h.last("sendMessage"))
    expect(kb.flat().some((b) => b.text === "Back")).toBe(false)
  })
})

describe("Delete my data", () => {
  it("removes watches, mutes and reminders", async () => {
    await watch(sql, { userId }, C)
    await h.tap(`nm:${addr(0xc5)}`, { keyboard: alertKb })
    await h.tap(`nrm:${addr(0xc6)}`, { keyboard: alertKb })
    expect(await rows("collection_mutes")).toHaveLength(1)
    await h.tap("dd:yes")
    for (const t of ["nft_watches", "collection_mutes", "reminders"] as const)
      expect(await rows(t)).toHaveLength(0)
  })
})

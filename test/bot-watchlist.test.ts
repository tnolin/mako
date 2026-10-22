import { afterAll, beforeEach, describe, expect, inject, it, vi } from "vitest"
import type { Sql } from "../src/db"
import { dm, LIMIT_GAP, NOT_FOUND, popup } from "../src/menus/copy"
import { loadNftState, type NftState } from "../src/nft/state"
import { createBot } from "../src/platforms/telegram/bot"
import type { Prices } from "../src/prices"
import { addUser, subscribe } from "./helpers/bot"
import { insertEvents, resetDb, setCursorBlock } from "./helpers/db"
import { addr, launch } from "./helpers/events"
import { testImages } from "./helpers/images"
import { BOT_INFO, harness, type Payload } from "./helpers/tg"

const prices: Prices = { usd: () => 2500, symbol: () => "ETH" }
const A = addr(0xa1)
const CHECKSUMMED = "0x00000000000000000000000000000000000000A1"
let sql: Sql
let h: ReturnType<typeof harness>
let userId: string
let nft: NftState

type B = { text: string; url?: string; callback_data?: string; style?: string }
const kbOf = (p: Payload | undefined) => (p?.reply_markup?.inline_keyboard ?? []) as B[][]
const alertKb: B[][] = [
  [
    { text: "Trade", url: "u" },
    { text: "Watch", callback_data: `w:${A}` },
    { text: "Mute", callback_data: `m:${A}` },
  ],
]
/** The pop-up text: the first answer with text (Telegram honours the first answer to a tap). */
const popupText = () =>
  h.calls.find((c) => c.method === "answerCallbackQuery" && c.payload.text)?.payload.text
const subs = async () =>
  (await sql`select kind from bot.subscriptions order by kind`).map((r) => r.kind)

beforeEach(async () => {
  await sql?.end()
  sql = await resetDb(inject("databaseUrl"))
  nft = await loadNftState(sql, "0")
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
      nft: () => nft,
    }),
  )
  await insertEvents(sql, [
    launch({ token: A, ticker: "GOBLO", name: "Goblo", blockNumber: "1000" }),
  ])
  await setCursorBlock(sql, 1000)
  userId = await addUser(sql, 100)
})
afterAll(() => sql.end())

describe("Watch and Mute on a token", () => {
  it("Watch turns green with Watching, and a second tap undoes it", async () => {
    await h.tap(`w:${A}`, { keyboard: alertKb })
    expect(h.last("answerCallbackQuery")!.text).toBe(popup.watch("$GOBLO"))
    const on = kbOf(h.last("editMessageReplyMarkup"))
    expect(on[0]![1]).toEqual({ text: "Watching", callback_data: `w:${A}`, style: "success" })
    await h.tap(`w:${A}`, { keyboard: on })
    expect(h.last("answerCallbackQuery")!.text).toBe(popup.stop("$GOBLO"))
    expect(kbOf(h.last("editMessageReplyMarkup"))).toEqual(alertKb)
    expect(await subs()).toEqual([])
  })

  it("Mute flips to Muted, and mute of a watched token answers Muted and unwatched", async () => {
    await h.tap(`m:${A}`, { keyboard: alertKb })
    expect(h.last("answerCallbackQuery")!.text).toBe(popup.mute("$GOBLO"))
    expect(kbOf(h.last("editMessageReplyMarkup"))[0]![2]).toEqual({
      text: "Muted",
      callback_data: `m:${A}`,
      style: "success",
    })
    await h.tap(`m:${A}`, { keyboard: alertKb })
    expect(h.last("answerCallbackQuery")!.text).toBe(popup.unmute("$GOBLO"))
    await subscribe(sql, userId, "watch", A)
    await h.tap(`m:${A}`, { keyboard: alertKb })
    expect(h.last("answerCallbackQuery")!.text).toBe(popup.muteUnwatched("$GOBLO"))
    expect(await subs()).toEqual(["mute"])
    const next = kbOf(h.last("editMessageReplyMarkup"))[0]!
    expect(next[1]).toEqual({ text: "Watch", callback_data: `w:${A}` })
    expect(next[2]!.text).toBe("Muted")
  })

  it("watch on a muted token unmutes it", async () => {
    await subscribe(sql, userId, "mute", A)
    await h.tap(`w:${A}`, { keyboard: alertKb })
    expect(h.last("answerCallbackQuery")!.text).toBe(popup.watch("$GOBLO"))
    expect(await subs()).toEqual(["watch"])
  })

  it("the 51st watch says the limit", async () => {
    for (let i = 0; i < 50; i++) await subscribe(sql, userId, "watch", addr(0x5000 + i))
    await h.tap(`w:${A}`, { keyboard: alertKb })
    expect(h.last("answerCallbackQuery")!.text).toBe(LIMIT_GAP)
    expect(await sql`select 1 from bot.subscriptions`).toHaveLength(50)
  })

  it("logs watch, unwatch, mute and unmute with no user", async () => {
    await h.tap(`w:${A}`, { keyboard: alertKb })
    await h.tap(`w:${A}`, { keyboard: alertKb })
    await h.tap(`m:${A}`, { keyboard: alertKb })
    await h.tap(`m:${A}`, { keyboard: alertKb })
    expect(
      await sql`select chat_type, chat_id, action, token from bot.user_actions order by id`,
    ).toEqual(
      ["watch", "unwatch", "mute", "unmute"].map((action) => ({
        chat_type: "private",
        chat_id: null,
        action,
        token: A,
      })),
    )
  })

  it("treats repeated taps with identical text as success", async () => {
    h.on("editMessageReplyMarkup", () => ({ error: "Bad Request: message is not modified" }))
    await h.tap(`w:${A}`, { keyboard: alertKb })
    await h.tap(`w:${A}`, { keyboard: alertKb })
    h.on("editMessageText", () => ({ error: "Bad Request: message is not modified" }))
    await h.tap("wl")
    await h.tap("wl")
  })
})

describe("/watch and the w_ deep link", () => {
  it("watches a checksummed address and sends the DM message with its buttons", async () => {
    await h.text(`/watch ${CHECKSUMMED}`)
    const m = h.last("sendMessage")!
    expect(m.text).toBe(dm.watching("$GOBLO", "token"))
    expect(m.parse_mode).toBe("HTML")
    expect(kbOf(m)).toEqual([
      [
        { text: "Watching", callback_data: `w:${A}`, style: "success" },
        { text: "My alerts", callback_data: "al:u" },
      ],
    ])
    expect(await sql`select target from bot.subscriptions`).toEqual([{ target: A }])
    await h.text(`/watch ${A}`)
    expect(h.last("sendMessage")!.text).toBe(dm.alreadyWatching("$GOBLO"))
  })

  it("watches from a group deep link, lowercasing the address", async () => {
    await h.text(`/start w_${CHECKSUMMED}`)
    expect(await sql`select target from bot.subscriptions`).toEqual([{ target: A }])
    expect(h.last("sendMessage")!.text).toBe(dm.watching("$GOBLO", "token"))
  })

  it("says it was not found for an address nothing matches", async () => {
    await h.text(`/watch ${addr(0x99)}`)
    expect(h.last("sendMessage")!.text).toBe(NOT_FOUND)
  })

  it("shows the welcome card after the confirmation when /watch recreates a deleted user", async () => {
    await h.text("/start")
    await h.tap("dd:yes")
    h.clear()
    await h.text(`/watch ${A}`)
    const texts = h.calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text)
    expect(texts).toHaveLength(2)
    expect(texts[0]).toBe(dm.watching("$GOBLO", "token"))
    expect(texts[1]).toContain("<b>MAKO</b> · real-time alerts")
  })

  it("caps the watchlist at 50", async () => {
    for (let i = 0; i < 50; i++) await subscribe(sql, userId, "watch", addr(0x5000 + i))
    await h.text(`/watch ${A}`)
    expect(h.last("sendMessage")!.text).toBe(LIMIT_GAP)
  })
})

describe("Watched tokens and Muted tokens", () => {
  it("Watched tokens copy is exact, with Name and Remove rows, Back and no Add token", async () => {
    await subscribe(sql, userId, "watch", A)
    await h.tap("wl")
    const m = h.last("editMessageText")!
    expect(m.text).toBe(
      "<b>Watched tokens</b>\nThese are all the tokens you are currently watching. If you no longer wish to receive alerts for these, simply click Remove next to each token.",
    )
    expect(kbOf(m)).toEqual([
      [
        { text: "$GOBLO", callback_data: `t:${A}:wl` },
        { text: "Remove", callback_data: `wl:rm:${A}` },
      ],
      [{ text: "Back", callback_data: "al:u" }],
    ])
  })

  it("Remove answers the stop pop-up and redraws, and the empty list has its own copy", async () => {
    await subscribe(sql, userId, "watch", A)
    await h.tap(`wl:rm:${A}`)
    expect(popupText()).toBe(popup.stop("$GOBLO"))
    expect(h.last("editMessageText")!.text).toBe(
      "<b>Watched tokens</b>\nYou're not watching anything yet. Tap Watch on any alert or card to add it here.",
    )
  })

  it("Muted tokens lists with Unmute, and Unmute answers the unmute pop-up", async () => {
    await subscribe(sql, userId, "mute", A)
    await h.tap("mu")
    const m = h.last("editMessageText")!
    expect(m.text).toBe(
      "<b>Muted tokens</b>\nI won't send you any alerts about these. Tap Unmute to undo.",
    )
    expect(kbOf(m)).toEqual([
      [
        { text: "$GOBLO", callback_data: `t:${A}:mu` },
        { text: "Unmute", callback_data: `um:${A}` },
      ],
      [{ text: "Back", callback_data: "al:u" }],
    ])
    h.clear()
    await h.tap(`um:${A}`)
    expect(popupText()).toBe(popup.unmute("$GOBLO"))
    expect(h.last("editMessageText")!.text).toBe("<b>Muted tokens</b>\nYou haven't muted anything.")
  })

  it("a token opened from a list has Back to that list", async () => {
    await h.tap(`t:${A}:wl`)
    const back = kbOf(h.last("sendPhoto") ?? h.last("sendMessage")).at(-1)!
    expect(back).toEqual([{ text: "Back", callback_data: "wl" }])
  })

  it("creates no user from taps on old buttons after Delete my data", async () => {
    await h.tap("dd:yes")
    h.clear()
    for (const data of [`wl:rm:${A}`, `um:${A}`, "wl", "mu"]) {
      await h.tap(data)
      expect(h.last("editMessageText")!.text).toBe("Send /start to use MAKO.")
      h.clear()
    }
    for (const data of [`w:${A}`, `m:${A}`]) {
      await h.tap(data, { keyboard: [[{ text: "Watch", callback_data: data }]] })
      expect(h.last("answerCallbackQuery")).toMatchObject({ text: "Send /start to use MAKO." })
      expect(h.last("editMessageReplyMarkup")).toBeUndefined()
      h.clear()
    }
    expect(await sql`select 1 from bot.users`).toHaveLength(0)
    expect(await sql`select 1 from bot.subscriptions`).toHaveLength(0)
  })
})

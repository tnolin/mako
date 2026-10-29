import { afterAll, beforeEach, describe, expect, inject, it, vi } from "vitest"
import type { Sql } from "../src/db"
import { NOT_ADMIN } from "../src/menus/alerts"
import {
  dm,
  NOT_FOUND,
  popup,
  TARGET_BAD_AMOUNT,
  WATCH_LIMIT,
  WATCH_USAGE,
} from "../src/menus/copy"
import { parseWatchArgs } from "../src/menus/watches"
import { setTarget } from "../src/menus/watchlist"
import { loadNftState, type NftState } from "../src/nft/state"
import { createBot } from "../src/platforms/telegram/bot"
import type { Prices } from "../src/prices"
import { addChat, addUser, subscribe } from "./helpers/bot"
import { insertEvents, resetDb, setCursorBlock } from "./helpers/db"
import { addr, bond, ETH, launch, swap, T0, trade } from "./helpers/events"
import { testImages } from "./helpers/images"
import { BOT_INFO, harness, type Payload } from "./helpers/tg"

let ethUsd: number | null = 2500
const prices: Prices = { usd: () => ethUsd, symbol: () => "ETH" }
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
  ethUsd = 2500
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
    expect(h.last("answerCallbackQuery")!.text).toBe(WATCH_LIMIT)
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
    expect(h.last("sendMessage")!.text).toBe(WATCH_LIMIT)
  })
})

describe("Watched tokens and Muted tokens", () => {
  it("Watched tokens copy is exact, with Name and Remove rows, Back and no Add token", async () => {
    await subscribe(sql, userId, "watch", A)
    await h.tap("wl")
    const m = h.last("editMessageText")!
    expect(m.text).toBe(
      "<b>Watched tokens</b>\n\nThese are all the tokens you are currently watching. If you no longer wish to receive alerts for these, simply click Remove next to each token.",
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
      "<b>Watched tokens</b>\n\nYou're not watching anything yet. Tap Watch on any alert or card to add it here.",
    )
  })

  it("Muted tokens lists with Unmute, and Unmute answers the unmute pop-up", async () => {
    await subscribe(sql, userId, "mute", A)
    await h.tap("mu")
    const m = h.last("editMessageText")!
    expect(m.text).toBe(
      "<b>Muted tokens</b>\n\nI won't send you any alerts about these. Tap Unmute to undo.",
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
    expect(h.last("editMessageText")!.text).toBe(
      "<b>Muted tokens</b>\n\nYou haven't muted anything.",
    )
  })

  it("a token opened from a list arrives without Back", async () => {
    await h.tap(`t:${A}:wl`)
    const kb = kbOf(h.last("sendPhoto") ?? h.last("sendMessage"))
    expect(kb.flat().some((b) => b.text === "Back")).toBe(false)
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

describe("a group watches tokens", () => {
  const group = { id: -1001, type: "supergroup" as const, title: "Alpha" }
  const nonAdmin = () =>
    h.on("getChatMember", (p) => ({
      status: "member",
      user: { id: p.user_id, is_bot: false, first_name: "A" },
    }))
  const groupWatches = async () =>
    (await sql`select chat_id::text, target from bot.chat_token_watches order by target`).map(
      (r) => `${r.chat_id}:${r.target}`,
    )

  beforeEach(async () => {
    await addChat(sql, group.id, "supergroup")
  })

  it("an admin's /watch in a group watches a token for the chat", async () => {
    await h.text(`/watch ${CHECKSUMMED}`, { chat: group, from: 200, thread: 5 })
    expect(await groupWatches()).toEqual([`-1001:${A}`])
    expect(h.last("sendMessage")).toMatchObject({
      text: dm.groupWatching("$GOBLO"),
      message_thread_id: 5,
    })
    expect(await sql`select 1 from bot.subscriptions`).toHaveLength(0)
    expect(await sql`select chat_type, chat_id::text, action, token from bot.user_actions`).toEqual(
      [{ chat_type: "supergroup", chat_id: "-1001", action: "watch", token: A }],
    )
  })

  it("a non-admin is refused", async () => {
    nonAdmin()
    await h.text(`/watch ${A}`, { chat: group, from: 200 })
    expect(h.last("sendMessage")!.text).toBe(NOT_ADMIN)
    expect(await groupWatches()).toEqual([])
  })

  it("says not found for anything that is neither a known token nor a collection", async () => {
    await h.text(`/watch ${addr(0x99)}`, { chat: group, from: 200 })
    expect(h.last("sendMessage")!.text).toBe(NOT_FOUND)
    await h.text("/watch zzzzzz", { chat: group, from: 200 })
    expect(h.last("sendMessage")!.text).toBe(NOT_FOUND)
    expect(await groupWatches()).toEqual([])
  })

  it("says what to send when /watch has nothing after it", async () => {
    await h.text("/watch", { chat: group, from: 200 })
    expect(h.last("sendMessage")!.text).toBe(WATCH_USAGE)
  })

  it("a repeat /watch answers the already-watching line", async () => {
    await h.text(`/watch ${A}`, { chat: group, from: 200 })
    await h.text(`/watch ${A}`, { chat: group, from: 200 })
    expect(h.last("sendMessage")!.text).toBe(dm.alreadyWatching("$GOBLO"))
    expect(await groupWatches()).toEqual([`-1001:${A}`])
  })

  it("the 51st token watch says the limit, and collections are counted apart", async () => {
    for (let i = 0; i < 50; i++)
      await sql`insert into bot.chat_token_watches (chat_id, target) values (-1001, ${addr(0x5000 + i)})`
    await h.text(`/watch ${A}`, { chat: group, from: 200 })
    expect(h.last("sendMessage")!.text).toBe(WATCH_LIMIT)
    expect(await sql`select 1 from bot.chat_token_watches`).toHaveLength(50)
    for (let i = 0; i < 50; i++)
      await sql`insert into bot.nft_watches (chat_id, contract) values (-1001, ${addr(0x6000 + i)})`
    // 50 collections do not stop a token, and 50 tokens do not stop a collection (see the NFT tests).
    await sql`delete from bot.chat_token_watches where target = ${addr(0x5000)}`
    await h.text(`/watch ${A}`, { chat: group, from: 200 })
    expect(h.last("sendMessage")!.text).toBe(dm.groupWatching("$GOBLO"))
  })

  it("Watched tokens for a group opens in the DM with the chat name, Back to the group's settings", async () => {
    await sql`insert into bot.chat_token_watches (chat_id, target) values (-1001, ${A})`
    await h.tap("gl:-1001:t")
    const m = h.last("editMessageText")!
    expect(m.text).toBe(
      "<b>Watched tokens for Test Group</b>\n\nThese are all the tokens you are currently watching. If you no longer wish to receive alerts for these, simply click Remove next to each token.",
    )
    expect(kbOf(m)).toEqual([
      [
        { text: "$GOBLO", callback_data: `t:${A}:ys1` },
        { text: "Remove", callback_data: `gl:-1001:t:${A}` },
      ],
      [{ text: "Back", callback_data: "al:-1001" }],
    ])
  })

  it("Watched tokens for a group is admin-only", async () => {
    await sql`insert into bot.chat_token_watches (chat_id, target) values (-1001, ${A})`
    nonAdmin()
    await h.tap("gl:-1001:t")
    expect(h.last("answerCallbackQuery")).toMatchObject({ text: NOT_ADMIN, show_alert: true })
    await h.tap(`gl:-1001:t:${A}`)
    expect(await groupWatches()).toEqual([`-1001:${A}`])
  })

  it("Remove answers the stop pop-up and redraws", async () => {
    await sql`insert into bot.chat_token_watches (chat_id, target) values (-1001, ${A})`
    await h.tap(`gl:-1001:t:${A}`)
    expect(popupText()).toBe(popup.stop("$GOBLO"))
    expect(h.last("editMessageText")!.text).toBe(
      "<b>Watched tokens for Test Group</b>\n\nYou're not watching anything yet. Tap Watch on any alert or card to add it here.",
    )
    expect(await groupWatches()).toEqual([])
  })

  it("a token opened from the group's list arrives without Back", async () => {
    await h.tap(`t:${A}:ys1`)
    const kb = kbOf(h.last("sendPhoto") ?? h.last("sendMessage"))
    expect(kb.flat().some((b) => b.text === "Back")).toBe(false)
  })

  it("the user's own Watched tokens never open in a group", async () => {
    h.clear()
    await h.tap("wl", { chat: group, from: 200 })
    await h.tap(`wl:rm:${A}`, { chat: group, from: 200 })
    await h.tap("gl:-1001:t", { chat: group, from: 200 })
    expect(h.calls.filter((c) => c.method === "editMessageText")).toHaveLength(0)
  })

  it("the Watch button on a group alert opens the DM and changes nothing", async () => {
    await h.text(`/start w_${A}`)
    expect(await subs()).toEqual(["watch"])
    expect(await groupWatches()).toEqual([])
    h.clear()
    await h.tap(`w:${A}`, { chat: group, from: 200, keyboard: alertKb })
    expect(await groupWatches()).toEqual([])
  })
})

describe("parseWatchArgs", () => {
  it.each([
    ["$GOBLO 500k", "$GOBLO", 500_000],
    ["goblo 1.5m", "goblo", 1_500_000],
    ["goblo $500k", "goblo", 500_000],
    ["goblo 500000", "goblo", 500_000],
    ["goblo $500", "goblo", 500],
    ["goblo 1000", "goblo", 1000],
    ["Goblo Two 2M", "Goblo Two", 2_000_000],
    ["goblo $1234.56", "goblo", 1235],
    ["goblo 1.2345k", "goblo", 1235],
  ])("%s has a target", (text, query, targetUsd) => {
    expect(parseWatchArgs(text)).toEqual({ query, targetUsd, badAmount: false })
  })

  it.each([
    ["pepe 2", "pepe 2"],
    ["$pepe", "$pepe"],
    ["pepe 999", "pepe 999"],
    ["500k", "500k"],
    [`pepe ${addr(0xa1)}`, `pepe ${addr(0xa1)}`],
  ])("%s has no target", (text, query) => {
    expect(parseWatchArgs(text)).toEqual({ query, targetUsd: null, badAmount: false })
  })

  it.each(["goblo 500x", "goblo $5oo", "goblo 1.2.3k", "goblo $0", "goblo 0k", "goblo $0.4"])(
    "%s is a bad amount",
    (text) => {
      expect(parseWatchArgs(text).badAmount).toBe(true)
    },
  )
})

describe("/watch with a market cap target", () => {
  const group = { id: -1001, type: "supergroup" as const, title: "Alpha" }
  const B = addr(0xa2)
  /** Goblo at 84 ETH, $210K at $2,500. */
  const priced = () => insertEvents(sql, [trade({ token: A, marketCap: String(84n * ETH) })])
  const target = async (table = "subscriptions") =>
    (
      await sql.unsafe(
        `select target, target_usd::float8 as usd, target_up as up, target_set_usd::float8 as "setUsd",
           target_set_at is not null as "setAt" from bot.${table}`,
      )
    ).map((r) => ({ ...r }))
  const sent = () => h.calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text)

  it("/watch $GOBLO 500k sets an upward target", async () => {
    await priced()
    await h.text("/watch $GOBLO 500k")
    expect(sent()).toEqual([
      "Watching Goblo. I'll alert you when its market cap reaches $500K (now $210K).",
    ])
    expect(await target()).toEqual([
      { target: A, usd: 500_000, up: true, setUsd: 210_000, setAt: true },
    ])
  })

  it("a target below the current cap is downward", async () => {
    await priced()
    await h.text("/watch goblo 150k")
    expect(h.last("sendMessage")!.text).toBe(
      "Watching Goblo. I'll alert you when its market cap drops to $150K (now $210K).",
    )
    expect(await target()).toMatchObject([{ usd: 150_000, up: false }])
  })

  it("a second target replaces the first", async () => {
    await priced()
    await h.text("/watch $GOBLO 500k")
    await h.text(`/watch ${A} $750k`)
    expect(h.last("sendMessage")!.text).toBe(
      "Goblo's target is now $750K, replacing $500K (now $210K).",
    )
    expect(await target()).toMatchObject([{ usd: 750_000, up: true }])
  })

  it("setting a target sends exactly one reply, in a DM and in a group", async () => {
    await priced()
    await addChat(sql, group.id, "supergroup")
    await h.text("/watch $GOBLO 500k")
    expect(sent()).toHaveLength(1)
    h.clear()
    await h.text("/watch $GOBLO 500k", { chat: group, from: 200, thread: 5 })
    expect(h.calls.filter((c) => c.method === "sendMessage").map((c) => c.payload)).toMatchObject([
      {
        text: "Watching Goblo. I'll alert you when its market cap reaches $500K (now $210K).",
        message_thread_id: 5,
      },
    ])
    expect(await target("chat_token_watches")).toEqual([
      { target: A, usd: 500_000, up: true, setUsd: 210_000, setAt: true },
    ])
  })

  it("two tokens named GOBLO give a pick list, bonded first", async () => {
    await insertEvents(sql, [
      launch({ token: B, ticker: "GOBLO", name: "Goblo", blockNumber: "1001" }),
      bond({ token: B }),
      swap({ token: B, marketCap: String(84n * ETH), blockTimestamp: T0 + 9000 }),
    ])
    await priced()
    await h.text("/watch $goblo 500k")
    const m = h.last("sendMessage")!
    expect(m.text).toBe("More than one token is called $GOBLO. Which one?")
    expect(kbOf(m)).toEqual([
      [{ text: "Goblo · 0x0000…00a2", callback_data: `wt:${B}:500000` }],
      [{ text: "Goblo · 0x0000…00a1", callback_data: `wt:${A}:500000` }],
    ])
    expect(await target()).toEqual([])
    await h.tap(`wt:${B}:500000`)
    expect(await target()).toMatchObject([{ target: B, usd: 500_000 }])
    expect(h.last("sendMessage")!.text).toBe(
      "Watching Goblo. I'll alert you when its market cap reaches $500K (now $210K).",
    )
  })

  it("a first-time user's /watch with a pick list creates the user and sends the welcome card after", async () => {
    await insertEvents(sql, [launch({ token: B, ticker: "GOBLO", name: "Goblo two" })])
    await h.text("/watch goblo", { from: 300 })
    const texts = h.calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text)
    expect(texts).toHaveLength(2)
    expect(texts[0]).toBe("More than one token is called $GOBLO. Which one?")
    expect(texts[1]).toContain("<b>MAKO</b> · real-time alerts")
    expect(await sql`select 1 from bot.users where platform_user_id = 300`).toHaveLength(1)
  })

  it("a tap on the pick list never creates a user", async () => {
    await h.tap(`wt:${A}:0`, { from: 301 })
    expect(await sql`select 1 from bot.users where platform_user_id = 301`).toHaveLength(0)
  })

  it("a pick without a target watches the token as before", async () => {
    await insertEvents(sql, [launch({ token: B, ticker: "GOBLO", name: "Goblo two" })])
    await h.text("/watch goblo")
    expect(
      kbOf(h.last("sendMessage"))
        .flat()
        .map((b) => b.callback_data),
    ).toEqual([`wt:${B}:0`, `wt:${A}:0`]) // Neither has traded, so the newer launch comes first.
    await h.tap(`wt:${B}:0`)
    expect(h.last("sendMessage")!.text).toBe(dm.watching("$GOBLO", "token"))
    expect(await target()).toEqual([{ target: B, usd: null, up: null, setUsd: null, setAt: false }])
  })

  it("a non-admin tapping the group's pick list gets NOT_ADMIN and nothing changes", async () => {
    await insertEvents(sql, [launch({ token: B, ticker: "GOBLO", name: "Goblo two" })])
    await priced()
    await addChat(sql, group.id, "supergroup")
    h.on("getChatMember", (p) => ({
      status: "member",
      user: { id: p.user_id, is_bot: false, first_name: "A" },
    }))
    await h.tap(`wt:${A}:500000`, { chat: group, from: 300 })
    expect(h.last("answerCallbackQuery")).toMatchObject({ text: NOT_ADMIN, show_alert: true })
    expect(await target("chat_token_watches")).toEqual([])
  })

  it("no fresh price refuses the target and leaves the watchlist unchanged", async () => {
    await priced()
    ethUsd = null
    await h.text("/watch $GOBLO 500k")
    expect(sent()).toEqual([
      "I can't set a target for Goblo right now because I don't have a current price for it. Try again in a few minutes.",
    ])
    expect(await target()).toEqual([])
  })

  it("a token that never traded has no price either", async () => {
    await h.text("/watch $GOBLO 500k")
    expect(h.last("sendMessage")!.text).toMatch(/^I can't set a target for Goblo/)
    expect(await target()).toEqual([])
  })

  it("/watch $GOBLO 500x replies TARGET_BAD_AMOUNT", async () => {
    await priced()
    await h.text("/watch $GOBLO 500x")
    expect(sent()).toEqual([TARGET_BAD_AMOUNT])
    expect(TARGET_BAD_AMOUNT).toBe(
      "I couldn't read that amount. Try something like /watch $GOBLO 500k, 1.5m or $500000.",
    )
    expect(await target()).toEqual([])
  })

  it("group admin sets the group's target, non-admin gets NOT_ADMIN", async () => {
    await priced()
    await addChat(sql, group.id, "supergroup")
    await h.text("/watch $GOBLO 1m", { chat: group, from: 200 })
    expect(await target("chat_token_watches")).toMatchObject([{ usd: 1_000_000 }])
    h.on("getChatMember", (p) => ({
      status: "member",
      user: { id: p.user_id, is_bot: false, first_name: "A" },
    }))
    await h.text("/watch $GOBLO 2m", { chat: group, from: 300 })
    expect(h.last("sendMessage")!.text).toBe(NOT_ADMIN)
    expect(await target("chat_token_watches")).toMatchObject([{ usd: 1_000_000 }])
  })

  it("/watch without an amount works as before, by address or by ticker", async () => {
    await h.text(`/watch ${A}`)
    expect(h.last("sendMessage")!.text).toBe(dm.watching("$GOBLO", "token"))
    await sql`delete from bot.subscriptions`
    await h.text("/watch $goblo")
    expect(h.last("sendMessage")!.text).toBe(dm.watching("$GOBLO", "token"))
    expect(await target()).toEqual([{ target: A, usd: null, up: null, setUsd: null, setAt: false }])
  })

  it("a target that fires while it is being replaced is not named as replaced", async () => {
    await priced()
    await h.text("/watch $GOBLO 500k")
    const deps = { sql } as Parameters<typeof setTarget>[0]
    // The poller clears the fired target and holds its row lock until the delivery commits.
    let release!: () => void
    const held = new Promise<void>((r) => {
      release = r
    })
    let locked!: () => void
    const isLocked = new Promise<void>((r) => {
      locked = r
    })
    const clearing = sql.begin(async (tx) => {
      await tx`update bot.subscriptions set target_usd = null, target_up = null, target_set_usd = null, target_set_at = null`
      locked()
      await held
    })
    await isLocked
    const replacing = setTarget(deps, { userId }, A, 750_000, 210_000)
    await new Promise((r) => setTimeout(r, 100))
    release()
    await clearing
    expect(await replacing).toBeNull()
    expect(await target()).toMatchObject([{ usd: 750_000 }])
  })

  it("the watched list shows the target", async () => {
    await priced()
    await addChat(sql, group.id, "supergroup")
    await h.text("/watch $GOBLO 500k")
    await h.tap("wl")
    expect(kbOf(h.last("editMessageText"))[0]![0]).toEqual({
      text: "Goblo · $500K",
      callback_data: `t:${A}:wl`,
    })
    await h.text("/watch $GOBLO 1.5m", { chat: group, from: 200 })
    await h.tap(`gl:${group.id}:t`)
    expect(kbOf(h.last("editMessageText"))[0]![0]!.text).toBe("Goblo · $1.5M")
  })

  it("the watched list falls back to the ticker for a token with no name", async () => {
    await insertEvents(sql, [
      launch({ token: B, ticker: "NONAME", name: null }),
      trade({ token: B, marketCap: String(84n * ETH) }),
    ])
    await h.text(`/watch ${B} 500k`)
    await h.tap("wl")
    expect(kbOf(h.last("editMessageText"))[0]![0]!.text).toBe("$NONAME · $500K")
  })

  it("the Tokens menu describes the target", async () => {
    await h.tap("tk")
    expect(h.last("editMessageText")!.text).toContain(
      "/watch &lt;token&gt; [mcap] watch a token, with an optional market cap alert",
    )
  })
})

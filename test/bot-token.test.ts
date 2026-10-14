import { InputFile } from "grammy"
import { afterAll, beforeEach, describe, expect, inject, it, vi } from "vitest"
import type { Sql } from "../src/db"
import { escapeHtml } from "../src/format"
import { unknownTokenText } from "../src/launchpads"
import { EMPTY } from "../src/menus/lists"
import { LOOKUP_PROMPT } from "../src/menus/token"
import { WATCH_PROMPT } from "../src/menus/watchlist"
import { createBot } from "../src/platforms/telegram/bot"
import type { Prices } from "../src/prices"
import { addUser, subscribe } from "./helpers/bot"
import { insertEvents, resetDb, setCursorBlock } from "./helpers/db"
import { addr, bond, ETH, hash, launch, trade } from "./helpers/events"
import { imageResponse, testImages } from "./helpers/images"
import { BOT_INFO, harness, type Payload } from "./helpers/tg"

const prices: Prices = { usd: () => 2500, symbol: () => "ETH" }
const report = vi.fn()
const A = addr(0xa1)
const CHECKSUMMED = "0x00000000000000000000000000000000000000A1"
let sql: Sql
let h: ReturnType<typeof harness>
let img: ReturnType<typeof testImages>

beforeEach(async () => {
  img = testImages()
  await sql?.end()
  sql = await resetDb(inject("databaseUrl"))
  report.mockClear()
  h = harness(
    createBot({
      token: "1:test",
      botInfo: BOT_INFO,
      sql,
      prices,
      log: () => {},
      report,
      linksBase: "https://go.makobot.xyz",
      images: img.images,
    }),
  )
  await insertEvents(sql, [
    launch({
      token: A,
      ticker: "GOBLO",
      name: "Goblo",
      description: "A <b>goblin</b>",
      blockNumber: "1000",
    }),
    trade({ token: A, soldBps: 8000, marketCap: String(85n * ETH), blockNumber: "1001" }),
  ])
  await setCursorBlock(sql, 1001)
})
afterAll(() => sql.end())

const kbOf = (p: Payload | undefined) =>
  (p?.reply_markup?.inline_keyboard ?? []) as {
    text: string
    url?: string
    callback_data?: string
  }[][]
const userCount = async () => (await sql`select 1 from bot.users`).length

describe("token card", () => {
  it("opens from /t with a checksummed address as a padded photo with the card as caption", async () => {
    await h.text(`/t ${CHECKSUMMED}`)
    expect(h.last("sendMessage")).toBeUndefined()
    const m = h.last("sendPhoto")!
    expect(m.photo).toBeInstanceOf(InputFile)
    expect(m.parse_mode).toBe("HTML")
    expect(m.caption.split("\n").slice(0, 4)).toEqual([
      "<b>$GOBLO</b>",
      "Goblo · InkyPump",
      "",
      "<code>curve    ■■■■■■■■□□ 80%</code>",
    ])
    expect(m.caption).not.toContain("Not a token")
    expect(m.caption).toContain("<code>mcap     $213K</code>")
    expect(m.caption).toContain("A &lt;b&gt;goblin&lt;/b&gt;")
    expect(m.caption).toContain(`CA   <code>${A}</code>`)
    expect(m.link_preview_options).toBeUndefined()
    expect(kbOf(m)).toEqual([
      [
        { text: "Trade", url: `https://go.makobot.xyz/t/${A}` },
        { text: "Watch", callback_data: `w:${A}` },
      ],
      [
        { text: "Refresh", callback_data: `tr:${A}` },
        { text: "Explorer", url: `https://explorer.inkonchain.com/token/${A}` },
      ],
    ])
    expect(img.fetchFn).toHaveBeenCalledOnce()
    expect((img.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain(
      encodeURIComponent("https://images.inkypump.com/original/abc.jpg"),
    )
    // The uploaded photo's file_id is reused by the next card for the token.
    h.clear()
    await h.text(`/t ${A}`)
    expect(h.last("sendPhoto")!.photo).toBe("UPLOADED")
    expect(img.fetchFn).toHaveBeenCalledOnce()
  })

  it("sends the card as text, with no link preview, when the token has no usable image", async () => {
    await sql`update indexer.events set payload = jsonb_set(payload, '{imageUrl}', '"http://x.io/a.png"') where type = 'launchpad.launch'`
    await h.text(`/t ${A}`)
    expect(h.last("sendPhoto")).toBeUndefined()
    const m = h.last("sendMessage")!
    expect(m.text).toContain("<b>$GOBLO</b>")
    expect(m.link_preview_options).toEqual({ is_disabled: true })
    expect(img.fetchFn).not.toHaveBeenCalled()
  })

  it("sends the card as text when the padded image cannot be fetched", async () => {
    const t = testImages((async () => imageResponse({ status: 500 })) as unknown as typeof fetch)
    h = harness(
      createBot({
        token: "1:test",
        botInfo: BOT_INFO,
        sql,
        prices,
        log: () => {},
        report,
        linksBase: "https://go.makobot.xyz",
        images: t.images,
      }),
    )
    await h.text(`/t ${A}`)
    expect(h.last("sendPhoto")).toBeUndefined()
    expect(h.last("sendMessage")!.link_preview_options).toEqual({ is_disabled: true })
  })

  it("replies in the topic where a group member asked", async () => {
    await h.text(`/t ${A}`, { chat: { id: -1001, type: "supergroup", title: "G" }, thread: 4 })
    expect(h.last("sendPhoto")).toMatchObject({ chat_id: -1001, message_thread_id: 4 })
  })

  it("opens from a t_ deep link", async () => {
    await h.text(`/start t_${A}`)
    expect(
      h.calls
        .filter((c) => c.method === "sendPhoto")
        .some((c) => String(c.payload.caption).startsWith("<b>$GOBLO</b>")),
    ).toBe(true)
  })

  it("opens from a pasted address and from the Look up prompt", async () => {
    await h.text(`check this ${CHECKSUMMED} pls`)
    expect(h.last("sendPhoto")!.caption).toContain("$GOBLO")
    await h.tap("look")
    expect(h.last("sendMessage")).toMatchObject({
      text: LOOKUP_PROMPT,
      reply_markup: { force_reply: true },
    })
    h.clear()
    await h.text(A, { replyTo: LOOKUP_PROMPT })
    expect(h.last("sendPhoto")!.caption).toContain("$GOBLO")
  })

  it("names launchpads from config for an unknown token", async () => {
    await h.text(`/t ${addr(0xbad)}`)
    expect(h.last("sendMessage")!.text).toBe(escapeHtml(unknownTokenText()))
  })

  it("sends a tapped list token as a new message and leaves the list untouched", async () => {
    await insertEvents(sql, [bond({ token: A, blockNumber: "1002" })])
    await h.tap(`t:${A}`)
    expect(h.last("editMessageText")).toBeUndefined()
    expect(h.last("editMessageCaption")).toBeUndefined()
    const m = h.last("sendPhoto")!
    expect(m.caption).toMatch(/<code>bonded {3}[^<]* ago at \$213K<\/code>/)
    expect(m.caption).not.toContain("mcap at bond")
    expect(h.last("answerCallbackQuery")).toBeDefined()
  })

  it("sends a tapped list token as a new text message when it has no image", async () => {
    await sql`update indexer.events set payload = jsonb_set(payload, '{imageUrl}', 'null') where type = 'launchpad.launch'`
    await h.tap(`t:${A}`)
    expect(h.last("editMessageText")).toBeUndefined()
    expect(h.last("sendMessage")!.text).toContain("<b>$GOBLO</b>")
  })

  it("never creates a user from a token tap", async () => {
    await h.tap(`t:${A}`)
    await h.tap(`tr:${A}`)
    expect(await userCount()).toBe(0)
  })

  it("refreshes a photo card by editing its caption and keyboard", async () => {
    await h.tap(`tr:${A}`, { photo: true })
    expect(h.last("editMessageText")).toBeUndefined()
    expect(h.last("sendPhoto")).toBeUndefined()
    const m = h.last("editMessageCaption")!
    expect(m.caption).toContain("<b>$GOBLO</b>")
    expect(m.parse_mode).toBe("HTML")
    expect(kbOf(m)[1]![0]).toEqual({ text: "Refresh", callback_data: `tr:${A}` })
    expect(img.fetchFn).not.toHaveBeenCalled()
    expect(h.last("answerCallbackQuery")).toBeDefined()
  })

  it("refreshes a text card by editing its text with the preview disabled", async () => {
    await h.tap(`tr:${A}`)
    const m = h.last("editMessageText")!
    expect(m.text).toContain("<b>$GOBLO</b>")
    expect(m.link_preview_options).toEqual({ is_disabled: true })
    expect(h.last("editMessageCaption")).toBeUndefined()
  })

  it("answers a tapped list token before the image is fetched and uploaded", async () => {
    await h.tap(`t:${A}`)
    const order = h.calls.map((c) => c.method)
    expect(order.indexOf("answerCallbackQuery")).toBeGreaterThanOrEqual(0)
    expect(order.indexOf("answerCallbackQuery")).toBeLessThan(order.indexOf("sendPhoto"))
  })

  it("sends the refreshed card as a new text message when its caption outgrew the photo's limit", async () => {
    const site = `https://example.com/${"a".repeat(1100)}`
    await sql`update indexer.events set payload = jsonb_set(payload, '{links,website}', to_jsonb(${site}::text)) where type = 'launchpad.launch'`
    await h.tap(`tr:${A}`, { photo: true })
    expect(h.last("editMessageCaption")).toBeUndefined()
    expect(h.last("sendPhoto")).toBeUndefined()
    expect(h.last("sendMessage")!.text).toContain("<b>$GOBLO</b>")
    expect(h.last("sendMessage")!.link_preview_options).toEqual({ is_disabled: true })
    expect(h.last("answerCallbackQuery")).toBeDefined()
    expect(report).not.toHaveBeenCalled()
  })

  it("answers Refresh on a photo card of an unknown token without editing it", async () => {
    await h.tap(`tr:${addr(0xbad)}`, { photo: true })
    expect(h.last("editMessageText")).toBeUndefined()
    expect(h.last("editMessageCaption")).toBeUndefined()
    expect(h.last("answerCallbackQuery")).toMatchObject({ text: unknownTokenText() })
  })

  it("survives Refresh producing an identical caption or text", async () => {
    h.on("editMessageText", () => ({ error: "Bad Request: message is not modified" }))
    h.on("editMessageCaption", () => ({ error: "Bad Request: message is not modified" }))
    await h.tap(`tr:${A}`)
    await h.tap(`tr:${A}`, { photo: true })
    await h.tap(`tr:${A}`, { photo: true })
    expect(report).not.toHaveBeenCalled()
    expect(h.calls.filter((c) => c.method === "answerCallbackQuery")).toHaveLength(3)
  })

  it("uses a deep link for Watch in groups", async () => {
    await h.text(`/t ${A}`, { chat: { id: -1001, type: "supergroup", title: "G" }, thread: 4 })
    const m = h.last("sendPhoto")!
    expect(m.message_thread_id).toBe(4)
    expect(kbOf(m)[0]![1]).toEqual({
      text: "Watch",
      url: `https://t.me/makoinkbot?start=w_${A}`,
    })
  })
})

describe("token card layout", () => {
  const POOL = hash(0xabc)
  const lines = (caption: string) => caption.split("\n")
  const bondedCard = async (poolId: string = POOL) => {
    await insertEvents(sql, [
      bond({ token: A, poolId: poolId as `0x${string}`, blockNumber: "1002" }),
    ])
    await h.text(`/t ${A}`)
    return h.last("sendPhoto")!
  }

  it("lays a curve token out like an alert: header, rows with windows, description, CA", async () => {
    await h.text(`/t ${A}`)
    const l = lines(h.last("sendPhoto")!.caption)
    expect(l.slice(0, 8)).toEqual([
      "<b>$GOBLO</b>",
      "Goblo · InkyPump",
      "",
      "<code>curve    ■■■■■■■■□□ 80%</code>",
      "<code>mcap     $213K</code>",
      "<code>volume   $50 (24h)</code>",
      "<code>trades   1 buy | 0 sells (24h)</code>",
      expect.stringMatching(/^<code>age {6}\d+[mhd]/),
    ])
    expect(l.slice(8)).toEqual([
      "<code>dev      0 buys | 0 sells</code>",
      "",
      "A &lt;b&gt;goblin&lt;/b&gt;",
      "",
      `CA   <code>${A}</code>`,
    ])
  })

  it("leaves out the description and its blank line when there is none", async () => {
    await sql`update indexer.events set payload = jsonb_set(payload, '{description}', 'null') where type = 'launchpad.launch'`
    await h.text(`/t ${A}`)
    const l = lines(h.last("sendPhoto")!.caption)
    expect(l.slice(-3)).toEqual([
      "<code>dev      0 buys | 0 sells</code>",
      "",
      `CA   <code>${A}</code>`,
    ])
    expect(l.filter((x) => x === "")).toHaveLength(2)
  })

  it("counts volume and trades over the last 24h from the cursor, and keeps mcap current", async () => {
    await setCursorBlock(sql, 1001 + 86_400 + 1)
    await h.text(`/t ${A}`)
    const c = h.last("sendPhoto")!.caption
    expect(c).toContain("<code>mcap     $213K</code>")
    expect(c).toContain("<code>volume   $0 (24h)</code>")
    expect(c).toContain("<code>trades   0 buys | 0 sells (24h)</code>")
  })

  it("shows the dev's trades without a window", async () => {
    await insertEvents(sql, [
      trade({ token: A, trader: addr(0xc1), side: "buy", soldBps: 8100, blockNumber: "1002" }),
      trade({ token: A, trader: addr(0xc1), side: "sell", soldBps: 8000, blockNumber: "1003" }),
    ])
    await h.text(`/t ${A}`)
    expect(h.last("sendPhoto")!.caption).toContain("<code>dev      1 buy | 1 sell</code>")
  })

  it("lays a bonded token out with a status row and curve totals", async () => {
    const m = await bondedCard()
    const l = lines(m.caption)
    expect(l.slice(0, 4)).toEqual(["<b>$GOBLO</b>", "Goblo · InkyPump", "", expect.any(String)])
    expect(l[3]).toMatch(/^<code>bonded {3}\d+d( \d+h)? ago at \$213K<\/code>$/)
    expect(l.slice(4, 6)).toEqual([
      "<code>volume   $50 (on curve)</code>",
      "<code>trades   1 buy | 0 sells (on curve)</code>",
    ])
    expect(l[6]).toMatch(/^<code>age {6}/)
    expect(l[7]).toBe("<code>dev      0 buys | 0 sells</code>")
    expect(l[8]).toBe("")
    expect(m.caption).not.toContain("<code>curve")
    expect(m.caption).not.toContain("mcap")
  })

  it("adds Chart for a bonded token from its bond event's poolId", async () => {
    const m = await bondedCard()
    expect(kbOf(m)).toEqual([
      [
        { text: "Trade", url: `https://go.makobot.xyz/t/${A}` },
        { text: "Watch", callback_data: `w:${A}` },
      ],
      [
        { text: "Chart", url: `https://www.geckoterminal.com/ink/pools/${POOL}` },
        { text: "Explorer", url: `https://explorer.inkonchain.com/token/${A}` },
      ],
      [{ text: "Refresh", callback_data: `tr:${A}` }],
    ])
  })

  it("lowercases the poolId for the Chart link", async () => {
    const m = await bondedCard(`0x${"AB".repeat(32)}`)
    expect(kbOf(m)[1]![0]).toEqual({
      text: "Chart",
      url: `https://www.geckoterminal.com/ink/pools/0x${"ab".repeat(32)}`,
    })
  })

  it.each([["0xabc"], [`0x${"g".repeat(64)}`], [`${"a".repeat(64)}`], [`0x${"a".repeat(65)}`]])(
    "omits Chart for a malformed poolId (%s)",
    async (poolId) => {
      const m = await bondedCard(poolId)
      expect(
        kbOf(m)
          .flat()
          .map((b) => b.text),
      ).toEqual(["Trade", "Watch", "Explorer", "Refresh"])
    },
  )

  it("keeps a curve token's two-row keyboard without Chart", async () => {
    await h.text(`/t ${A}`)
    expect(kbOf(h.last("sendPhoto")).map((r) => r.map((b) => b.text))).toEqual([
      ["Trade", "Watch"],
      ["Refresh", "Explorer"],
    ])
  })
})

describe("discovery lists", () => {
  it("lists hot tokens with a button each", async () => {
    await h.tap("l:hot")
    const m = h.last("editMessageText")!
    expect(m.text.split("\n")[0]).toBe("<b>Hot now (24h)</b>")
    expect(m.text).toContain("1. $GOBLO · Goblo · 1 trade (24h)")
    expect(kbOf(m)).toEqual([
      [{ text: "$GOBLO", callback_data: `t:${A}` }],
      [{ text: "Menu", callback_data: "m" }],
    ])
  })

  it("falls back to 7 days for hot tokens and says so in the title", async () => {
    await setCursorBlock(sql, 1001 + 100_000)
    await h.tap("l:hot")
    const m = h.last("editMessageText")!
    expect(m.text.split("\n")[0]).toBe("<b>Hot now (7d)</b>")
    expect(m.text).toContain("1. $GOBLO · Goblo · 1 trade (7d)")
  })

  it("shows the empty line when nothing traded in 7 days", async () => {
    await setCursorBlock(sql, 1001 + 700_000)
    await h.tap("l:hot")
    const m = h.last("editMessageText")!
    expect(m.text).toContain(EMPTY.hot)
    expect(kbOf(m)).toEqual([[{ text: "Menu", callback_data: "m" }]])
  })

  it("lists unbonded tokens from 10% by progress, leaving out bonded, 0% and quiet ones", async () => {
    const [B, C, D, E] = [addr(0xb1), addr(0xc2), addr(0xd2), addr(0xe2)]
    await insertEvents(sql, [
      launch({ token: B, ticker: "BEE", name: "Bee", blockNumber: "1002" }),
      trade({ token: B, soldBps: 3000, blockNumber: "1003" }),
      launch({ token: C, ticker: "CEE", name: "Cee", blockNumber: "1004" }),
      trade({ token: C, soldBps: 0, blockNumber: "1005" }),
      launch({ token: D, ticker: "DEE", name: "Dee", blockNumber: "1006" }),
      trade({ token: D, soldBps: 9500, blockNumber: "1007" }),
      bond({ token: D, blockNumber: "1008" }),
      launch({ token: E, ticker: "EEE", name: "Eee", blockNumber: "1009" }),
      trade({ token: E, soldBps: 500, blockNumber: "1010" }),
    ])
    await setCursorBlock(sql, 1010)
    await h.tap("l:near")
    const m = h.last("editMessageText")!
    expect(m.text).toBe("<b>Near bonding</b>\n1. $GOBLO · Goblo · 80%\n2. $BEE · Bee · 30%")
    expect(kbOf(m).map((r) => r[0]!.text)).toEqual(["$GOBLO", "$BEE", "Menu"])
  })

  it("keeps a token near bonding for 7 days", async () => {
    await setCursorBlock(sql, 1001 + 600_000)
    await h.tap("l:near")
    expect(h.last("editMessageText")!.text).toContain("$GOBLO")
    await setCursorBlock(sql, 1001 + 700_000)
    await h.tap("l:near")
    expect(h.last("editMessageText")!.text).toContain(EMPTY.near)
  })

  it("calls the bonded list Recently bonded", async () => {
    await insertEvents(sql, [bond({ token: A, blockNumber: "1002" })])
    await h.tap("l:bonded")
    expect(h.last("editMessageText")!.text.split("\n")[0]).toBe("<b>Recently bonded</b>")
    expect(h.last("editMessageText")!.text).toContain("1. $GOBLO · Goblo · bonded ")
    await sql`delete from indexer.events where type = 'launchpad.bond'`
    await h.tap("l:bonded")
    expect(h.last("editMessageText")!.text).toBe(`<b>Recently bonded</b>\n${EMPTY.bonded}`)
  })

  it.each([["hot"], ["near"], ["bonded"]] as const)("shows an empty state for %s", async (kind) => {
    await sql`delete from indexer.events`
    await h.tap(`l:${kind}`)
    const m = h.last("editMessageText")!
    expect(m.text).toContain(EMPTY[kind])
    expect(kbOf(m)).toEqual([[{ text: "Menu", callback_data: "m" }]])
  })
})

describe("watchlist and mutes", () => {
  it("adds from the prompt, lists, removes, and logs without user ids", async () => {
    await h.tap("wl:add")
    expect(h.last("sendMessage")).toMatchObject({
      text: WATCH_PROMPT,
      reply_markup: { force_reply: true },
    })
    await h.text(CHECKSUMMED, { replyTo: WATCH_PROMPT })
    expect(await sql`select target from bot.subscriptions where kind = 'watch'`).toEqual([
      { target: A },
    ])
    await h.tap("wl")
    expect(kbOf(h.last("editMessageText"))[0]).toEqual([
      { text: "Remove $GOBLO", callback_data: `wl:rm:${A}` },
    ])
    await h.tap(`wl:rm:${A}`)
    expect(await sql`select 1 from bot.subscriptions`).toHaveLength(0)
    expect(
      await sql`select chat_type, chat_id, action, token from bot.user_actions where action <> 'start' order by id`,
    ).toEqual([
      { chat_type: "private", chat_id: null, action: "watch", token: A },
      { chat_type: "private", chat_id: null, action: "unwatch", token: A },
    ])
  })

  it("watches from a group deep link, lowercasing the address", async () => {
    await h.text(`/start w_${CHECKSUMMED}`)
    expect(await sql`select target from bot.subscriptions`).toEqual([{ target: A }])
  })

  it("watches a checksummed address from /watch", async () => {
    await addUser(sql, 100)
    await h.text(`/watch ${CHECKSUMMED}`)
    expect(h.last("sendMessage")!.text).toContain("Watching $GOBLO")
    expect(await sql`select target from bot.subscriptions`).toEqual([{ target: A }])
  })

  it("confirms the watch, then shows the welcome card, when /watch recreates a deleted user", async () => {
    await h.text("/start")
    await h.tap("dd:yes")
    h.clear()
    await h.text(`/watch ${A}`)
    const texts = h.calls.filter((c) => c.method === "sendMessage").map((c) => c.payload.text)
    expect(texts).toHaveLength(2)
    expect(texts[0]).toContain("Watching $GOBLO")
    expect(texts[1]).toContain("<b>MAKO</b> · real-time alerts")
    expect(h.last("sendMessage")!.reply_markup.inline_keyboard.flat().length).toBeGreaterThan(5)
    h.clear()
    await h.text(`/watch ${A}`)
    expect(h.calls.filter((c) => c.method === "sendMessage")).toHaveLength(1)
  })

  it("caps the watchlist at 50", async () => {
    const id = await addUser(sql, 100)
    for (let i = 0; i < 50; i++) await subscribe(sql, id, "watch", addr(0x5000 + i))
    await h.text(`/watch ${A}`)
    expect(h.last("sendMessage")!.text).toContain("full (50 tokens)")
  })

  it("toggles Watch and Mute on a DM alert and relabels the button", async () => {
    await addUser(sql, 100)
    const keyboard = [
      [
        { text: "Trade", url: "u" },
        { text: "Watch", callback_data: `w:${A}` },
        { text: "Mute", callback_data: `m:${A}` },
      ],
    ]
    await h.tap(`w:${A}`, { keyboard })
    expect(kbOf(h.last("editMessageReplyMarkup"))[0]![1]!.text).toBe("Watching")
    await h.tap(`m:${A}`, { keyboard })
    expect(kbOf(h.last("editMessageReplyMarkup"))[0]![2]!.text).toBe("Unmute")
    expect(
      (await sql`select kind from bot.subscriptions order by kind`).map((r) => r.kind),
    ).toEqual(["mute", "watch"])
    await h.tap(`m:${A}`, { keyboard })
    expect((await sql`select kind from bot.subscriptions`).map((r) => r.kind)).toEqual(["watch"])
  })

  it("treats repeated taps with identical text as success", async () => {
    await addUser(sql, 100)
    h.on("editMessageReplyMarkup", () => ({ error: "Bad Request: message is not modified" }))
    const keyboard = [[{ text: "Watch", callback_data: `w:${A}` }]]
    await h.tap(`w:${A}`, { keyboard })
    await h.tap(`w:${A}`, { keyboard })
    h.on("editMessageText", () => ({ error: "Bad Request: message is not modified" }))
    await h.tap("wl")
    await h.tap("wl")
    await h.tap("l:hot")
    await h.tap("l:hot")
    expect(report).not.toHaveBeenCalled()
  })

  it("creates no user from taps on old buttons after Delete my data", async () => {
    await h.text("/start")
    await h.tap("dd:yes")
    expect(await userCount()).toBe(0)
    h.clear()
    // Screens say so in place; alert buttons answer without editing the alert.
    for (const data of [`wl:rm:${A}`, `um:${A}`, "wl", "mu"]) {
      await h.tap(data)
      expect(await userCount()).toBe(0)
      expect(h.last("editMessageText")!.text).toBe("Send /start to use MAKO.")
      h.clear()
    }
    for (const data of [`w:${A}`, `m:${A}`]) {
      await h.tap(data, { keyboard: [[{ text: "Watch", callback_data: data }]] })
      expect(await userCount()).toBe(0)
      expect(h.last("answerCallbackQuery")).toMatchObject({ text: "Send /start to use MAKO." })
      expect(h.last("editMessageReplyMarkup")).toBeUndefined()
      expect(h.last("editMessageText")).toBeUndefined()
      h.clear()
    }
    expect(await sql`select 1 from bot.subscriptions`).toHaveLength(0)
    expect(
      await sql`select 1 from bot.user_actions where action in ('watch','unwatch','mute','unmute')`,
    ).toHaveLength(0)
  })
})

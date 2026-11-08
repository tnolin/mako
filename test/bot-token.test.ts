import { InputFile } from "grammy"
import { afterAll, afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest"
import type { Sql } from "../src/db"
import { escapeHtml } from "../src/format"
import { NOT_FOUND } from "../src/menus/copy"
import { EMPTY } from "../src/menus/lists"
import { REFRESH_COOLDOWN_MS, refreshCooldown } from "../src/menus/token"
import { createBot } from "../src/platforms/telegram/bot"
import { UNISWAP_V4_POOL_MANAGER } from "../src/pool"
import type { Prices } from "../src/prices"
import { insertEvents, resetDb, setCursorBlock } from "./helpers/db"
import { addr, bond, ETH, launch, swap, trade } from "./helpers/events"
import { loadTsunami } from "./helpers/fixtures"
import {
  HKT,
  HMU,
  HMU_SPLIT_WAMZNX,
  HMU_SPLIT_WNVDAX,
  HOOC,
  HOOC_FIRST_BUY,
  INKY,
  INKY_USDG_SELL,
  INKY_WMSTRX_BUY,
  SYNTHETIC_CUSTOM,
  USDG,
  WMSTRX,
  WNVDAX,
} from "./helpers/hookit"
import { imageResponse, testImages } from "./helpers/images"
import { BOT_INFO, harness, type Payload } from "./helpers/tg"

// Every quote is $2,500 unless a test replaces the price of some.
let usdOf: (quote: string) => number | null = () => 2500
const prices: Prices = { usd: (q) => usdOf(q), symbol: () => "ETH" }
const report = vi.fn()
const A = addr(0xa1)
const CHECKSUMMED = "0x00000000000000000000000000000000000000A1"
let sql: Sql
let h: ReturnType<typeof harness>
let img: ReturnType<typeof testImages>
// Live KRAK reading (2026-10-14): 5.3289 ETH at 1B supply. At the test price of $2,500 that is $13.3K.
const KRAK_SQRT = 1085330431310623941983443206493297n
const POOL = `0x${"ab".repeat(32)}` as `0x${string}`
const log = vi.fn()
// Default: the node is unreachable, so bonded cards use the bonded-at row unless a test opts in.
let readSqrtPrice: ReturnType<
  typeof vi.fn<(poolManager: string, poolId: string) => Promise<bigint>>
>

beforeEach(async () => {
  usdOf = () => 2500
  img = testImages()
  await sql?.end()
  sql = await resetDb(inject("databaseUrl"))
  report.mockClear()
  log.mockReset()
  readSqrtPrice = vi.fn(async (_poolManager: string, _poolId: string): Promise<bigint> => {
    throw new Error("no node in tests")
  })
  h = harness(
    createBot({
      token: "1:test",
      botInfo: BOT_INFO,
      sql,
      prices,
      log,
      report,
      linksBase: "https://go.makobot.xyz",
      images: img.images,
      readSqrtPrice,
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
    expect((img.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(
      "https://images.inkypump.com/original/abc.jpg",
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

  it("opens from a pasted address", async () => {
    await h.text(`check this ${CHECKSUMMED} pls`)
    expect(h.last("sendPhoto")!.caption).toContain("$GOBLO")
  })

  it("says it could not find an unknown token", async () => {
    await h.text(`/t ${addr(0xbad)}`)
    expect(h.last("sendMessage")!.text).toBe(escapeHtml(NOT_FOUND))
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
    expect(h.last("answerCallbackQuery")).toMatchObject({ text: NOT_FOUND })
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
  const lines = (caption: string) => caption.split("\n")
  const bondedCard = async () => {
    await insertEvents(sql, [bond({ token: A, blockNumber: "1002" })])
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

  it("a Tsunami launch card reads Name · Tsunami", async () => {
    const { launch: l, seedBuy } = loadTsunami().shitcoin
    await insertEvents(sql, [l, seedBuy])
    await h.text(`/t ${l.token}`)
    const caption = h.last("sendPhoto")!.caption
    expect(lines(caption).slice(0, 2)).toEqual(["<b>$SHITCOIN</b>", "Shitcoin · Tsunami"])
  })

  it('a Hookit card reads "Name · Hookit"', async () => {
    const token = addr(0xa7)
    await insertEvents(sql, [
      launch({ token, launchpad: "hookit", name: "Hookling", ticker: "HKL", blockNumber: "1002" }),
    ])
    await h.text(`/t ${token}`)
    const caption = h.last("sendPhoto")!.caption
    expect(lines(caption).slice(0, 2)).toEqual(["<b>$HKL</b>", "Hookling · Hookit"])
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
    expect(l[3]).toMatch(/^<code>bonded {3}\d+d ago at \$213K<\/code>$/)
    expect(l.slice(4, 6)).toEqual([
      "<code>volume   $50</code>",
      "<code>trades   1 buy | 0 sells</code>",
    ])
    expect(l[6]).toMatch(/^<code>age {6}/)
    expect(l[7]).toBe("<code>dev      0 buys | 0 sells</code>")
    expect(l[8]).toBe("")
    expect(m.caption).not.toContain("<code>curve")
    expect(m.caption).not.toContain("mcap")
    expect(m.caption).not.toContain("on curve")
  })

  it("/t bonded volume includes pool trades", async () => {
    await insertEvents(sql, [
      bond({ token: A, blockNumber: "1002" }),
      swap({ token: A, quoteAmount: String(ETH / 10n), blockNumber: "1003" }),
      swap({ token: A, side: "sell", quoteAmount: String(ETH / 5n), blockNumber: "1004" }),
    ])
    await h.text(`/t ${A}`)
    const c = h.last("sendPhoto")!.caption
    // 0.02 ETH on the curve plus 0.3 ETH in the pool, at $2,500.
    expect(c).toContain("<code>volume   $800</code>")
    expect(c).toContain("<code>trades   2 buys | 1 sell</code>")
  })

  it.each([
    [29 * 86_400 + 3 * 3600, "29d"],
    [86_400 + 60, "1d"],
    [23 * 3600 + 600, "23h"],
    [5 * 3600 + 600, "5h"],
    [3600 + 5, "1h"],
    [1800, "&lt;1h"],
  ])("shows the time since bonding (%i s ago) as %s", async (secs, shown) => {
    const bondedAt = Math.floor(Date.now() / 1000) - secs
    await insertEvents(sql, [bond({ token: A, blockTimestamp: bondedAt, blockNumber: "1002" })])
    await h.text(`/t ${A}`)
    expect(lines(h.last("sendPhoto")!.caption)[3]).toBe(
      `<code>bonded   ${shown} ago at $213K</code>`,
    )
  })

  it("keeps the age row in days and hours for a bonded token", async () => {
    const m = await bondedCard()
    expect(lines(m.caption)[6]).toMatch(/^<code>age {6}\d+d \d+h<\/code>$/)
  })

  it("refreshes a bonded card keeping its two-row keyboard", async () => {
    await insertEvents(sql, [bond({ token: A, blockNumber: "1002" })])
    await h.tap(`tr:${A}`, { photo: true })
    const m = h.last("editMessageCaption")!
    expect(m.caption).toMatch(/<code>bonded {3}\d+d ago at \$213K<\/code>/)
    expect(kbOf(m).map((r) => r.map((b) => b.text))).toEqual([
      ["Trade", "Watch"],
      ["Refresh", "Explorer"],
    ])
  })

  it("gives a bonded token the same buttons as a curve token, with no Chart", async () => {
    const m = await bondedCard()
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
  })

  it("keeps a curve token's two-row keyboard", async () => {
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
      [{ text: "$GOBLO", callback_data: `t:${A}:hot` }],
      [{ text: "Back", callback_data: "tk" }],
    ])
  })

  it("a token card opened from a list arrives as a new message without Back, also after Refresh", async () => {
    await h.tap(`t:${A}:near`)
    const kb = kbOf(h.last("sendPhoto") ?? h.last("sendMessage"))
    expect(kb.flat().some((b) => b.text === "Back")).toBe(false)
    expect(kb[1]![0]).toEqual({ text: "Refresh", callback_data: `tr:${A}` })
    h.clear()
    // An older Refresh button that carries the list still works.
    await h.tap(`tr:${A}:near`, { photo: true })
    expect(
      kbOf(h.last("editMessageCaption"))
        .flat()
        .some((b) => b.text === "Back"),
    ).toBe(false)
  })

  it("sends the card from a list without waiting for Telegram to answer the tap", async () => {
    let release!: (v: boolean) => void
    h.on("answerCallbackQuery", () => new Promise((r) => (release = r)))
    await Promise.race([h.tap(`t:${A}:hot`), new Promise((r) => setTimeout(r, 1000))])
    expect(h.last("sendPhoto") ?? h.last("sendMessage")).toBeDefined()
    release(true)
  })

  it("skips tokens without a name and a ticker", async () => {
    const [B, C] = [addr(0xb1), addr(0xc2)]
    await insertEvents(sql, [
      trade({ token: B, blockNumber: "1002" }),
      launch({ token: C, ticker: "", name: "Cee", blockNumber: "1003" }),
      trade({ token: C, blockNumber: "1004" }),
    ])
    await setCursorBlock(sql, 1004)
    await h.tap("l:hot")
    const m = h.last("editMessageText")!
    expect(m.text).toBe("<b>Hot now (24h)</b>\n\n1. $GOBLO · Goblo · 1 trade (24h)")
    expect(kbOf(m).map((r) => r[0]!.text)).toEqual(["$GOBLO", "Back"])
    await sql`delete from indexer.events where entity = ${A}`
    await h.tap("l:hot")
    expect(h.last("editMessageText")!.text).toBe(`<b>Hot now</b>\n\n${EMPTY.hot}`)
  })

  it("leaves custom-hook tokens out of every list", async () => {
    const t = SYNTHETIC_CUSTOM.token
    await insertEvents(sql, [
      SYNTHETIC_CUSTOM,
      trade({ token: t, blockNumber: "1002" }),
      trade({ token: t, blockNumber: "1003" }),
    ])
    await setCursorBlock(sql, 1003)
    await h.tap("l:hot")
    const m = h.last("editMessageText")!
    expect(m.text).toBe("<b>Hot now (24h)</b>\n\n1. $GOBLO · Goblo · 1 trade (24h)")
    expect(kbOf(m).map((r) => r[0]!.text)).toEqual(["$GOBLO", "Back"])
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
    expect(m.text).toBe(`<b>Hot now</b>\n\n${EMPTY.hot}`)
    expect(kbOf(m)).toEqual([[{ text: "Back", callback_data: "tk" }]])
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
    expect(m.text).toBe("<b>Near bonding</b>\n\n1. $GOBLO · Goblo · 80%\n2. $BEE · Bee · 30%")
    expect(kbOf(m).map((r) => r[0]!.text)).toEqual(["$GOBLO", "$BEE", "Back"])
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
    expect(h.last("editMessageText")!.text).toBe(`<b>Recently bonded</b>\n\n${EMPTY.bonded}`)
  })

  it("lists bonds of the last 7 days, and says so when there are none", async () => {
    await insertEvents(sql, [bond({ token: A, blockNumber: "1002" })])
    await setCursorBlock(sql, 1002 + 600_000)
    await h.tap("l:bonded")
    expect(h.last("editMessageText")!.text).toContain("1. $GOBLO · Goblo · bonded ")
    await setCursorBlock(sql, 1002 + 700_000)
    await h.tap("l:bonded")
    expect(h.last("editMessageText")!.text).toBe(
      "<b>Recently bonded</b>\n\nNo tokens have bonded in the last 7 days.",
    )
  })

  it.each([["hot"], ["near"], ["bonded"]] as const)("shows an empty state for %s", async (kind) => {
    await sql`delete from indexer.events`
    await h.tap(`l:${kind}`)
    const m = h.last("editMessageText")!
    expect(m.text).toContain(EMPTY[kind])
    expect(kbOf(m)).toEqual([[{ text: "Back", callback_data: "tk" }]])
  })
})

describe("bonded live market cap", () => {
  const bonded = () => insertEvents(sql, [bond({ token: A, blockNumber: "1002", poolId: POOL })])

  it("shows the bond age and the live mcap when the pool read succeeds", async () => {
    readSqrtPrice.mockResolvedValue(KRAK_SQRT)
    await bonded()
    await h.text(`/t ${A}`)
    const c = h.last("sendPhoto")!.caption
    expect(c).toMatch(/<code>bonded {3}\d+d ago<\/code>/)
    expect(c).toContain("<code>mcap     $13.3K</code>")
    expect(c).not.toContain(" at $")
    expect(readSqrtPrice).toHaveBeenCalledWith(UNISWAP_V4_POOL_MANAGER, POOL)
  })

  it("falls back to the bonded-at row when the read fails, and logs a warn without the RPC URL", async () => {
    readSqrtPrice.mockRejectedValueOnce(new Error("timeout"))
    await bonded()
    await h.text(`/t ${A}`)
    const c = h.last("sendPhoto")!.caption
    expect(c).toMatch(/<code>bonded {3}\d+d ago at \$213K<\/code>/)
    expect(c).not.toContain("<code>mcap ")
    expect(log).toHaveBeenCalledWith("warn", "pool price read failed", {
      token: A,
      reason: "timeout",
    })
  })

  it("makes no read for a malformed or missing poolId", async () => {
    await insertEvents(sql, [bond({ token: A, blockNumber: "1002", poolId: "0x1234" as never })])
    await h.text(`/t ${A}`)
    expect(readSqrtPrice).not.toHaveBeenCalled()
    expect(h.last("sendPhoto")!.caption).toMatch(/bonded {3}\d+d ago at \$213K/)
  })

  it("falls back for an uninitialized pool (sqrtPrice 0)", async () => {
    readSqrtPrice.mockResolvedValueOnce(0n)
    await bonded()
    await h.text(`/t ${A}`)
    expect(h.last("sendPhoto")!.caption).toMatch(/bonded {3}\d+d ago at \$213K/)
  })

  it("shows the quote amount when there is no USD price", async () => {
    readSqrtPrice.mockResolvedValue(KRAK_SQRT)
    const noUsd = harness(
      createBot({
        token: "1:test",
        botInfo: BOT_INFO,
        sql,
        prices: { usd: () => null, symbol: () => "ETH" },
        log,
        report,
        linksBase: "https://go.makobot.xyz",
        images: img.images,
        readSqrtPrice,
      }),
    )
    await bonded()
    await noUsd.text(`/t ${A}`)
    expect(noUsd.last("sendPhoto")!.caption).toContain("<code>mcap     5.33 ETH</code>")
  })

  it("bonded /t market cap uses the latest swap's supply", async () => {
    readSqrtPrice.mockResolvedValue(KRAK_SQRT)
    await bonded()
    await insertEvents(sql, [
      swap({ token: A, poolId: POOL, blockNumber: "1003", supply: String(5n * 10n ** 26n) }),
    ])
    await h.text(`/t ${A}`)
    expect(h.last("sendPhoto")!.caption).toContain("<code>mcap     $6.7K</code>")
  })

  it("a bonded token with no swap yet uses the launch supply", async () => {
    readSqrtPrice.mockResolvedValue(KRAK_SQRT)
    await bonded()
    await h.text(`/t ${A}`)
    expect(h.last("sendPhoto")!.caption).toContain("<code>mcap     $13.3K</code>")
  })

  it("never reads the pool for a curve token", async () => {
    await h.text(`/t ${A}`)
    expect(readSqrtPrice).not.toHaveBeenCalled()
  })
})

describe("Tsunami pools", () => {
  const CALAMARI = "0x6e4723a612831afb9f5b2a5ae22723c37aab9560"
  const t = loadTsunami()
  const botWith = (p: Prices) =>
    harness(
      createBot({
        token: "1:test",
        botInfo: BOT_INFO,
        sql,
        prices: p,
        log,
        report,
        linksBase: "https://go.makobot.xyz",
        images: img.images,
        readSqrtPrice,
      }),
    )
  const card = (b: ReturnType<typeof harness>) =>
    (b.last("sendPhoto")?.caption ?? b.last("sendMessage")?.text) as string
  const graduate = (g: typeof t.gm | typeof t.usdc) =>
    insertEvents(sql, [g.launch, g.closingBuy, g.bond, g.swap])

  it("a Tsunami token's /t market cap calls Calamari's StateView", async () => {
    readSqrtPrice.mockResolvedValue(BigInt(t.gm.slot0SqrtPriceX96))
    await graduate(t.gm)
    await h.text(`/t ${t.gm.launch.token}`)
    expect(readSqrtPrice).toHaveBeenCalledWith(CALAMARI, t.gm.bond.poolId)
    // 697.998 ETH at $2,500.
    expect(card(h)).toContain("<code>mcap     $1.7M</code>")
  })

  it("an unknown pool manager gives no live market cap and no call", async () => {
    await insertEvents(sql, [
      t.gm.launch,
      t.gm.closingBuy,
      { ...t.gm.bond, poolManager: addr(0x99) },
    ])
    await h.text(`/t ${t.gm.launch.token}`)
    expect(readSqrtPrice).not.toHaveBeenCalled()
    expect(card(h)).toMatch(/bonded {3}\d+d ago at /)
    expect(card(h)).not.toContain("<code>mcap ")
  })

  it("/t reads the pool of the latest swap after a pool move", async () => {
    readSqrtPrice.mockResolvedValue(BigInt(t.moved.slot0SqrtPriceX96))
    await graduate(t.moved)
    await h.text(`/t ${t.moved.launch.token}`)
    expect(t.moved.bond.poolId).toBe(t.moved.sourcePoolId)
    expect(readSqrtPrice).toHaveBeenCalledWith(CALAMARI, t.moved.destinationPoolId)
    expect(readSqrtPrice).not.toHaveBeenCalledWith(CALAMARI, t.moved.sourcePoolId)
    // 5.932 ETH at $2,500.
    expect(card(h)).toContain("<code>mcap     $14.8K</code>")
  })

  it("the USDC graduate's /t market cap is in USDC", async () => {
    readSqrtPrice.mockResolvedValue(BigInt(t.usdc.slot0SqrtPriceX96))
    await graduate(t.usdc)
    const noUsd = botWith({ usd: () => null, symbol: () => "USDC" })
    await noUsd.text(`/t ${t.usdc.launch.token}`)
    expect(card(noUsd)).toContain("<code>mcap     2.49 USDC</code>")
  })
})

describe("refreshCooldown", () => {
  it("allows the first tap, then counts down per key, then allows again", () => {
    let t = 1_000_000
    const tap = refreshCooldown(15_000, () => t)
    expect(tap("100:0xa")).toBe(0)
    t += 1_000
    expect(tap("100:0xa")).toBe(14)
    t += 13_200 // 14.2 s after the first tap
    expect(tap("100:0xa")).toBe(1)
    t += 800 // exactly 15 s
    expect(tap("100:0xa")).toBe(0)
  })

  it("keeps users and tokens apart", () => {
    const t = 1_000_000
    const tap = refreshCooldown(15_000, () => t)
    expect(tap("100:0xa")).toBe(0)
    expect(tap("200:0xa")).toBe(0)
    expect(tap("100:0xb")).toBe(0)
    expect(tap("100:0xa")).toBe(15)
  })

  it("is 15 s on the bot", () => {
    expect(REFRESH_COOLDOWN_MS).toBe(15_000)
  })
})

describe("Refresh cooldown on the bot", () => {
  afterEach(() => vi.restoreAllMocks())
  const edits = () => h.calls.filter((c) => c.method === "editMessageCaption").length

  it("answers a second tap within 15 s with a pop-up and makes no edit or read", async () => {
    readSqrtPrice.mockResolvedValue(KRAK_SQRT)
    await insertEvents(sql, [bond({ token: A, blockNumber: "1002", poolId: POOL })])
    const T = 2_000_000_000_000
    const now = vi.spyOn(Date, "now").mockReturnValue(T)
    await h.tap(`tr:${A}`, { photo: true })
    expect(edits()).toBe(1)
    const reads = readSqrtPrice.mock.calls.length
    now.mockReturnValue(T + 4_000)
    await h.tap(`tr:${A}`, { photo: true })
    expect(edits()).toBe(1)
    expect(h.last("answerCallbackQuery")!.text).toBe("Up to date, try again in 11s")
    expect(readSqrtPrice.mock.calls.length).toBe(reads)
    now.mockReturnValue(T + 15_000)
    await h.tap(`tr:${A}`, { photo: true })
    expect(edits()).toBe(2)
  })

  it("lets another user refresh the same card at once", async () => {
    await h.tap(`tr:${A}`, { photo: true, from: 100 })
    await h.tap(`tr:${A}`, { photo: true, from: 200 })
    expect(edits()).toBe(2)
  })
})

describe("Hookit token card", () => {
  const eth = (n: number) => String(BigInt(Math.round(n * 1000)) * 10n ** 15n)
  const swapOf = (o: Parameters<typeof swap>[0]) =>
    swap({
      launchpad: "hookit",
      token: HKT.token,
      launchId: HKT.launchId,
      poolId: HKT.poolId as `0x${string}`,
      marketCap: eth(100),
      quoteLiquidity: eth(8),
      ...o,
    })
  const lines = (caption: string) => caption.split("\n")

  it("/t for $HKT shows age and no curve row", async () => {
    await insertEvents(sql, [
      HKT,
      swapOf({ quoteAmount: eth(0.1), blockNumber: "56519930" }),
      swapOf({ side: "sell", quoteAmount: eth(0.2), blockNumber: "56519931" }),
      swapOf({ trader: HKT.creator, quoteAmount: eth(0.05), blockNumber: "56519932" }),
    ])
    await setCursorBlock(sql, 56519940)
    await h.text(`/t ${HKT.token}`)
    const m = h.last("sendPhoto") ?? h.last("sendMessage")!
    const text = (m.caption ?? m.text) as string
    expect(lines(text).slice(0, 3)).toEqual(["<b>$HKT</b>", "HOOKIT · Hookit", ""])
    expect(lines(text).slice(3, 7)).toEqual([
      "<code>mcap      $250K</code>",
      "<code>liquidity $40.0K</code>",
      "<code>volume    $875 (24h)</code>",
      "<code>trades    2 buys | 1 sell (24h)</code>",
    ])
    expect(lines(text)[7]).toMatch(/^<code>age {7}\d+d \d+h<\/code>$/)
    expect(lines(text).slice(8)).toEqual([
      "<code>dev       1 buy | 0 sells</code>",
      "<code>hooks     Anti-Snipe, Anti-MEV +3</code>",
      "",
      "Hold one, get all",
      "",
      `CA   <code>${HKT.token}</code>`,
    ])
    expect(text).not.toContain("<code>curve")
    expect(text).not.toContain("<code>bonded")
  })

  it("/t reads a multi-pair token's figures in the quote of its deepest pool", async () => {
    // INKY's market 0 is USDG (6 decimals); the latest swap is in its wMSTRx pool (18 decimals).
    const wmstrx = "0x30987adf0b11dc698438a99ba04ec3a1ab2c7eab"
    await insertEvents(sql, [
      INKY,
      swap({
        launchpad: "hookit",
        token: INKY.token,
        launchId: INKY.launchId,
        quoteAsset: wmstrx,
        poolId: POOL,
        marketCap: eth(50),
        quoteLiquidity: eth(8),
        quoteAmount: eth(0.1),
        blockNumber: "56801130",
      }),
    ])
    await setCursorBlock(sql, 56801140)
    // A price giving about 100 wMSTRx of market cap, with the token as currency1.
    readSqrtPrice.mockResolvedValue((3_162_277_660n * 2n ** 96n) / 1_000_000n)
    await h.text(`/t ${INKY.token}`)
    const m = h.last("sendPhoto") ?? h.last("sendMessage")!
    const l = lines((m.caption ?? m.text) as string)
    expect(l.slice(3, 7)).toEqual([
      "<code>mcap      $250K</code>",
      "<code>liquidity $40.0K</code>",
      "<code>volume    $250 (24h)</code>",
      "<code>trades    1 buy | 0 sells (24h)</code>",
    ])
  })

  const rowsOf = async (token: string) => {
    await h.text(`/t ${token}`)
    const m = h.last("sendPhoto") ?? h.last("sendMessage")!
    return lines((m.caption ?? m.text) as string).slice(3, 7)
  }
  const stockUsd: Record<string, number> = { [WNVDAX]: 206.98, [WMSTRX]: 133.94, [USDG]: 1 }

  it("HMU's market cap comes from its deepest priced pool", async () => {
    // The latest swap is in the wAMZNx pool, which has no USD price.
    usdOf = (q) => stockUsd[q] ?? null
    await insertEvents(sql, [HMU, HMU_SPLIT_WNVDAX, HMU_SPLIT_WAMZNX])
    await setCursorBlock(sql, 56521440)
    expect(await rowsOf(HMU.token)).toEqual([
      // 28.49 wNVDAx at $206.98.
      "<code>mcap      $5.9K</code>",
      "<code>liquidity $1.2K</code>",
      // The wAMZNx leg is left out of the dollar total.
      "<code>volume    $124 (24h)</code>",
      "<code>trades    2 buys | 0 sells (24h)</code>",
    ])
  })

  it("/t reads the deepest pool's StateView slot", async () => {
    usdOf = (q) => stockUsd[q] ?? null
    await insertEvents(sql, [HMU, HMU_SPLIT_WNVDAX, HMU_SPLIT_WAMZNX])
    await setCursorBlock(sql, 56521440)
    readSqrtPrice.mockResolvedValue(2n ** 96n)
    await h.text(`/t ${HMU.token}`)
    expect(readSqrtPrice).toHaveBeenCalledWith(UNISWAP_V4_POOL_MANAGER, HMU_SPLIT_WNVDAX.poolId)
  })

  it("an unpriced pool never takes a priced pool's place, even an empty one (synthetic)", async () => {
    usdOf = (q) => stockUsd[q] ?? null
    // The wNVDAx pool holds nothing at its latest swap; the newer wAMZNx pool has no price.
    const empty = { ...HMU_SPLIT_WNVDAX, quoteLiquidity: "0", tokenLiquidity: undefined }
    await insertEvents(sql, [HMU, empty, HMU_SPLIT_WAMZNX])
    await setCursorBlock(sql, 56521440)
    expect((await rowsOf(HMU.token)).slice(0, 2)).toEqual([
      "<code>mcap      $5.9K</code>",
      "<code>liquidity $0</code>",
    ])
  })

  it("INKY's liquidity row adds the token side", async () => {
    usdOf = (q) => stockUsd[q] ?? null
    await insertEvents(sql, [INKY, INKY_WMSTRX_BUY, INKY_USDG_SELL])
    await setCursorBlock(sql, 60124780)
    expect(await rowsOf(INKY.token)).toEqual([
      "<code>mcap      $5.0K</code>",
      // 1.38 USDG of quote and $2,515 of tokens, where twice the quote side would read $3.
      "<code>liquidity $2.5K</code>",
      // The USDG sell ($3) and the wMSTRx buy (0.0219 wMSTRx at $133.94) in one dollar total.
      "<code>volume    $6 (24h)</code>",
      "<code>trades    1 buy | 1 sell (24h)</code>",
    ])
  })

  it("/t for a token that starts in a pool has no curve row before its first swap", async () => {
    await insertEvents(sql, [HKT])
    await h.text(`/t ${HKT.token}`)
    const m = h.last("sendPhoto") ?? h.last("sendMessage")!
    const text = (m.caption ?? m.text) as string
    expect(text).not.toContain("<code>curve")
    expect(text).toContain("<code>hooks    Anti-Snipe, Anti-MEV +3</code>")
  })

  it("a Classic token's /t ends its rows with hooks Classic", async () => {
    await insertEvents(sql, [HOOC, HOOC_FIRST_BUY])
    await setCursorBlock(sql, 56519400)
    await h.text(`/t ${HOOC.token}`)
    const m = h.last("sendPhoto") ?? h.last("sendMessage")!
    const l = lines((m.caption ?? m.text) as string)
    const i = l.indexOf("<code>hooks    Classic</code>")
    expect(i).toBeGreaterThan(0)
    expect(l[i - 1]).toMatch(/^<code>dev /)
    expect(l[i + 1]).toBe("")
    expect(l.some((x) => x.startsWith("<code>curve"))).toBe(true)
  })
})

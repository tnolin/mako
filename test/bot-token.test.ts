import { InputFile } from "grammy"
import { afterAll, afterEach, beforeEach, describe, expect, inject, it, vi } from "vitest"
import type { Sql } from "../src/db"
import { escapeHtml } from "../src/format"
import { NOT_FOUND } from "../src/menus/copy"
import { EMPTY } from "../src/menus/lists"
import { REFRESH_COOLDOWN_MS, refreshCooldown } from "../src/menus/token"
import { createBot } from "../src/platforms/telegram/bot"
import type { Prices } from "../src/prices"
import { insertEvents, resetDb, setCursorBlock } from "./helpers/db"
import { addr, bond, ETH, launch, swap, trade } from "./helpers/events"
import { imageResponse, testImages } from "./helpers/images"
import { BOT_INFO, harness, type Payload } from "./helpers/tg"

const prices: Prices = { usd: () => 2500, symbol: () => "ETH" }
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
let readSqrtPrice: ReturnType<typeof vi.fn<(poolId: string) => Promise<bigint>>>

beforeEach(async () => {
  img = testImages()
  await sql?.end()
  sql = await resetDb(inject("databaseUrl"))
  report.mockClear()
  log.mockReset()
  readSqrtPrice = vi.fn(async (_poolId: string): Promise<bigint> => {
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
    expect(readSqrtPrice).toHaveBeenCalledWith(POOL)
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

import { afterAll, beforeEach, describe, expect, inject, it, vi } from "vitest"
import type { Sql } from "../src/db"
import { ABOUT, GROUP_COMMANDS, PRIVATE_COMMANDS, SHORT_ABOUT } from "../src/menus/main"
import { createBot } from "../src/platforms/telegram/bot"
import type { Prices } from "../src/prices"
import { addUser } from "./helpers/bot"
import { resetDb } from "./helpers/db"
import { testImages } from "./helpers/images"
import { BOT_INFO, harness, type Payload } from "./helpers/tg"

const prices: Prices = { usd: () => 2500, symbol: () => "ETH" }
const G = { id: -1001, type: "supergroup" as const, title: "Alpha" }
const log = vi.fn()
let sql: Sql
let h: ReturnType<typeof harness>

beforeEach(async () => {
  await sql?.end()
  sql = await resetDb(inject("databaseUrl"))
  log.mockClear()
  h = harness(
    createBot({
      token: "1:t",
      botInfo: BOT_INFO,
      sql,
      prices,
      log,
      report: vi.fn(),
      linksBase: "https://go.makobot.xyz",
      images: testImages().images,
    }),
  )
})
afterAll(() => sql.end())

type Btn = { text: string; callback_data?: string; url?: string; style?: string }
const rows = (p: Payload | undefined): Btn[][] => p?.reply_markup?.inline_keyboard ?? []
const labels = (p: Payload | undefined) => rows(p).map((r) => r.map((b) => b.text))

const MENU = [
  "Hey Sam!",
  "MAKO sends real-time alerts for tokens and NFTs on Ink, to your DMs, groups and channels.",
  "",
  "Tokens: new launches, bonding, pumps, dev sells and big trades.",
  "NFTs: upcoming mints, mint progress, sell-outs, under-floor and rare listings, and big sales.",
  "",
  "Paste any token or collection address, or an OpenSea link, to look it up.",
].join("\n")

describe("main menu", () => {
  it("/start and /menu render the same screen", async () => {
    await addUser(sql, 100)
    await h.text("/start", { name: "Sam" })
    const start = h.last("sendMessage")!
    await h.text("/menu", { name: "Sam" })
    const menu = h.last("sendMessage")!
    expect(start.text).toBe(MENU)
    expect(menu.text).toBe(MENU)
    expect(menu.reply_markup).toEqual(start.reply_markup)
    await h.tap("m", { name: "Sam" })
    expect(h.last("editMessageText")!.text).toBe(MENU)
  })

  it("has the expected buttons, with links that open out", async () => {
    await addUser(sql, 100)
    await h.text("/menu")
    const p = h.last("sendMessage")!
    expect(labels(p)).toEqual([
      ["Add to group or channel"],
      ["Tokens", "NFTs"],
      ["My alerts", "Settings"],
      ["Help", "Community"],
    ])
    const kb = rows(p)
    expect(kb[0]![0]!.url).toBe(
      "https://t.me/makoinkbot?startgroup=setup&admin=post_messages+manage_topics",
    )
    expect(kb[1]!.map((b) => b.callback_data)).toEqual(["tk", "nfts"])
    expect(kb[2]!.map((b) => b.callback_data)).toEqual(["al:u", "st"])
    expect(kb[3]![0]!.callback_data).toBe("h")
    expect(kb[3]![1]!.url).toBe("https://t.me/MakoOnInk")
    expect(kb.flat().some((b) => b.url?.includes("x.com"))).toBe(false)
    // Telegram marks link buttons itself, so no label carries an arrow.
    expect(kb.flat().some((b) => b.text.includes("↗"))).toBe(false)
  })

  it("escapes and cuts the first name, and never stores or logs it", async () => {
    const name = `<b>Sam</b> & ${"x".repeat(60)}‮`
    await h.text("/start", { name })
    await h.text("/start", { name })
    const text = h.last("sendMessage")!.text as string
    expect(text.startsWith("Hey &lt;b&gt;Sam&lt;/b&gt; &amp; xxx")).toBe(true)
    expect(text.split("\n")[0]!.endsWith("…!")).toBe(true)
    expect(text).not.toContain("‮")
    const tables = await sql<{ t: string }[]>`
      select table_name as t from information_schema.tables where table_schema = 'bot'`
    const dump: unknown[] = []
    for (const { t } of tables) {
      dump.push(await sql.unsafe(`select row_to_json(x)::text as r from bot."${t}" x`))
    }
    expect(JSON.stringify(dump)).not.toContain("Sam")
    expect(JSON.stringify(log.mock.calls)).not.toContain("Sam")
  })

  it("greets a user without a first name with Hey there!", async () => {
    await addUser(sql, 100)
    await h.text("/menu", { name: "" })
    expect(h.last("sendMessage")!.text).toMatch(/^Hey there!\n/)
  })

  it("has no launchpad button and ABOUT has no launchpad link", async () => {
    await addUser(sql, 100)
    await h.text("/menu")
    const flat = rows(h.last("sendMessage")).flat()
    expect(flat.some((b) => /inkypump|trade/i.test(`${b.text} ${b.url ?? ""}`))).toBe(false)
    expect(ABOUT).not.toMatch(/inkypump|trade|https?:/i)
  })
})

describe("bot descriptions", () => {
  it("match the exact text and fit Telegram's limits", () => {
    expect(SHORT_ABOUT).toBe(
      "The only bot for real-time alerts of memecoins and NFTs on Ink. Open source. Join the community: @MakoOnInk",
    )
    expect(ABOUT).toBe(
      [
        "I send real-time alerts for memecoins and NFTs on Ink: new launches, bonding, mints, rare listings and whale buys.",
        "",
        "Customize your alerts for the NFTs and tokens you care about with support for groups and channels.",
        "",
        "Open-source project. Join the community: @MakoOnInk",
      ].join("\n"),
    )
    expect([...SHORT_ABOUT].length).toBeLessThanOrEqual(120)
    expect([...ABOUT].length).toBeLessThanOrEqual(512)
  })
})

describe("command menus", () => {
  it("match the exact text", () => {
    const watch = "Watch a token or NFT: /watch <address or name>"
    expect(PRIVATE_COMMANDS).toEqual([
      { command: "start", description: "Start MAKO" },
      { command: "menu", description: "Main menu" },
      { command: "t", description: "Look up a token: /t <address>" },
      { command: "nft", description: "Look up an NFT collection: /nft <name or address>" },
      { command: "watch", description: watch },
      { command: "alerts", description: "My alerts" },
      { command: "help", description: "Help" },
      { command: "deletedata", description: "Delete my data" },
    ])
    expect(GROUP_COMMANDS).toEqual([
      { command: "t", description: "Look up a token: /t <address>" },
      { command: "watch", description: watch },
      { command: "setup", description: "Post MAKO alerts in this topic" },
      { command: "route", description: "Send chosen alerts to this topic" },
      { command: "help", description: "Help" },
    ])
  })
})

describe("onboarding", () => {
  it("gives a new user the menu, then the picker with state buttons and no check marks", async () => {
    await h.text("/start", { name: "Sam" })
    const sent = h.calls.filter((c) => c.method === "sendMessage").map((c) => c.payload)
    expect(sent).toHaveLength(2)
    expect(sent[0]!.text).toBe(MENU)
    const picker = sent[1]!
    expect(picker.text).toContain("Tap an alert to turn it on or off.")
    expect(labels(picker).flat()).toEqual([
      "NEW TOKEN",
      "BONDING",
      "PUMPING",
      "BONDED",
      "DEV SELL",
      "BIG BUY/SELL",
      "Turn all off",
      "Done → menu",
    ])
    const toggles = rows(picker).flat().slice(0, 6)
    expect(toggles.every((b) => b.style === "success")).toBe(true)
    await h.tap("ob:new")
    const off = rows(h.last("editMessageText")).flat()[0]!
    expect(off).toEqual({ text: "NEW TOKEN", callback_data: "ob:new" })
  })
})

describe("Tokens and NFTs screens", () => {
  it("Tokens screen text is exact and links the launchpad through the redirect", async () => {
    await h.tap("tk")
    const p = h.last("editMessageText")!
    expect(p.text).toBe(
      [
        "<b>Tokens</b>",
        "Alerts and lists for tokens launched on Ink.",
        'Supported: <a href="https://go.makobot.xyz/inkypump">InkyPump</a>',
        "",
        "/t &lt;address&gt; look up a token",
        "/watch &lt;address&gt; watch a token",
      ].join("\n"),
    )
    expect(labels(p)).toEqual([
      ["Hot now", "Near bonding"],
      ["Recently bonded", "Menu"],
    ])
    expect(
      rows(p)
        .flat()
        .map((b) => b.callback_data),
    ).toEqual(["l:hot", "l:near", "l:bonded", "m"])
  })

  it("NFTs screen text is exact and links OpenSea and Chimera", async () => {
    await h.tap("nfts")
    const p = h.last("editMessageText")!
    expect(p.text).toBe(
      [
        "<b>NFTs</b>",
        "Alerts and lists for NFT collections on Ink.",
        'Supported: <a href="https://go.makobot.xyz/p/opensea">OpenSea</a>, <a href="https://go.makobot.xyz/p/chimera">Chimera</a>',
        "",
        "/nft &lt;collection&gt; [1h|24h|7d|30d]",
        "/nft &lt;collection&gt; &lt;id&gt; look up one NFT",
      ].join("\n"),
    )
    expect(labels(p)).toEqual([
      ["Minting now", "Upcoming"],
      ["Trending", "Menu"],
    ])
    expect(
      rows(p)
        .flat()
        .map((b) => b.callback_data),
    ).toEqual(["nl:m", "nl:u", "nl:t24", "m"])
  })

  it("leaves Menu out of both screens in a group", async () => {
    await h.tap("tk", { chat: G })
    expect(labels(h.last("editMessageText")).flat()).not.toContain("Menu")
    await h.tap("nfts", { chat: G })
    expect(labels(h.last("editMessageText")).flat()).not.toContain("Menu")
  })

  it("the Back buttons of the lists lead back to these screens", async () => {
    for (const [list, screenData, title] of [
      ["l:hot", "tk", "<b>Tokens</b>"],
      ["l:near", "tk", "<b>Tokens</b>"],
      ["l:bonded", "tk", "<b>Tokens</b>"],
      ["nl:m", "nfts", "<b>NFTs</b>"],
      ["nl:u", "nfts", "<b>NFTs</b>"],
      ["nl:t24", "nfts", "<b>NFTs</b>"],
    ] as const) {
      await h.tap(list)
      const back = rows(h.last("editMessageText"))
        .flat()
        .find((b) => b.text === "Back")!
      expect(back.callback_data).toBe(screenData)
      await h.tap(back.callback_data!)
      expect(h.last("editMessageText")!.text.split("\n")[0]).toBe(title)
    }
  })

  it("has no Look up button or prompt", async () => {
    await addUser(sql, 100)
    await h.text("/menu")
    expect(labels(h.last("sendMessage")).flat().join()).not.toMatch(/look up/i)
    h.clear()
    await h.tap("look")
    expect(h.calls.filter((c) => c.method === "sendMessage")).toHaveLength(0)
  })
})

const DEFAULTS = {
  token: [
    "NEW TOKEN - newly detected tokens created.",
    "BONDING - When a token passes your set threshold.",
    "PUMPING - When a token's curve jumps 15%+ in 10 min.",
    "BONDED - A token that has bonded/graduated.",
    "DEV SELL - When the creator sells any amount of their own token.",
    "BIG BUY/SELL - one trade worth 5%+ of the token's bond target.",
  ],
  all: [
    "UPCOMING MINT - When a new mint is scheduled.",
    "MINT STARTING - A mint stage has opened (other than Team's).",
    "MINT LIVE - A mint without any mint stages goes live.",
    "MINTED - When a collection's total mints has passed your designated threshold (eg. 50% = 50/100 mints).",
    "SOLD OUT - When a collection completely mints out.",
    "NEW COLLECTION - A new Chimera collection is detected.",
    "BIG SALE - When an NFT sells for 0.1 ETH or more.",
  ],
  watched: [
    "UNDER FLOOR - an item lists 20%+ under floor.",
    "RARE LISTING - a top 10% item lists near floor.",
    "FLOOR MOVE - the floor moves 20%+ in 24h.",
    "SWEEP - one wallet buys 5+ items in 10 min.",
    "SOLD - an item sells for 0.05 ETH or more.",
    "REMINDERS - a message 15 min before each mint stage.",
  ],
}

describe("Help", () => {
  it("shows the intro with four pages, and Menu only in a DM", async () => {
    await h.tap("h")
    const p = h.last("editMessageText")!
    expect(p.text).toBe(
      "<b>Help</b>\nMAKO posts alerts for Ink tokens and NFTs in your DM, your groups and your channels.",
    )
    expect(labels(p)).toEqual([
      ["Alerts explained", "Group setup"],
      ["Watched & Muted", "Privacy"],
      ["Community", "Menu"],
    ])
    expect(
      rows(p)
        .flat()
        .map((b) => b.callback_data),
    ).toEqual(["h:alerts", "h:group", "h:watched", "h:privacy", undefined, "m"])
    await h.tap("h", { chat: G })
    expect(labels(h.last("editMessageText"))[2]).toEqual(["Community"])
  })

  it("Alerts explained uses the alert-screen lines at the default thresholds", async () => {
    await h.tap("h:alerts")
    const p = h.last("editMessageText")!
    expect(p.text).toBe(
      [
        "<b>Alerts explained</b>",
        "<b>Token alerts</b>",
        ...DEFAULTS.token,
        "Percentages in token alerts are a share of the token's total supply.",
        "<b>NFT alerts</b>",
        ...DEFAULTS.all,
        "<b>Watched NFTs only</b>",
        ...DEFAULTS.watched,
      ].join("\n"),
    )
    expect(labels(p)).toEqual([["Help", "Menu"]])
  })

  it("Watched & Muted, Group setup and Privacy match the exact text", async () => {
    await h.tap("h:watched")
    expect(h.last("editMessageText")!.text).toBe(
      [
        "<b>Watched &amp; Muted</b>",
        "<b>Watching</b>: I'll send you every alert type for tokens or NFTs that you add to your watchlist, even for the alerts turned off. This also includes mint reminders 15 minutes before each mint stage.",
        "",
        "<b>Muted</b>: I won't send you any alerts on tokens or NFTs that you mute. If it is on your watchlist, it is removed automatically.",
        "",
        "<b>Remind me</b>: These alerts are only for an NFT's upcoming mint stages. Select 'Remind me' if you want to get notifications 15 min before each mint stage without adding the collection to your Watchlist.",
      ].join("\n"),
    )
    await h.tap("h:group")
    expect(h.last("editMessageText")!.text).toBe(
      [
        "<b>Group setup</b>",
        "1. Tap Add to group or channel in the menu, and make MAKO an admin so it can post in topics.",
        "2. In the topic where alerts should go, send /setup. Every alert posts there by default.",
        "3. Want different alerts in different topics? Send /route in another topic and pick which alerts go there.",
        "4. Tap Open settings to choose alerts, thresholds and images. NFT alerts are off in groups until an admin turns them on.",
        "",
        "<b>Tips</b>",
        "• Give each alert type its own topic, like New tokens, Bonding and Mints, so chat doesn't bury them.",
        "• Close alert topics so only MAKO can post there.",
        "• In busy groups, turn images off to keep alerts compact.",
        "• Use /watch for the tokens and collections your community cares about, so market alerts stay focused.",
      ].join("\n"),
    )
    await h.tap("h:privacy")
    expect(h.last("editMessageText")!.text).toBe(
      [
        "<b>Privacy</b>",
        "MAKO is an open-source project built to store as little data as possible. It does <b>not</b> store personal information like your name, username, phone number or messages. MAKO only stores your Telegram user ID, to remember your notification settings, the tokens and NFTs you watch or mute, your mint reminders, and the alerts queued for you (kept for 90 days).",
        "",
        "You can delete your data in Settings → Delete my data. Server backups are deleted after 14 days.",
      ].join("\n"),
    )
  })

  it("ends every page with [Help] [Menu], and without Menu in a group", async () => {
    for (const page of ["alerts", "group", "watched", "privacy"]) {
      await h.tap(`h:${page}`)
      expect(rows(h.last("editMessageText"))).toEqual([
        [
          { text: "Help", callback_data: "h" },
          { text: "Menu", callback_data: "m" },
        ],
      ])
      await h.tap(`h:${page}`, { chat: G })
      expect(rows(h.last("editMessageText"))).toEqual([[{ text: "Help", callback_data: "h" }]])
    }
  })
})

describe("label lengths", () => {
  // About 20 characters with 2 buttons per row, 13 with 3, 30 full width.
  const limit = (perRow: number) => (perRow >= 3 ? 13 : perRow === 2 ? 20 : 30)
  const fits = (p: Payload | undefined) => {
    for (const r of rows(p))
      for (const b of r) expect([...b.text].length, b.text).toBeLessThanOrEqual(limit(r.length))
  }

  it("every menu label fits", async () => {
    await addUser(sql, 100)
    await h.text("/menu")
    fits(h.last("sendMessage"))
    for (const data of ["tk", "nfts", "st", "h", "h:alerts", "h:group", "h:watched", "h:privacy"]) {
      await h.tap(data)
      fits(h.last("editMessageText"))
    }
    h.clear()
    await h.text("/start", { from: 200 })
    fits(h.calls.filter((c) => c.method === "sendMessage").at(-1)!.payload)
  })
})

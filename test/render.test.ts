import { describe, expect, it } from "vitest"
import type { Card } from "../src/cards/card"
import { alertKeyboard, renderCard, toKeyboard } from "../src/platforms/telegram/render"
import { ALERTS } from "../src/settings"

const CA = "0x3c19e7a4b2d0f8c61e95a3b7d4c2e0f19a8b9ab0"
const card: Card = {
  alert: "bonding",
  title: "BONDING 80%",
  ticker: "GOBLO",
  name: "Goblo",
  launchpad: "InkyPump",
  launchpadKey: "inkypump",
  rows: [
    ["curve", "■■■■■■■■□□ 80%"],
    ["mcap", "$212K"],
    ["volume", "$88.0K (1h)"],
    ["trades", "142 buys | 31 sells (1h)"],
    ["age", "2h 14m"],
    ["dev", "3 buys | 0 sells"],
  ],
  links: [],
  token: CA,
  imageUrl: "https://storage.inkypump.com/storage/v1/object/public/images/x.jpg",
}
const ctx = { linksBase: "https://go.makobot.xyz", botUsername: "makoinkbot" }

describe("renderCard", () => {
  it("matches the alert format: square header, bold ticker, one code per line, padded labels, CA only", () => {
    expect(renderCard(card)).toBe(
      [
        "<b>🟨 BONDING 80%</b>",
        "<b>$GOBLO</b>",
        "Goblo · InkyPump",
        "",
        "<code>curve    ■■■■■■■■□□ 80%</code>",
        "<code>mcap     $212K</code>",
        "<code>volume   $88.0K (1h)</code>",
        "<code>trades   142 buys | 31 sells (1h)</code>",
        "<code>age      2h 14m</code>",
        "<code>dev      3 buys | 0 sells</code>",
        "",
        `CA   <code>${CA}</code>`,
      ].join("\n"),
    )
  })

  it.each([
    ["new", "NEW TOKEN", "🟩"],
    ["bonding", "BONDING 90%", "🟨"],
    ["pumping", "PUMPING", "🟧"],
    ["bonded", "BONDED", "🟦"],
    ["devsell", "DEV SELL", "🟥"],
    ["big", "BIG BUY", "🟪"],
    ["big", "BIG SELL", "🟪"],
  ] as const)(
    "leads the %s alert %s with %s and keeps type and ticker on separate lines",
    (alert, title, square) => {
      const [type, ticker, name] = renderCard({ ...card, alert, title }).split("\n")
      expect(type).toBe(`<b>${square} ${title}</b>`)
      expect(ticker).toBe("<b>$GOBLO</b>")
      expect(name).toBe("Goblo · InkyPump")
      expect(type).not.toContain("·")
    },
  )

  it("has a square for every alert kind", () => {
    for (const alert of ALERTS)
      expect(renderCard({ ...card, alert })).toMatch(/^<b>[🟩🟨🟧🟦🟥🟪] /u)
  })

  it("widens the label column to fit `dev holds`", () => {
    const html = renderCard({
      ...card,
      rows: [
        ["sold", "12.4M (1.2%)"],
        ["dev holds", "6.8%"],
      ],
    })
    expect(html).toContain("<code>sold      12.4M (1.2%)</code>")
    expect(html).toContain("<code>dev holds 6.8%</code>")
  })

  it("escapes markup in name and ticker and keeps a quote-breakout URL inside one escaped link", () => {
    const html = renderCard({
      ...card,
      name: `<a href="https://evil">x</a> & co`,
      ticker: "<b>P</b>",
      links: [{ label: "X", url: `https://x.com/a"onmouseover="1` }],
    })
    expect(html).toContain("&lt;a href=&quot;https://evil&quot;&gt;x&lt;/a&gt; &amp; co · InkyPump")
    expect(html).toContain("<b>$&lt;b&gt;P&lt;/b&gt;</b>")
    expect(html).toContain(`<a href="https://x.com/a&quot;onmouseover=&quot;1">X</a>`)
    expect(html.match(/<a /g)).toHaveLength(1)
  })

  it("escapes markup in row values and drops javascript:, data: and malformed links", () => {
    const html = renderCard({
      ...card,
      rows: [["mcap", "<i>$1</i> & more"]],
      links: [
        { label: "X", url: "javascript:alert(1)" },
        { label: "Telegram", url: "  JavaScript:alert(1)" },
        { label: "Website", url: "data:text/html,<script>1</script>" },
        { label: "Website", url: "not a url" },
        { label: "Website", url: "https://g.io/" },
      ],
    })
    expect(html).toContain("<code>mcap     &lt;i&gt;$1&lt;/i&gt; &amp; more</code>")
    expect(html).not.toMatch(/javascript:/i)
    expect(html).not.toContain("data:")
    expect(html).not.toContain("not a url")
    expect(html.match(/<a /g)).toHaveLength(1)
    expect(html.endsWith(`<a href="https://g.io/">Website</a>`)).toBe(true)
  })

  it("omits the links line when every link is unsafe", () => {
    const html = renderCard({ ...card, links: [{ label: "X", url: "javascript:alert(1)" }] })
    expect(html.endsWith(`CA   <code>${CA}</code>`)).toBe(true)
  })

  it("adds the links line after CA", () => {
    const html = renderCard({
      ...card,
      links: [
        { label: "X", url: "https://x.com/g" },
        { label: "Website", url: "https://g.io/" },
      ],
    })
    expect(
      html.endsWith(
        `<code>${CA}</code>\n<a href="https://x.com/g">X</a> · <a href="https://g.io/">Website</a>`,
      ),
    ).toBe(true)
  })
})

describe("alertKeyboard", () => {
  it("gives groups and channels Trade (redirect) and Watch (deep link)", () => {
    expect(alertKeyboard(card, { ...ctx, chatType: "supergroup", deliveryId: "d-1" })).toEqual({
      inline_keyboard: [
        [
          { text: "Trade", url: `https://go.makobot.xyz/t/${CA}?d=d-1` },
          { text: "Watch", url: `https://t.me/makoinkbot?start=w_${CA}` },
        ],
      ],
    })
  })

  it("gives DMs Trade, Watch and Mute callbacks", () => {
    expect(
      alertKeyboard(card, { ...ctx, chatType: "private", deliveryId: "d-2" }).inline_keyboard[0],
    ).toEqual([
      { text: "Trade", url: `https://go.makobot.xyz/t/${CA}?d=d-2` },
      { text: "Watch", callback_data: `w:${CA}` },
      { text: "Mute", callback_data: `m:${CA}` },
    ])
  })
})

describe("toKeyboard", () => {
  it("maps url buttons to links and the rest to callbacks", () => {
    expect(
      toKeyboard([[{ text: "A", url: "https://a.io" }, { text: "B", data: "b:1" }, { text: "C" }]]),
    ).toEqual({
      inline_keyboard: [
        [
          { text: "A", url: "https://a.io" },
          { text: "B", callback_data: "b:1" },
          { text: "C", callback_data: "noop" },
        ],
      ],
    })
  })
})

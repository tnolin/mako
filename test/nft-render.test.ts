import type { NftCollectionEvent } from "@ink-indexer/events"
import { describe, expect, it } from "vitest"
import {
  creatorRow,
  ethText,
  makeNftAlertCard,
  type NftAlertCard,
  shortAddr,
  usdText,
} from "../src/nft/card"
import { nftAlertKeyboard, renderNftAlert } from "../src/platforms/telegram/render"
import { NFT_ALL_ALERTS, NFT_WATCHED_ALERTS } from "../src/settings"

const HORNET = "0x4d243f15743f6df7c832fcd5ee9a3e8453d47a4b"
const PRTSCN = "0x3ea71c6abde8a1b3cf6e5683761a7378b4e9e448"
const WIRED = "0x7c701c0148e0e965065aa05e008ac9341e6efc6c"
const INKVERSE = "0xfffbd67f37e1e9fd9d9ebef9b687daa72a33da64"
const links = (...l: NftAlertCard["links"][number]["label"][]): NftAlertCard["links"] =>
  l.map((label) => ({ label, url: `https://example.xyz/${label}` }))
const linkLine = (...l: string[]) =>
  l.map((x) => `<a href="https://example.xyz/${x}">${x}</a>`).join(" · ")

const base = (o: Partial<NftAlertCard>): NftAlertCard => ({
  alert: "upcoming",
  title: "UPCOMING MINT",
  name: "Ink Hornet",
  verified: false,
  marketplace: "OpenSea",
  rows: [],
  contract: HORNET,
  extra: [],
  tokenId: null,
  slug: "ink-hornet",
  imageUrl: "https://i.example/h.png",
  imageKey: `nft:${HORNET}`,
  links: [],
  ...o,
})
const ctx = { linksBase: "https://go.makobot.xyz", botUsername: "makoinkbot" }
const code = (...rows: string[]) => rows.map((r) => `<code>${r}</code>`)

describe("renderNftAlert matches the expected text", () => {
  it("UPCOMING MINT", () => {
    const card = base({
      rows: [
        ["starts", "Sep 6 10:00 UTC (in 2d 4h)"],
        ["supply", "2,222"],
        ["gtd", "10:00 UTC · free"],
        ["fcfs", "13:00 UTC · 0.00025 ETH"],
        ["public", "17:00 UTC · 0.0005 ETH"],
        ["creator", "INKHornetDEV"],
      ],
      links: links("X", "Website"),
    })
    expect(renderNftAlert(card)).toBe(
      [
        "<b>UPCOMING MINT</b>",
        "Ink Hornet · OpenSea",
        "",
        ...code(
          "starts   Sep 6 10:00 UTC (in 2d 4h)",
          "supply   2,222",
          "gtd      10:00 UTC · free",
          "fcfs     13:00 UTC · 0.00025 ETH",
          "public   17:00 UTC · 0.0005 ETH",
          "creator  INKHornetDEV",
        ),
        "",
        `CA   <code>${HORNET}</code>`,
        linkLine("X", "Website"),
      ].join("\n"),
    )
  })

  it("MINT STARTING · GTD and Public", () => {
    const gtd = base({
      alert: "mintstart",
      title: "MINT STARTING · GTD",
      rows: [
        ["price", "free"],
        ["ends", "13:00 UTC (in 3h)"],
        ["limit", "1 per wallet"],
        ["list", "588 wallets"],
        ["minted", "300 / 2,222 (13%)"],
        ["creator", "INKHornetDEV"],
      ],
      links: links("X", "Website"),
    })
    expect(renderNftAlert(gtd)).toBe(
      [
        "<b>MINT STARTING · GTD</b>",
        "Ink Hornet · OpenSea",
        "",
        ...code(
          "price    free",
          "ends     13:00 UTC (in 3h)",
          "limit    1 per wallet",
          "list     588 wallets",
          "minted   300 / 2,222 (13%)",
          "creator  INKHornetDEV",
        ),
        "",
        `CA   <code>${HORNET}</code>`,
        linkLine("X", "Website"),
      ].join("\n"),
    )
    const pub = base({
      alert: "mintstart",
      title: "MINT STARTING · Public",
      rows: [
        ["price", "0.0005 ETH"],
        ["ends", "Sep 27 17:00 UTC (in 21d)"],
        ["limit", "10 per wallet"],
        ["minted", "1,640 / 2,222 (73%)"],
        ["creator", "INKHornetDEV"],
      ],
    })
    expect(renderNftAlert(pub)).toContain("<code>ends     Sep 27 17:00 UTC (in 21d)</code>")
  })

  it("MINT LIVE with a verified collection", () => {
    const card = base({
      alert: "mintlive",
      title: "MINT LIVE",
      name: "PRTSCN",
      verified: true,
      contract: PRTSCN,
      rows: [
        ["minting", "for 32m"],
        ["minted", "2,960 / 4,440 (66%)"],
        ["creator", "0x7171…7866"],
      ],
    })
    expect(renderNftAlert(card)).toBe(
      [
        "<b>MINT LIVE</b>",
        "PRTSCN ✓ · OpenSea",
        "",
        ...code("minting  for 32m", "minted   2,960 / 4,440 (66%)", "creator  0x7171…7866"),
        "",
        `CA   <code>${PRTSCN}</code>`,
      ].join("\n"),
    )
  })

  it("MINTED 50% and SOLD OUT", () => {
    const minted = base({
      alert: "minted",
      title: "MINTED 50%",
      rows: [
        ["minted", "1,111 / 2,222 in 4h 2m"],
        ["stage", "FCFS, started 2m ago · 0.00025 ETH"],
        ["minters", "612 wallets"],
      ],
      links: links("X", "Website"),
    })
    expect(renderNftAlert(minted)).toBe(
      [
        "<b>MINTED 50%</b>",
        "Ink Hornet · OpenSea",
        "",
        ...code(
          "minted   1,111 / 2,222 in 4h 2m",
          "stage    FCFS, started 2m ago · 0.00025 ETH",
          "minters  612 wallets",
        ),
        "",
        `CA   <code>${HORNET}</code>`,
        linkLine("X", "Website"),
      ].join("\n"),
    )
    const out = base({
      alert: "soldout",
      title: "SOLD OUT",
      name: "INKverse",
      contract: INKVERSE,
      rows: [
        ["minted", "1,000 in 2h 0m"],
        ["mint", "free – 0.0005 ETH"],
        ["floor", "0.0055 ETH (11x mint)"],
        ["listed", "84 (8.4%)"],
        ["minters", "901 wallets"],
        ["stages", "Core 487 · Community 413"],
      ],
      links: links("X"),
    })
    expect(renderNftAlert(out)).toBe(
      [
        "<b>SOLD OUT</b>",
        "INKverse · OpenSea",
        "",
        ...code(
          "minted   1,000 in 2h 0m",
          "mint     free – 0.0005 ETH",
          "floor    0.0055 ETH (11x mint)",
          "listed   84 (8.4%)",
          "minters  901 wallets",
          "stages   Core 487 · Community 413",
        ),
        "",
        `CA   <code>${INKVERSE}</code>`,
        linkLine("X"),
      ].join("\n"),
    )
  })

  it("MINT REMINDER", () => {
    const card = base({
      alert: "reminder",
      title: "MINT REMINDER · FCFS",
      rows: [
        ["starts", "13:00 UTC (in 15m)"],
        ["price", "0.00025 ETH"],
        ["limit", "4 per wallet"],
        ["minted", "1,104 / 2,222 (49%)"],
      ],
    })
    expect(renderNftAlert(card)).toBe(
      [
        "<b>MINT REMINDER · FCFS</b>",
        "Ink Hornet · OpenSea",
        "",
        ...code(
          "starts   13:00 UTC (in 15m)",
          "price    0.00025 ETH",
          "limit    4 per wallet",
          "minted   1,104 / 2,222 (49%)",
        ),
        "",
        `CA   <code>${HORNET}</code>`,
      ].join("\n"),
    )
  })

  it("NEW COLLECTION lists the collection CA and the token address", () => {
    const token = "0xbff795017ea6f7fbb2cc30cba4a22d123901ef79"
    const card = base({
      alert: "launch",
      title: "NEW COLLECTION",
      name: "BLOOP",
      marketplace: "Chimera",
      contract: "0xe1b5b19214d27999fea3082e6a3d00a1d39fcac1",
      extra: [["token", token]],
      rows: [
        ["type", "Chimera-404"],
        ["token", "$BLOOP"],
        ["creator", "0xc1c5…a836"],
      ],
    })
    expect(renderNftAlert(card)).toBe(
      [
        "<b>NEW COLLECTION</b>",
        "BLOOP · Chimera",
        "",
        ...code("type     Chimera-404", "token    $BLOOP", "creator  0xc1c5…a836"),
        "",
        "CA     <code>0xe1b5b19214d27999fea3082e6a3d00a1d39fcac1</code>",
        `token  <code>${token}</code>`,
      ].join("\n"),
    )
  })

  it("UNDER FLOOR, RARE LISTING", () => {
    const under = base({
      alert: "under",
      title: "UNDER FLOOR 24%",
      name: "PRTSCN",
      verified: true,
      contract: PRTSCN,
      rows: [
        ["item", "PRTSCN #4405"],
        ["price", "0.032 ETH ($77)"],
        ["floor", "0.042 ETH"],
        ["rank", "3,232 / 4,440"],
        ["expires", "in 6h"],
      ],
    })
    expect(renderNftAlert(under)).toBe(
      [
        "<b>UNDER FLOOR 24%</b>",
        "PRTSCN ✓ · OpenSea",
        "",
        ...code(
          "item     PRTSCN #4405",
          "price    0.032 ETH ($77)",
          "floor    0.042 ETH",
          "rank     3,232 / 4,440",
          "expires  in 6h",
        ),
        "",
        `CA   <code>${PRTSCN}</code>`,
      ].join("\n"),
    )
    const rare = base({
      alert: "rare",
      title: "RARE LISTING",
      name: "PRTSCN",
      verified: true,
      contract: PRTSCN,
      rows: [
        ["item", "PRTSCN #77"],
        ["rank", "41 / 4,440 (top 1%)"],
        ["price", "0.044 ETH ($106)"],
        ["floor", "0.042 ETH (+5%)"],
        ["expires", "in 6h"],
      ],
    })
    expect(renderNftAlert(rare)).toContain("<code>rank     41 / 4,440 (top 1%)</code>")
  })

  it("FLOOR DOWN, SWEEP, SOLD and BIG SALE", () => {
    const floor = base({
      alert: "floor",
      title: "FLOOR DOWN 24%",
      name: "WIRED",
      verified: true,
      contract: WIRED,
      rows: [
        ["floor", "0.427 ETH ($1.0K)"],
        ["24h ago", "0.562 ETH"],
        ["volume", "2.86 ETH ($6.9K) (24h)"],
        ["sales", "4 (24h)"],
        ["holders", "212"],
      ],
      links: links("X"),
    })
    expect(renderNftAlert(floor)).toBe(
      [
        "<b>FLOOR DOWN 24%</b>",
        "WIRED ✓ · OpenSea",
        "",
        ...code(
          "floor    0.427 ETH ($1.0K)",
          "24h ago  0.562 ETH",
          "volume   2.86 ETH ($6.9K) (24h)",
          "sales    4 (24h)",
          "holders  212",
        ),
        "",
        `CA   <code>${WIRED}</code>`,
        linkLine("X"),
      ].join("\n"),
    )
    const sweep = base({
      alert: "sweep",
      title: "SWEEP",
      rows: [
        ["buyer", "0x12ab…cd34"],
        ["bought", "7 items in 4m"],
        ["spent", "0.0112 ETH ($27) · avg 0.0016 ETH"],
        ["floor", "0.0016 ETH"],
      ],
      links: links("X", "Website"),
    })
    expect(renderNftAlert(sweep)).toContain(
      "<code>spent    0.0112 ETH ($27) · avg 0.0016 ETH</code>",
    )
    const sold = base({
      alert: "sale",
      title: "SOLD",
      name: "INKverse",
      contract: INKVERSE,
      rows: [
        ["item", "INKverse #219"],
        ["price", "0.0069 ETH ($17)"],
        ["floor", "0.0055 ETH (+25%)"],
        ["rank", "866 / 999"],
        ["buyer", "0x12ab…cd34"],
        ["seller", "0x9f3e…07aa"],
      ],
    })
    expect(renderNftAlert(sold)).toContain("<code>seller   0x9f3e…07aa</code>")
    const big = base({
      alert: "bigsale",
      title: "BIG SALE",
      name: "WIRED",
      verified: true,
      contract: WIRED,
      rows: [
        ["item", "WIRED #1755"],
        ["price", "0.72 ETH ($1.7K)"],
        ["floor", "0.562 ETH (1.3x)"],
        ["rank", "796 / 877"],
        ["buyer", "0x12ab…cd34"],
      ],
    })
    expect(renderNftAlert(big)).toContain("WIRED ✓ · OpenSea")
  })

  it("widens the label column to the longest label", () => {
    const html = renderNftAlert(
      base({
        rows: [
          ["stage", "x"],
          ["a longer label", "y"],
        ],
      }),
    )
    expect(html).toContain("<code>stage          x</code>")
    expect(html).toContain("<code>a longer label y</code>")
  })

  it("escapes and cuts hostile names and stage labels", () => {
    const col = {
      contract: HORNET,
      name: `<b>Evil</b>‮${"x".repeat(500)}`,
      slug: "evil",
      imageUrl: "https://i.example/h.png",
      safelist: null,
      links: { twitter: null, website: "javascript:alert(1)", discord: null },
      launchpad: null,
    } as unknown as NftCollectionEvent
    const card = makeNftAlertCard("mintstart", "MINT STARTING · GTD", col, [], {})
    expect([...card.name].length).toBeLessThanOrEqual(64)
    expect(card.name).not.toContain("‮")
    expect(card.links).toEqual([])
    const html = renderNftAlert(card)
    expect(html).toContain("&lt;b&gt;Evil&lt;/b&gt;")
    expect(html).not.toContain("<b>Evil")
  })
})

describe("makeNftAlertCard", () => {
  const col = (o: Record<string, unknown> = {}) =>
    ({
      contract: HORNET,
      name: "Ink Hornet",
      slug: "ink-hornet",
      imageUrl: "https://i.example/c.png",
      safelist: "verified",
      links: {
        twitter: "InkHornet",
        website: "https://hornet.xyz",
        discord: "http://discord.gg/x",
      },
      launchpad: null,
      ...o,
    }) as unknown as NftCollectionEvent

  it("adds verified, links and the collection image", () => {
    const c = makeNftAlertCard("minted", "MINTED 50%", col(), [["minted", "1"]], {})
    expect(c.verified).toBe(true)
    expect(c.marketplace).toBe("OpenSea")
    expect(c.links).toEqual([
      { label: "X", url: "https://x.com/InkHornet" },
      { label: "Website", url: "https://hornet.xyz/" },
      { label: "Discord", url: "http://discord.gg/x" },
    ])
    expect(c.imageUrl).toBe("https://i.example/c.png")
    expect(c.imageKey).toBe(`nft:${HORNET}`)
  })

  it("uses the item image for listings and sales, and falls back to the collection image", () => {
    const item = makeNftAlertCard("sale", "SOLD", col(), [], {
      tokenId: "7",
      imageUrl: "https://i.example/item.png",
    })
    expect(item.imageUrl).toBe("https://i.example/item.png")
    expect(item.imageKey).toBe(`nft:${HORNET}:7`)
    const fallback = makeNftAlertCard("sale", "SOLD", col(), [], { tokenId: "7", imageUrl: null })
    expect(fallback.imageUrl).toBe("https://i.example/c.png")
    expect(fallback.imageKey).toBe(`nft:${HORNET}`)
  })

  it("reads Chimera on NEW COLLECTION only", () => {
    const c = col({ launchpad: "chimera" })
    expect(makeNftAlertCard("launch", "NEW COLLECTION", c, [], {}).marketplace).toBe("Chimera")
    expect(makeNftAlertCard("sale", "SOLD", c, [], {}).marketplace).toBe("OpenSea")
  })

  it("names a collection without a snapshot by its short address", () => {
    const c = makeNftAlertCard("sale", "SOLD", null, [], { contract: HORNET })
    expect(c.name).toBe("0x4d24…7a4b")
    expect(c.slug).toBeNull()
  })

  it("creatorRow shows the username with a check, or the short address", () => {
    const who = (creator: unknown) => creatorRow(col({ creator }))
    expect(who({ address: HORNET, username: "INKHornetDEV", verified: true })).toEqual([
      "creator",
      "INKHornetDEV ✓",
    ])
    expect(who({ address: HORNET, username: "INKHornetDEV", verified: false })).toEqual([
      "creator",
      "INKHornetDEV",
    ])
    expect(who({ address: HORNET, username: null, verified: false })).toEqual([
      "creator",
      "0x4d24…7a4b",
    ])
    expect(who(null)).toBeNull()
    expect(creatorRow(col())).toBeNull()
  })
})

describe("number text", () => {
  it.each([
    [32n * 10n ** 15n, 2400, "0.032 ETH ($77)"],
    [25n * 10n ** 13n, null, "0.00025 ETH"],
    [16n * 10n ** 14n, 2400, "0.0016 ETH ($3.84)"],
    [112n * 10n ** 14n, 2400, "0.0112 ETH ($27)"],
    [427n * 10n ** 15n, 2400, "0.427 ETH ($1.0K)"],
    [720n * 10n ** 15n, 2400, "0.72 ETH ($1.7K)"],
    [10n ** 18n, null, "1 ETH"],
    [3n * 10n ** 18n + 5n * 10n ** 17n, null, "3.5 ETH"],
  ])("ethText %s at %s", (wei, rate, text) => {
    expect(ethText(wei, rate)).toBe(text)
  })
  it("usdText keeps cents under $10 and the money style above", () => {
    expect(usdText(3.85)).toBe("$3.85")
    expect(usdText(42)).toBe("$42")
    expect(usdText(1012)).toBe("$1.0K")
  })
  it("shortAddr", () => {
    expect(shortAddr("0x12ab34cd56ef7890aabbccddeeff00112233cd34")).toBe("0x12ab…cd34")
  })
})

describe("nftAlertKeyboard", () => {
  const texts = (kb: ReturnType<typeof nftAlertKeyboard>) =>
    kb.inline_keyboard.map((r) => r.map((b) => b.text))
  const dm = { ...ctx, chatType: "private" as const, deliveryId: "d1" }
  const grp = { ...ctx, chatType: "supergroup" as const, deliveryId: "d1" }

  it("follows the button table", () => {
    const k = (alert: NftAlertCard["alert"]) => base({ alert, tokenId: "5" })
    expect(texts(nftAlertKeyboard(k("upcoming"), dm))).toEqual([
      ["View", "Watch", "Mute"],
      ["Remind me"],
    ])
    expect(texts(nftAlertKeyboard(k("upcoming"), grp))).toEqual([["View", "Watch"], ["Remind me"]])
    for (const a of [
      "mintstart",
      "mintlive",
      "minted",
      "soldout",
      "launch",
      "sale",
      "bigsale",
      "floor",
      "sweep",
    ] as const) {
      expect(texts(nftAlertKeyboard(k(a), dm))).toEqual([["View", "Watch", "Mute"]])
      expect(texts(nftAlertKeyboard(k(a), grp))).toEqual([["View", "Watch"]])
    }
    for (const a of ["under", "rare"] as const) {
      expect(texts(nftAlertKeyboard(k(a), dm))).toEqual([["Buy", "Watch", "Mute"]])
      expect(texts(nftAlertKeyboard(k(a), grp))).toEqual([["Buy", "Watch"]])
    }
    expect(texts(nftAlertKeyboard(k("reminder"), dm))).toEqual([["View", "Reminder set"]])
  })

  it("sends View and Buy through the redirect: collection for mints, item for sales and listings", () => {
    const url = (alert: NftAlertCard["alert"], card = base({ alert, tokenId: "1485" })) =>
      (nftAlertKeyboard(card, dm).inline_keyboard[0]![0] as { url: string }).url
    expect(url("minted")).toBe("https://go.makobot.xyz/n/c/ink-hornet?d=d1")
    expect(url("floor")).toBe("https://go.makobot.xyz/n/c/ink-hornet?d=d1")
    expect(url("sale")).toBe(`https://go.makobot.xyz/n/i/${HORNET}/1485?d=d1`)
    expect(url("bigsale")).toBe(`https://go.makobot.xyz/n/i/${HORNET}/1485?d=d1`)
    expect(url("under")).toBe(`https://go.makobot.xyz/n/i/${HORNET}/1485?d=d1`)
    expect(url("launch", base({ alert: "launch", slug: null }))).toBe(
      `https://go.makobot.xyz/n/a/${HORNET}?d=d1`,
    )
  })

  it("group buttons are deep links and never carry state; DM callbacks flip with the state", () => {
    const g = nftAlertKeyboard(base({ alert: "upcoming" }), {
      ...grp,
      state: { watching: true, muted: true, reminded: true },
    }).inline_keyboard
    expect(g[0]![1]).toEqual({ text: "Watch", url: `https://t.me/makoinkbot?start=wn_${HORNET}` })
    expect(g[1]![0]).toEqual({
      text: "Remind me",
      url: `https://t.me/makoinkbot?start=rn_${HORNET}`,
    })
    const off = nftAlertKeyboard(base({ alert: "upcoming" }), dm).inline_keyboard
    expect(off[0]!.slice(1)).toEqual([
      { text: "Watch", callback_data: `nwa:${HORNET}` },
      { text: "Mute", callback_data: `nm:${HORNET}` },
    ])
    expect(off[1]![0]).toEqual({ text: "Remind me", callback_data: `nrm:${HORNET}` })
    const on = nftAlertKeyboard(base({ alert: "upcoming" }), {
      ...dm,
      state: { watching: true, muted: true, reminded: true },
    }).inline_keyboard
    expect(on[0]!.slice(1)).toEqual([
      { text: "Watching", callback_data: `nws:${HORNET}`, style: "success" },
      { text: "Muted", callback_data: `nmu:${HORNET}`, style: "success" },
    ])
    expect(on[1]![0]).toEqual({
      text: "Reminder set",
      callback_data: `nrr:${HORNET}`,
      style: "success",
    })
  })

  it("MINT REMINDER is View and a green Reminder set that removes the reminder", () => {
    const kb = nftAlertKeyboard(base({ alert: "reminder" }), dm).inline_keyboard
    expect(kb[0]![1]).toEqual({
      text: "Reminder set",
      callback_data: `nrr:${HORNET}`,
      style: "success",
    })
  })

  it("every button label fits 13 characters with 3 in a row, 20 with 2, and 30 alone", () => {
    const kinds = [...NFT_ALL_ALERTS, ...NFT_WATCHED_ALERTS]
    for (const alert of kinds) {
      for (const c of [dm, grp]) {
        for (const state of [undefined, { watching: true, muted: true, reminded: true }]) {
          const kb = nftAlertKeyboard(base({ alert, tokenId: "1" }), { ...c, state })
          for (const row of kb.inline_keyboard) {
            const max = row.length >= 3 ? 13 : row.length === 2 ? 20 : 30
            for (const b of row) expect(b.text.length).toBeLessThanOrEqual(max)
          }
        }
      }
    }
  })

  it("callback data stays under 64 bytes", () => {
    for (const alert of [...NFT_ALL_ALERTS, ...NFT_WATCHED_ALERTS]) {
      const kb = nftAlertKeyboard(base({ alert }), {
        ...dm,
        state: { watching: true, muted: true, reminded: true },
      })
      for (const b of kb.inline_keyboard.flat())
        if ("callback_data" in b) expect(Buffer.byteLength(b.callback_data!)).toBeLessThan(64)
    }
  })
})

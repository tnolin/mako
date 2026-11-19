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
import {
  bidRaisedCard,
  endedCard,
  endingSoonCard,
  liveAuctionCard,
  upcomingAuctionCard,
} from "../src/nft/rules/auction"
import { createNftState } from "../src/nft/state"
import { nftAlertKeyboard, nftViewPath, renderNftAlert } from "../src/platforms/telegram/render"
import { NFT_ALL_ALERTS, NFT_WATCHED_ALERTS } from "../src/settings"
import { loadNftx } from "./helpers/fixtures"

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
  link: "opensea",
  nftxSlug: null,
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

  it("MINT STARTING without a stage label", () => {
    const card = base({
      alert: "mintstart",
      title: "MINT STARTING",
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
        "<b>MINT STARTING</b>",
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

describe("NFTX cards", () => {
  const LIL_DUDES = "0x2538d3202844e6b3852570d9ef63a916f900c373"
  const nftx = (o: Partial<NftAlertCard>) =>
    base({
      alert: "floor",
      title: "FLOOR UP 40%",
      name: "Lil Dudes",
      marketplace: "NFTX",
      link: "nftx",
      nftxSlug: "lil-dudes",
      slug: "lildudes3333",
      contract: LIL_DUDES,
      imageKey: `nft:${LIL_DUDES}`,
      rows: [["floor", "0.000309 ETH"]],
      ...o,
    })

  it('an NFTX card reads "Lil Dudes · NFTX" and has no CA or token line', () => {
    const card = nftx({
      extra: [["token", "0x370e49749b9ff90004f3186aa7135487acc2a8fc"]],
      links: links("X", "Website"),
    })
    expect(renderNftAlert(card)).toBe(
      [
        "<b>FLOOR UP 40%</b>",
        "Lil Dudes · NFTX",
        "",
        ...code("floor    0.000309 ETH"),
        "",
        linkLine("X", "Website"),
      ].join("\n"),
    )
  })

  it("NOW ON NFTX lists floor, pool, supply, holders and creator, then the links, and View opens /n/x/<slug>", () => {
    const card = nftx({
      alert: "launch",
      title: "NOW ON NFTX",
      rows: [
        ["floor", "0.0009 ETH ($2.16)"],
        ["pool", "35 NFTs"],
        ["supply", "3,333"],
        ["holders", "212"],
        ["creator", "0x9860…3b40"],
      ],
      links: links("X", "Website"),
    })
    expect(renderNftAlert(card)).toBe(
      [
        "<b>NOW ON NFTX</b>",
        "Lil Dudes · NFTX",
        "",
        ...code(
          "floor    0.0009 ETH ($2.16)",
          "pool     35 NFTs",
          "supply   3,333",
          "holders  212",
          "creator  0x9860…3b40",
        ),
        "",
        linkLine("X", "Website"),
      ].join("\n"),
    )
    expect(nftViewPath(card)).toBe("/n/x/lil-dudes")
  })

  it("an NFTX card without links ends at its last row", () => {
    expect(renderNftAlert(nftx({}))).toBe(
      ["<b>FLOOR UP 40%</b>", "Lil Dudes · NFTX", "", ...code("floor    0.000309 ETH")].join("\n"),
    )
  })

  // A delivery queued by the release before this one carries neither field.
  it("a card stored without link or nftxSlug renders and links as OpenSea", () => {
    const stored = {
      alert: "minted",
      title: "MINTED 50%",
      name: "Ink Hornet",
      verified: false,
      marketplace: "OpenSea",
      rows: [["minted", "1,111 / 2,222"]],
      contract: HORNET,
      extra: [],
      tokenId: null,
      slug: "ink-hornet",
      imageUrl: null,
      imageKey: `nft:${HORNET}`,
      links: [],
    } as unknown as NftAlertCard
    expect(renderNftAlert(stored)).toBe(
      [
        "<b>MINTED 50%</b>",
        "Ink Hornet · OpenSea",
        "",
        ...code("minted   1,111 / 2,222"),
        "",
        `CA   <code>${HORNET}</code>`,
      ].join("\n"),
    )
    expect(nftViewPath(stored)).toBe("/n/c/ink-hornet")
    const dm = { ...ctx, chatType: "private" as const, deliveryId: "d1" }
    expect((nftAlertKeyboard(stored, dm).inline_keyboard[0]![0] as { url: string }).url).toBe(
      "https://go.makobot.xyz/n/c/ink-hornet?d=d1",
    )
    expect(nftViewPath({ ...stored, alert: "sale", tokenId: "7" })).toBe(`/n/i/${HORNET}/7`)
    expect(nftViewPath({ ...stored, slug: null })).toBe(`/n/a/${HORNET}`)
  })

  it("nftViewPath follows the link table", () => {
    const path = (o: Partial<NftAlertCard>) => nftViewPath(nftx(o))
    // Item alerts with a token id: the item page.
    for (const alert of ["sale", "bigsale", "rare", "under"] as const)
      expect(path({ alert, tokenId: "195" })).toBe("/n/xi/lil-dudes/195")
    // Collection alerts, and an item alert with no token id: the collection page.
    for (const alert of [
      "launch",
      "floor",
      "sweep",
      "minted",
      "soldout",
      "upcoming",
      "mintstart",
    ] as const)
      expect(path({ alert })).toBe("/n/x/lil-dudes")
    expect(path({ alert: "sale", tokenId: null })).toBe("/n/x/lil-dudes")
    // No slug: NFTX's home, for an item and for a collection.
    expect(path({ alert: "sale", tokenId: "195", nftxSlug: null })).toBe("/p/nftx")
    expect(path({ alert: "floor", nftxSlug: null })).toBe("/p/nftx")
    // OpenSea cards keep their paths.
    expect(nftViewPath(base({ alert: "sale", tokenId: "7" }))).toBe(`/n/i/${HORNET}/7`)
    expect(nftViewPath(base({ alert: "floor" }))).toBe("/n/c/ink-hornet")
    expect(nftViewPath(base({ alert: "launch", slug: null }))).toBe(`/n/a/${HORNET}`)
  })

  it("an NFTX card with no slug or an invalid slug opens /p/nftx", () => {
    const dm = { ...ctx, chatType: "private" as const, deliveryId: "d1" }
    const view = (card: NftAlertCard) =>
      (nftAlertKeyboard(card, dm).inline_keyboard[0]![0] as { url: string }).url
    for (const bad of [null, "Lil/../x", "lil dudes", "Lil-Dudes", "", "a".repeat(101)]) {
      // Built through the card builder the slug is dropped; stored on a card it is still not used.
      const built = makeNftAlertCard("floor", "FLOOR UP 40%", null, [], {
        contract: LIL_DUDES,
        market: "nftx",
        nftxSlug: bad,
      })
      expect(built.nftxSlug).toBeNull()
      expect(view(built)).toBe("https://go.makobot.xyz/p/nftx?d=d1")
      expect(view(nftx({ nftxSlug: bad }))).toBe("https://go.makobot.xyz/p/nftx?d=d1")
      expect(view(nftx({ alert: "sale", tokenId: "195", nftxSlug: bad }))).toBe(
        "https://go.makobot.xyz/p/nftx?d=d1",
      )
    }
  })

  it("an NFTX card's buttons are the same as an OpenSea card's", () => {
    const dm = { ...ctx, chatType: "private" as const, deliveryId: "d1" }
    const grp = { ...ctx, chatType: "supergroup" as const, deliveryId: "d1" }
    const texts = (kb: ReturnType<typeof nftAlertKeyboard>) =>
      kb.inline_keyboard.map((r) => r.map((b) => b.text))
    expect(texts(nftAlertKeyboard(nftx({}), dm))).toEqual([["View", "Watch", "Mute"]])
    expect(texts(nftAlertKeyboard(nftx({ alert: "rare", tokenId: "1" }), grp))).toEqual([
      ["Buy", "Watch"],
    ])
  })

  it("AUCTION LIVE's remind flag adds Remind me in a DM and in a group", () => {
    const dm = { ...ctx, chatType: "private" as const, deliveryId: "d1" }
    const grp = { ...ctx, chatType: "supergroup" as const, deliveryId: "d1" }
    const texts = (kb: ReturnType<typeof nftAlertKeyboard>) =>
      kb.inline_keyboard.map((r) => r.map((b) => b.text))
    const live = nftx({ alert: "mintstart", title: "AUCTION LIVE", remind: true })
    expect(texts(nftAlertKeyboard(live, dm))).toEqual([["View", "Watch", "Mute"], ["Remind me"]])
    expect(texts(nftAlertKeyboard(live, grp))).toEqual([["View", "Watch"], ["Remind me"]])
    expect(nftAlertKeyboard(live, dm).inline_keyboard[1]![0]).toEqual({
      text: "Remind me",
      callback_data: `nrm:${LIL_DUDES}`,
    })
    const plain = nftx({ alert: "mintstart", title: "MINT STARTING" })
    expect(texts(nftAlertKeyboard(plain, dm))).toEqual([["View", "Watch", "Mute"]])
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

  it("market nftx labels the card NFTX, points it at NFTX and keeps only a valid slug", () => {
    const c = col({ launchpad: "chimera" })
    const nftx = makeNftAlertCard("launch", "NOW ON NFTX", c, [], {
      market: "nftx",
      nftxSlug: "lil-dudes",
    })
    // The NFTX label wins over the Chimera one.
    expect(nftx).toMatchObject({ marketplace: "NFTX", link: "nftx", nftxSlug: "lil-dudes" })
    expect(nftx.slug).toBe("ink-hornet")
    expect(
      makeNftAlertCard("sale", "SOLD", c, [], { market: "nftx", nftxSlug: "Lil Dudes" }).nftxSlug,
    ).toBeNull()
    expect(makeNftAlertCard("sale", "SOLD", c, [], { remind: true }).remind).toBe(true)
    expect("remind" in makeNftAlertCard("sale", "SOLD", c, [], {})).toBe(false)
    // Without a market the card is an OpenSea card, whatever slug it was handed.
    expect(makeNftAlertCard("sale", "SOLD", c, [], { nftxSlug: "lil-dudes" })).toMatchObject({
      link: "opensea",
      nftxSlug: null,
    })
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

describe("auction cards", () => {
  const fx = loadNftx()
  const { inktrons: A } = fx
  const st = createNftState()
  st.apply({
    id: "1",
    p: { ...fx.lilDudes.collection, links: { twitter: "@dudes", website: null, discord: null } },
  })
  st.apply({ id: "2", p: A.ended })
  const col = st.get(fx.lilDudes.collection.contract)!
  const rate = 2400
  const header = (title: string) => [`<b>${title}</b>`, "Lil Dudes · NFTX", ""]
  const xLine = '<a href="https://x.com/dudes">X</a>'

  it("the five auction cards render as the facts file shows, with no CA line", () => {
    const raised = {
      ...A.price,
      clearingPriceWei: "160000000000000",
      bidders: 4,
      raisedWei: "200000000000000000",
    }
    const cards = [
      upcomingAuctionCard(col, A.created, A.created.blockTimestamp, rate),
      liveAuctionCard(col, A.live, A.live.blockTimestamp, rate),
      bidRaisedCard(col, raised, raised.endsAt - 9 * 3600, rate),
      endingSoonCard(col, A.ended, A.ended.endsAt - 3600, rate),
      endedCard(col, A.ended, A.ended.endsAt + 60, rate),
    ]
    expect(cards.map((c) => renderNftAlert(c))).toEqual([
      [
        ...header("UPCOMING AUCTION"),
        ...code(
          "starts   Nov 5 13:00 UTC (in 13h 9m)",
          "ends     Nov 6 13:00 UTC",
          "supply   1,100 NFTs",
          "min bid  0.0001 ETH ($0.24)",
        ),
        "",
        xLine,
      ].join("\n"),
      [
        ...header("AUCTION LIVE"),
        ...code(
          "min bid  0.0001 ETH ($0.24)",
          "ends     Nov 6 13:00 UTC (in 1d)",
          "supply   1,100 NFTs",
        ),
        "",
        xLine,
      ].join("\n"),
      [
        ...header("MINIMUM BID RAISED"),
        ...code(
          "min bid  0.00016 ETH ($0.38) (+60%)",
          "bidders  4",
          "raised   0.2 ETH ($480)",
          "ends     in 9h",
        ),
      ].join("\n"),
      [
        ...header("AUCTION ENDING SOON"),
        ...code(
          "ends     13:00 UTC (in 1h)",
          "min bid  0.0001 ETH ($0.24)",
          "bidders  11",
          "raised   0.0102 ETH ($24)",
        ),
      ].join("\n"),
      [
        ...header("AUCTION ENDED"),
        ...code(
          "price    0.0001 ETH ($0.24) per NFT",
          "sold     101 / 1,100 (9%)",
          "raised   0.0102 ETH ($24)",
          "bidders  11",
          "claims   from 13:05 UTC",
        ),
      ].join("\n"),
    ])
    for (const c of cards) {
      expect(renderNftAlert(c)).not.toContain("CA ")
      expect(nftViewPath(c)).toBe("/n/x/lil-dudes")
    }
  })

  it("the refunded AUCTION ENDED renders result, raised and bidders", () => {
    const failed = {
      ...A.ended,
      graduated: false,
      cleared: "0",
      raisedWei: "4100000000000000000",
      requiredRaiseWei: "10000000000000000000",
      bidders: 52,
    }
    expect(renderNftAlert(endedCard(col, failed, failed.endsAt, rate))).toBe(
      [
        ...header("AUCTION ENDED"),
        ...code(
          "result   minimum not raised, bids refunded",
          "raised   4.1 / 10 ETH",
          "bidders  52",
        ),
      ].join("\n"),
    )
  })
})

import type { Bot, Context } from "grammy"
import type { InlineKeyboardButton } from "grammy/types"
import { age, clean, count, escapeHtml, inText, utcDate, utcTime } from "../format"
import { collectionLinks, creatorRow, ethText, makeNftAlertCard, shortAddr } from "../nft/card"
import { floorAt, lastSaleOf, recentSales, salesSince } from "../nft/history"
import {
  type Match,
  matchCollection,
  parseNftQuery,
  parseOpenSeaLink,
  WINDOW_S,
  WINDOWS,
  type Window,
} from "../nft/match"
import type { ItemData } from "../nft/opensea"
import { isTeamStage } from "../nft/policy"
import { mintLive, upcomingCard } from "../nft/rules/mint"
import type { CollectionState } from "../nft/state"
import { viewerState } from "../nft/watches"
import { classify } from "../platforms/telegram/errors"
import { CAPTION_MAX } from "../platforms/telegram/images"
import { nftAlertKeyboard, renderNftAlert, renderRows } from "../platforms/telegram/render"
import {
  btn,
  chosenBtn,
  findAddress,
  type Kb,
  link,
  show,
  stateBtn,
  threadOf,
} from "../platforms/telegram/ui"
import { NATIVE } from "../prices"
import { REFRESH_COOLDOWN_MS, refreshCooldown } from "./cooldown"
import { NOT_FOUND } from "./copy"
import type { BotDeps } from "./deps"
import { findUser } from "./users"

export const COPY = {
  nfts: [
    "Look up NFTs by providing a name or contract address.",
    "/nft wired",
    "/nft 0x7c701c0148e0e965065aa05e008ac9341e6efc6c",
  ].join("\n"),
  none: NOT_FOUND,
  loading: "I'm still loading NFT data. Try again in a minute.",
  noSales: "No sales yet.",
  noMinting: "There are no live mints detected right now.",
  noUpcoming: "No results in the next 7 days.",
  noTrending: "No Ink collections are trending in this timeframe.",
  trendingTitle: "Trending NFTs",
  trendingIntro:
    "The Ink collections trending on OpenSea for the selected timeframe with its current floor price.",
  trendingDown: "Trending isn't available right now. Try again in a few minutes.",
} as const
const NO_RANK = "No rarity rank on OpenSea for this collection."
const PARTIAL = "Some details are unavailable right now."
export const SHORT = "Send at least 3 characters"

const nowS = (deps: BotDeps) => deps.now?.() ?? Math.floor(Date.now() / 1000)
const knownMax = (m: string | null | undefined): m is string => !!m && BigInt(m) > 0n

/** The latest minted count and supply the state saw, from the newest mint event. */
function latestMint(st: CollectionState) {
  const seen = [st.lastStage, st.lastMark, st.soldOut].filter((m) => m !== null)
  let best = seen[0]
  for (const m of seen) if (best && BigInt(m.minted) > BigInt(best.minted)) best = m
  return best ?? null
}

/** The `mint` row: Minting now, or how long a sold-out mint took; null otherwise. */
function mintRow(st: CollectionState, now: number): string | null {
  if (st.soldOut) return `sold out in ${age(st.soldOut.blockTimestamp - st.soldOut.mintStartTs)}`
  return mintLive(st, now) ? "Minting now" : null
}

export type CollectionCard = {
  html: string
  imageUrl: string | null
  imageKey: string
  slug: string | null
}

/** The collection card for a window. Null when MAKO has no data on the contract. */
export async function collectionCard(
  deps: BotDeps,
  contract: string,
  win: Window = "24h",
): Promise<CollectionCard | null> {
  const st = deps.nft?.()?.get(contract)
  if (!st) return null
  const now = nowS(deps)
  const rate = deps.prices.usd(NATIVE)
  const base = makeNftAlertCard("minted", "", st.col, [], { contract })
  const stats = st.stats
  const rows: [string, string][] = []
  if (stats?.floorWei) {
    const cur = BigInt(stats.floorWei)
    const past = await floorAt(deps.sql, contract, now - WINDOW_S[win])
    const was = past?.p.floorWei ? BigInt(past.p.floorWei) : 0n
    let change = ""
    if (was > 0n) {
      const bps = Number(((cur - was) * 10000n) / was)
      change = ` (${bps < 0 ? "−" : "+"}${Math.round(Math.abs(bps) / 100)}% ${win})`
    }
    rows.push(["floor", `${ethText(cur, rate)}${change}`])
  }
  const sales = await salesSince(deps.sql, contract, now - WINDOW_S[win])
  rows.push(
    ["volume", `${ethText(sales.sumWei, rate)} (${win})`],
    ["sales", `${count(sales.count)} (${win})`],
  )
  const minted = latestMint(st)
  const running =
    !!minted &&
    !st.soldOut &&
    knownMax(minted.maxSupply) &&
    BigInt(minted.minted) < BigInt(minted.maxSupply)
  const total = stats?.totalSupply ?? st.drop?.maxSupply ?? st.col?.maxSupply ?? null
  if (running && minted)
    rows.push(["supply", `${count(Number(minted.minted))} / ${count(Number(minted.maxSupply))}`])
  else if (knownMax(total)) rows.push(["supply", count(Number(total))])
  if (stats) rows.push(["holders", count(stats.owners)])
  if (stats?.listedCount) {
    const share = knownMax(total)
      ? ` (${Number(((stats.listedCount / Number(total)) * 100).toFixed(1))}%)`
      : ""
    rows.push([
      "listed",
      stats.listedCapped ? `${count(stats.listedCount)}+` : `${count(stats.listedCount)}${share}`,
    ])
  }
  const creator = creatorRow(st.col)
  if (creator) rows.push(creator)
  const mint = mintRow(st, now)
  if (mint) rows.push(["mint", mint])
  const market = st.col?.launchpad === "chimera" ? "Chimera" : "OpenSea"
  const lines = [
    `<b>${escapeHtml(base.name)}${base.verified ? " ✓" : ""} · ${market}</b>`,
    "",
    ...renderRows(rows),
    "",
    `CA   <code>${contract}</code>`,
  ]
  if (base.links.length > 0) {
    lines.push(base.links.map((l) => `<a href="${escapeHtml(l.url)}">${l.label}</a>`).join(" · "))
  }
  return {
    html: lines.join("\n"),
    imageUrl: base.imageUrl,
    imageKey: base.imageKey,
    slug: base.slug,
  }
}

/** The viewer: a user in a DM (by their row), or the chat in a group. */
async function isWatching(deps: BotDeps, ctx: Context, contract: string): Promise<boolean> {
  if (ctx.chat?.type === "private") {
    const u = ctx.from ? await findUser(deps.sql, ctx.from.id) : null
    if (!u) return false
    return (
      (
        await deps.sql`select 1 from bot.nft_watches where user_id = ${u.id} and contract = ${contract}`
      ).length > 0
    )
  }
  if (!ctx.chat) return false
  return (
    (
      await deps.sql`select 1 from bot.nft_watches where chat_id = ${ctx.chat.id} and contract = ${contract}`
    ).length > 0
  )
}

const viewUrl = (deps: BotDeps, contract: string, slug: string | null) =>
  slug ? `${deps.linksBase}/n/c/${slug}` : `${deps.linksBase}/n/a/${contract}`

/** Watch in a DM (green Watching when set), a deep link into the DM elsewhere. */
const watchBtn = (ctx: Context, contract: string, watching: boolean): InlineKeyboardButton =>
  ctx.chat?.type === "private"
    ? stateBtn(
        { on: watching, off: "Watch", onText: "Watching" },
        `${watching ? "nws" : "nwa"}:${contract}`,
      )
    : link("Watch", `https://t.me/${ctx.me.username}?start=wn_${contract}`)

/**
 * A collection MAKO has no events for (one from Trending), read live from OpenSea and laid out like the
 * collection card. Without MAKO's history it has no window or Recent sales buttons.
 */
async function sendLiveCard(ctx: Context, deps: BotDeps, contract: string): Promise<void> {
  const live = deps.items ? await deps.items.collection(contract) : "unavailable"
  if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {})
  const d = live === "unavailable" ? null : live
  const rate = deps.prices.usd(NATIVE)
  const rows: [string, string][] = []
  if (d?.floorWei != null) rows.push(["floor", ethText(d.floorWei, rate)])
  if (d?.volume24hWei != null) rows.push(["volume", `${ethText(d.volume24hWei, rate)} (24h)`])
  if (d?.sales24h != null) rows.push(["sales", `${count(d.sales24h)} (24h)`])
  if (d?.totalSupply) rows.push(["supply", count(d.totalSupply)])
  if (d?.owners != null) rows.push(["holders", count(d.owners)])
  const stats = d && (d.floorWei ?? d.volume24hWei ?? d.sales24h ?? d.owners) !== null
  const name = clean(d?.name, 64) || shortAddr(contract)
  const lines = [
    `<b>${escapeHtml(name)}${d?.verified ? " ✓" : ""} · OpenSea</b>`,
    "",
    ...renderRows(rows),
    ...(stats ? [] : [PARTIAL]),
    "",
    `CA   <code>${contract}</code>`,
  ]
  const links = collectionLinks(d?.links)
  if (links.length > 0) {
    lines.push(links.map((l) => `<a href="${escapeHtml(l.url)}">${l.label}</a>`).join(" · "))
  }
  await deps.images.send(ctx.api, {
    chat: ctx.chat!.id,
    thread: threadOf(ctx),
    imageKey: `nft:${contract}`,
    imageUrl: d?.imageUrl ?? null,
    html: lines.join("\n"),
    reply_markup: {
      inline_keyboard: [
        [
          watchBtn(ctx, contract, await isWatching(deps, ctx, contract)),
          link("View", viewUrl(deps, contract, d?.slug ?? null)),
        ],
      ],
    },
  })
}

function cardKb(
  deps: BotDeps,
  ctx: Context,
  card: CollectionCard,
  contract: string,
  win: Window,
  watching: boolean,
): Kb {
  const watch = watchBtn(ctx, contract, watching)
  return [
    WINDOWS.map((w) => chosenBtn(w, w === win, `nw:${contract}:${w}`)),
    [
      watch,
      btn("Recent sales", `nr:${contract}:1`),
      link("View", viewUrl(deps, contract, card.slug)),
    ],
  ]
}

/**
 * A collection opened from the Upcoming list is shown as its UPCOMING MINT alert, with the buttons that
 * alert has in this chat. False when the mint has started, so the caller sends the collection card.
 */
async function sendUpcomingCard(ctx: Context, deps: BotDeps, contract: string): Promise<boolean> {
  const st = deps.nft?.()?.get(contract)
  const card = st?.drop ? upcomingCard(st.col, st.drop, nowS(deps)) : null
  if (!card) return false
  if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {})
  const dm = ctx.chat?.type === "private"
  const user = dm && ctx.from ? await findUser(deps.sql, ctx.from.id) : null
  const state = user ? await viewerState(deps.sql, user.id, contract) : undefined
  await deps.images.send(ctx.api, {
    chat: ctx.chat!.id,
    thread: threadOf(ctx),
    imageKey: card.imageKey,
    imageUrl: card.imageUrl,
    html: renderNftAlert(card),
    reply_markup: nftAlertKeyboard(card, {
      chatType: ctx.chat!.type,
      linksBase: deps.linksBase,
      botUsername: ctx.me.username,
      ...(state ? { state } : {}),
    }),
  })
  return true
}

/** A new message: the card as a padded photo with the card as caption, or as text. */
async function sendCard(ctx: Context, deps: BotDeps, contract: string, win: Window): Promise<void> {
  const card = await collectionCard(deps, contract, win)
  if (!card) {
    if (deps.items) return sendLiveCard(ctx, deps, contract)
    return void (await show(ctx, COPY.none))
  }
  if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {})
  const kb = cardKb(deps, ctx, card, contract, win, await isWatching(deps, ctx, contract))
  await deps.images.send(ctx.api, {
    chat: ctx.chat!.id,
    thread: threadOf(ctx),
    imageKey: card.imageKey,
    imageUrl: card.imageUrl,
    html: card.html,
    reply_markup: { inline_keyboard: kb },
  })
}

/** Edits the tapped card in place: the caption of a photo, the text of a text card. */
async function editCard(ctx: Context, deps: BotDeps, html: string, kb: Kb): Promise<void> {
  const tapped = ctx.callbackQuery?.message
  const isPhoto = !!tapped && "photo" in tapped && !!tapped.photo
  const reply_markup = { inline_keyboard: kb }
  if (isPhoto && html.length > CAPTION_MAX) {
    // Too long for a caption now: a new text message replaces the photo card.
    await deps.images.send(ctx.api, {
      chat: ctx.chat!.id,
      thread: threadOf(ctx),
      imageKey: "",
      imageUrl: null,
      html,
      reply_markup,
    })
  } else {
    try {
      if (isPhoto) await ctx.editMessageCaption({ caption: html, parse_mode: "HTML", reply_markup })
      else
        await ctx.editMessageText(html, {
          parse_mode: "HTML",
          reply_markup,
          link_preview_options: { is_disabled: true },
        })
    } catch (err) {
      if (classify(err).kind !== "not_modified") throw err
    }
  }
  await ctx.answerCallbackQuery().catch(() => {})
}

async function windowCard(
  ctx: Context,
  deps: BotDeps,
  contract: string,
  win: Window,
): Promise<void> {
  const card = await collectionCard(deps, contract, win)
  if (!card) return void (await ctx.answerCallbackQuery({ text: COPY.none }).catch(() => {}))
  const kb = cardKb(deps, ctx, card, contract, win, await isWatching(deps, ctx, contract))
  await editCard(ctx, deps, card.html, kb)
}

const PAGE = 10
async function salesPage(
  ctx: Context,
  deps: BotDeps,
  contract: string,
  page: number,
): Promise<void> {
  const st = deps.nft?.()?.get(contract)
  if (!st) return void (await ctx.answerCallbackQuery({ text: COPY.none }).catch(() => {}))
  const name = makeNftAlertCard("minted", "", st.col, [], { contract }).name
  const slug = st.col?.slug ?? null
  const { rows, total } = await recentSales(deps.sql, contract, (page - 1) * PAGE, PAGE)
  const pages = Math.max(1, Math.ceil(total / PAGE))
  const now = nowS(deps)
  const idw = Math.max(0, ...rows.map((r) => r.p.tokenId.length)) + 1
  const lines =
    rows.length === 0
      ? [COPY.noSales]
      : rows.map(
          (r) =>
            `<code>${`#${r.p.tokenId}`.padEnd(idw + 3)}${escapeHtml(ethText(BigInt(r.p.priceWei), null))}   ${inText(now - r.p.blockTimestamp)} ago</code>`,
        )
  const html = [
    `<b>Recent sales · ${escapeHtml(name)}</b>`,
    "",
    ...lines,
    `page ${page} of ${pages}`,
  ].join("\n")
  const nav: InlineKeyboardButton[] = []
  if (page > 1) nav.push(btn("‹ Newer", `nr:${contract}:${page - 1}`))
  if (page < pages) nav.push(btn("Older ›", `nr:${contract}:${page + 1}`))
  const kb: Kb = []
  if (nav.length > 0) kb.push(nav)
  kb.push([
    btn("Back", `nw:${contract}:24h`),
    link("OpenSea", slug ? `${deps.linksBase}/n/s/${slug}` : viewUrl(deps, contract, null)),
  ])
  await editCard(ctx, deps, html, kb)
}

export type ItemCard = { html: string; imageUrl: string | null; imageKey: string; kb: Kb }

/** The NFT card. `data` is what OpenSea gave; "unavailable" (or none) shows only what MAKO has. */
export async function itemCard(
  deps: BotDeps,
  contract: string,
  tokenId: string,
  data: ItemData | "unavailable" | undefined,
): Promise<ItemCard> {
  const st = deps.nft?.()?.get(contract)
  const base = makeNftAlertCard("minted", "", st?.col ?? null, [], { contract })
  const rate = deps.prices.usd(NATIVE)
  const rows: [string, string][] = []
  let noRank = false
  const got = data && data !== "unavailable" ? data : null
  if (got) {
    if (got.rank === null) noRank = true
    else {
      const max = st?.col?.maxRank
      rows.push(["rank", max ? `${count(got.rank)} / ${count(max)}` : count(got.rank)])
    }
    if (got.bestOffer !== null) rows.push(["best offer", ethText(got.bestOffer, rate)])
    if (got.listed !== null) rows.push(["listed", ethText(got.listed, rate)])
  }
  const sold = await lastSaleOf(deps.sql, contract, tokenId)
  if (sold)
    rows.push([
      "last sold",
      `${ethText(BigInt(sold.p.priceWei), null)} · ${utcDate(sold.p.blockTimestamp)}`,
    ])
  for (const t of got?.traits ?? [])
    rows.push([clean(t.type, 24).toLowerCase(), clean(t.value, 40)])
  // Labels pad to two past the longest.
  const w = Math.max(9, ...rows.map(([l]) => l.length + 2))
  const lines = [
    `<b>${escapeHtml(base.name)}${base.verified ? " ✓" : ""} #${escapeHtml(tokenId)} · OpenSea</b>`,
    "",
    ...(noRank ? [NO_RANK] : []),
    ...rows.map(([l, v]) => `<code>${escapeHtml(l.padEnd(w))}${escapeHtml(v)}</code>`),
    ...(!got || got.partial ? [PARTIAL] : []),
    "",
    `CA   <code>${contract}</code>`,
  ]
  const item = got?.imageUrl ?? null
  return {
    html: lines.join("\n"),
    imageUrl: item ?? base.imageUrl,
    imageKey: item ? `nft:${contract}:${tokenId}` : base.imageKey,
    kb: [
      [
        link("View", `${deps.linksBase}/n/i/${contract}/${tokenId}`),
        btn("Collection", `nc:${contract}`),
      ],
    ],
  }
}

// One cooldown per bot, so the tests (and a restart) start clean.
const cooldowns = new WeakMap<BotDeps, (key: string) => number>()
function itemCooldown(deps: BotDeps, key: string): number {
  const c = cooldowns.get(deps) ?? refreshCooldown(REFRESH_COOLDOWN_MS)
  cooldowns.set(deps, c)
  return c(key)
}

/** Opens the NFT card: the cooldown first (a tap inside it reads nothing), then one live OpenSea read. */
async function sendItemCard(
  ctx: Context,
  deps: BotDeps,
  contract: string,
  tokenId: string,
): Promise<void> {
  const wait = ctx.from ? itemCooldown(deps, `${ctx.from.id}:${contract}:${tokenId}`) : 0
  if (wait > 0) {
    const text = `Up to date, try again in ${wait}s`
    if (ctx.callbackQuery) return void (await ctx.answerCallbackQuery({ text }).catch(() => {}))
    return void (await show(ctx, text))
  }
  if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {})
  const calc = deps.nft?.()?.get(contract)?.col?.rarityCalculatedAt
  const data = deps.items
    ? await deps.items.get(contract, tokenId, calc == null ? null : String(calc))
    : undefined
  const card = await itemCard(deps, contract, tokenId, data)
  await deps.images.send(ctx.api, {
    chat: ctx.chat!.id,
    thread: threadOf(ctx),
    imageKey: card.imageKey,
    imageUrl: card.imageUrl,
    html: card.html,
    reply_markup: { inline_keyboard: card.kb },
  })
}

/** The collections the viewer watches, so a list can include them whatever their verdict. */
async function watchedBy(deps: BotDeps, ctx: Context): Promise<Set<string>> {
  const u = ctx.from ? await findUser(deps.sql, ctx.from.id) : null
  if (!u) return new Set()
  const rows = await deps.sql<
    { contract: string }[]
  >`select contract from bot.nft_watches where user_id = ${u.id}`
  return new Set(rows.map((r) => r.contract))
}

const withTail = (name: string, tail: string, max: number) =>
  `${clean(name, Math.max(6, max - tail.length))}${tail}`

type ListRow = { contract: string; label: string }
const TIMEFRAME = { t1: "one_hour", t24: "one_day", t7: "seven_days" } as const
const TREND_LABEL = { t1: "1h", t24: "24h", t7: "7d" } as const

/** OpenSea's trending Ink collections in its order, with the floor from MAKO's stats where it knows one. */
async function trendingRows(
  deps: BotDeps,
  code: keyof typeof TIMEFRAME,
): Promise<ListRow[] | "down" | null> {
  const state = deps.nft?.()
  if (!state) return null
  const trending = deps.items ? await deps.items.trending(TIMEFRAME[code]) : "unavailable"
  if (trending === "unavailable") return "down"
  // OpenSea's trending response has no prices, so the floor is MAKO's own, when it has one.
  return trending.slice(0, 10).map((t) => {
    const floorWei = state.get(t.contract)?.stats?.floorWei
    const floor = floorWei ? ` · ${ethText(BigInt(floorWei), null)} floor` : ""
    return { contract: t.contract, label: withTail(clean(t.name, 64), floor, 30) }
  })
}

async function listRows(deps: BotDeps, ctx: Context, code: string): Promise<ListRow[] | null> {
  const state = deps.nft?.()
  if (!state) return null
  const watched = await watchedBy(deps, ctx)
  const now = nowS(deps)
  const nameOf = (s: CollectionState) =>
    makeNftAlertCard("minted", "", s.col, [], {
      contract: (s.col?.contract ?? s.launch?.contract)!,
    })
  if (code === "m") {
    return state
      .live()
      .filter(
        (s) =>
          s.col &&
          s.col.launchpad !== "chimera" &&
          (s.col.verdict === "real" || watched.has(s.col.contract)),
      )
      .map((s) => {
        const m = latestMint(s)!
        const pct = knownMax(m.maxSupply)
          ? Number((BigInt(m.minted) * 100n) / BigInt(m.maxSupply))
          : null
        const stage = clean(s.lastStage?.stageLabel ?? "Mint", 12)
        return { s, pct, stage }
      })
      .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1))
      .slice(0, 10)
      .map(({ s, pct, stage }) => ({
        contract: s.col!.contract,
        label: withTail(nameOf(s).name, ` · ${stage}${pct === null ? "" : ` · ${pct}%`}`, 30),
      }))
  }
  if (code === "u") {
    return state
      .upcoming(now, 7 * 86400)
      .filter(
        (s) =>
          s.col &&
          (watched.has(s.col.contract) ||
            (s.col.verdict !== "filtered" &&
              s.col.gates.page === "pass" &&
              s.col.gates.structure === "pass")),
      )
      .slice(0, 10)
      .map((s) => {
        const first = s.drop!.stages.find((st) => !isTeamStage(st) && st.startTime > now)!
        return {
          contract: s.col!.contract,
          label: withTail(nameOf(s).name, ` · ${utcTime(first.startTime, true)}`, 30),
        }
      })
  }
  return null
}

const LIST_TITLE: Record<string, string> = { m: "Minting Now", u: "Upcoming Mints" }
const LIST_EMPTY: Record<string, string> = { m: COPY.noMinting, u: COPY.noUpcoming }
/** Shown under the title when the list has rows. */
const LIST_INTRO: Record<string, string> = {
  m: [
    "NFT collections with an active mint stage are displayed below, regardless of your eligibility. Tap one of the buttons below to view more details about that collection.",
    "",
    "Percentage values are total mint progress. E.g., 50% is 50/100 mints.",
  ].join("\n"),
  u: "NFT collections with a mint stage starting in the next 7 days. If you want to be notified of all mint stages of a collection, add it to your watchlist with /watch &lt;collection name&gt;.",
}

async function showTrending(
  ctx: Context,
  deps: BotDeps,
  code: keyof typeof TIMEFRAME,
): Promise<void> {
  const rows = await trendingRows(deps, code)
  if (Array.isArray(rows)) {
    // Reads the stats of the rows MAKO has no data for in the background, so a tap opens from the cache.
    const state = deps.nft?.()
    void deps.items?.prefetch(rows.map((r) => r.contract).filter((c) => !state?.get(c)))
  }
  const title = `<b>${COPY.trendingTitle} (${TREND_LABEL[code]})</b>`
  const back: Kb = [[btn("Back", "nfts")]]
  const frames: Kb = [
    (Object.keys(TIMEFRAME) as (keyof typeof TIMEFRAME)[]).map((c) =>
      chosenBtn(TREND_LABEL[c], c === code, `nl:${c}`),
    ),
  ]
  if (rows === null) return void (await show(ctx, COPY.loading, back))
  if (rows === "down")
    return void (await show(ctx, `${title}\n${COPY.trendingDown}`, [...frames, ...back]))
  if (rows.length === 0)
    return void (await show(ctx, `${title}\n${COPY.noTrending}`, [...frames, ...back]))
  await show(ctx, `${title}\n${COPY.trendingIntro}`, [
    ...frames,
    ...rows.map((r) => [btn(r.label, `nc:${r.contract}:${code}`)]),
    ...back,
  ])
}

async function showList(ctx: Context, deps: BotDeps, code: string): Promise<void> {
  if (code in TIMEFRAME) return showTrending(ctx, deps, code as keyof typeof TIMEFRAME)
  const rows = await listRows(deps, ctx, code)
  const title = `<b>${LIST_TITLE[code] ?? "NFTs"}</b>`
  if (rows === null) return void (await show(ctx, COPY.loading, [[btn("Back", "nfts")]]))
  const back: Kb = [[btn("Back", "nfts")]]
  if (rows.length === 0) return void (await show(ctx, `${title}\n${LIST_EMPTY[code]}`, back))
  const intro = LIST_INTRO[code]
  await show(ctx, intro ? `${title}\n${intro}` : title, [
    ...rows.map((r) => [btn(r.label, `nc:${r.contract}:${code}`)]),
    ...back,
  ])
}

/** `/nft <collection> [window]` and the pick list: sends the card, the pick list or the reason there is none. */
async function nftCommand(ctx: Context, deps: BotDeps, text: string): Promise<void> {
  const state = deps.nft?.()
  if (!state) return void (await show(ctx, COPY.loading))
  if (!text.trim()) return void (await show(ctx, COPY.nfts))
  const q = parseNftQuery(state, text)
  if (q.tokenId !== null && q.contract.kind === "one")
    return sendItemCard(ctx, deps, q.contract.contract, q.tokenId)
  await openMatch(ctx, deps, state, q.contract, text, q.window ?? "24h")
}

export async function openMatch(
  ctx: Context,
  deps: BotDeps,
  state: NonNullable<ReturnType<NonNullable<BotDeps["nft"]>>>,
  m: Match,
  text: string,
  win: Window,
): Promise<void> {
  if (m.kind === "short") return void (await show(ctx, SHORT))
  if (m.kind === "none") return void (await show(ctx, COPY.none))
  if (m.kind === "one") return sendCard(ctx, deps, m.contract, win)
  const kb: Kb = m.contracts.map((c) => {
    const s = state.get(c)!
    const name = makeNftAlertCard("minted", "", s.col, [], { contract: c }).name
    const holders = s.stats
      ? ` · ${count(s.stats.owners)} holder${s.stats.owners === 1 ? "" : "s"}`
      : ""
    return [btn(withTail(name, ` · ${shortAddr(c)}${holders}`, 34), `nc:${c}`)]
  })
  await show(
    ctx,
    `More than one collection matches "${escapeHtml(clean(text, 40))}". Pick one:`,
    kb,
  )
}

/**
 * A pasted contract, OpenSea collection link or (in a DM) exact slug that is a known collection opens its
 * card. Returns false when the text is none of these, so the caller can go on.
 */
export async function tryNftPaste(ctx: Context, deps: BotDeps, text: string): Promise<boolean> {
  const state = deps.nft?.()
  if (!state) return false
  const lnk = parseOpenSeaLink(text)
  if (lnk && "contract" in lnk) {
    // An item link: MAKO may not know the collection, but OpenSea does.
    if (!state.get(lnk.contract) && !deps.items) return false
    await sendItemCard(ctx, deps, lnk.contract, lnk.tokenId)
    return true
  }
  let contract: string | null = null
  if (lnk) {
    const m = matchCollection(state, text)
    contract = m.kind === "one" ? m.contract : null
  } else {
    const ca = findAddress(text)
    if (ca) contract = state.get(ca) ? ca : null
    else if (ctx.chat?.type === "private" && /^[a-z0-9-]{3,100}$/.test(text.trim())) {
      const first = state.matches(text.trim())[0]
      contract = first?.tier === 1 ? (first.state.col?.contract ?? null) : null
    }
  }
  if (!contract) return false
  await sendCard(ctx, deps, contract, "24h")
  return true
}

export function registerNft(bot: Bot, deps: BotDeps): void {
  bot.command("nft", (ctx) => nftCommand(ctx, deps, ctx.match))
  bot.callbackQuery(/^nc:(0x[0-9a-f]{40})(?::([a-z0-9]+))?$/, async (ctx) => {
    const contract = ctx.match[1]!
    if (ctx.match[2] === "u" && (await sendUpcomingCard(ctx, deps, contract))) return
    await sendCard(ctx, deps, contract, "24h")
  })
  // Older buttons carry the list a card came from; it no longer matters.
  bot.callbackQuery(/^nw:(0x[0-9a-f]{40}):(1h|24h|7d|30d)(?::([a-z0-9]+))?$/, (ctx) =>
    windowCard(ctx, deps, ctx.match[1]!, ctx.match[2] as Window),
  )
  bot.callbackQuery(/^nr:(0x[0-9a-f]{40}):([0-9]{1,4})(?::([a-z0-9]+))?$/, (ctx) =>
    salesPage(ctx, deps, ctx.match[1]!, Math.max(1, Number(ctx.match[2]))),
  )
  bot.callbackQuery(/^ni:(0x[0-9a-f]{40}):([0-9]{1,78})$/, (ctx) =>
    sendItemCard(ctx, deps, ctx.match[1]!, ctx.match[2]!),
  )
  bot.callbackQuery(/^nl:(m|u|t1|t24|t7)$/, (ctx) => showList(ctx, deps, ctx.match[1]!))
}

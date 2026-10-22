import type { Bot, Context } from "grammy"
import type { InlineKeyboardButton } from "grammy/types"
import { age, clean, count, escapeHtml, inText, utcDate, utcTime } from "../format"
import { creatorRow, ethText, makeNftAlertCard, shortAddr } from "../nft/card"
import { floorAt, recentSales, salesSince } from "../nft/history"
import {
  type Match,
  matchCollection,
  parseNftQuery,
  parseOpenSeaLink,
  WINDOW_S,
  WINDOWS,
  type Window,
} from "../nft/match"
import { isTeamStage } from "../nft/policy"
import type { CollectionState } from "../nft/state"
import { classify } from "../platforms/telegram/errors"
import { CAPTION_MAX } from "../platforms/telegram/images"
import { renderRows } from "../platforms/telegram/render"
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
import type { BotDeps } from "./deps"
import { findUser } from "./users"

// Words the owner has not supplied. They are marked gaps, never filled in by the build; the final report
// lists them and the owner's wording replaces these strings.
export const GAP = {
  nfts: "[COPY NEEDED: /nft with no collection]",
  none: "[COPY NEEDED: no collection matches the query]",
  loading: "[COPY NEEDED: NFT data is not loaded yet]",
  noSales: "[COPY NEEDED: a collection with no sales yet]",
  noMinting: "[COPY NEEDED: no collection is minting now]",
  noUpcoming: "[COPY NEEDED: no mint is scheduled in the next 7 days]",
} as const
/** From the approved spec ("Closest-match rule"). */
export const SHORT = "Send at least 3 characters"

const nowS = (deps: BotDeps) => deps.now?.() ?? Math.floor(Date.now() / 1000)
const sameDay = (a: number, b: number) => utcDate(a) === utcDate(b)
const price = (wei: string) => (BigInt(wei) === 0n ? "free" : ethText(BigInt(wei), null))
const knownMax = (m: string | null | undefined): m is string => !!m && BigInt(m) > 0n

/** The latest minted count and supply the state saw, from the newest mint event. */
function latestMint(st: CollectionState) {
  const seen = [st.lastStage, st.lastMark, st.soldOut].filter((m) => m !== null)
  let best = seen[0]
  for (const m of seen) if (best && BigInt(m.minted) > BigInt(best.minted)) best = m
  return best ?? null
}

/** The `mint` row: where the mint stands now, or null for a collection with no mint phase. */
function mintRow(st: CollectionState, now: number): string | null {
  if (st.soldOut) return `sold out in ${age(st.soldOut.blockTimestamp - st.soldOut.mintStartTs)}`
  const stages = (st.drop?.stages ?? []).filter((s) => !isTeamStage(s))
  const cur = stages.find((s) => s.startTime <= now && (s.endTime === null || now < s.endTime))
  if (cur) {
    const end =
      cur.endTime === null ? "" : `, ends ${utcTime(cur.endTime, !sameDay(cur.endTime, now))}`
    return `${clean(cur.label, 12)} now · ${price(cur.priceWei)}${end}`
  }
  const next = stages.find((s) => s.startTime > now)
  if (next)
    return `next ${clean(next.label, 12)} ${utcTime(next.startTime, true)} · ${price(next.priceWei)}`
  const m = latestMint(st)
  return m && knownMax(m.maxSupply)
    ? `${Number((BigInt(m.minted) * 100n) / BigInt(m.maxSupply))}% minted`
    : null
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

const suffix = (code?: string) => (code ? `:${code}` : "")
const viewUrl = (deps: BotDeps, contract: string, slug: string | null) =>
  slug ? `${deps.linksBase}/n/c/${slug}` : `${deps.linksBase}/n/a/${contract}`

function cardKb(
  deps: BotDeps,
  ctx: Context,
  card: CollectionCard,
  contract: string,
  win: Window,
  watching: boolean,
  code?: string,
): Kb {
  const dm = ctx.chat?.type === "private"
  const watch: InlineKeyboardButton = dm
    ? stateBtn(
        { on: watching, off: "Watch", onText: "Watching" },
        `${watching ? "nws" : "nwa"}:${contract}`,
      )
    : link("Watch", `https://t.me/${ctx.me.username}?start=wn_${contract}`)
  const kb: Kb = [
    WINDOWS.map((w) => chosenBtn(w, w === win, `nw:${contract}:${w}${suffix(code)}`)),
    [
      watch,
      btn("Recent sales", `nr:${contract}:1${suffix(code)}`),
      link("View", viewUrl(deps, contract, card.slug)),
    ],
  ]
  if (code) kb.push([btn("Back", `nl:${code}`)])
  return kb
}

/** A new message: the card as a padded photo with the card as caption, or as text. */
async function sendCard(
  ctx: Context,
  deps: BotDeps,
  contract: string,
  win: Window,
  code?: string,
): Promise<void> {
  const card = await collectionCard(deps, contract, win)
  if (!card) return void (await show(ctx, GAP.none))
  if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {})
  const kb = cardKb(deps, ctx, card, contract, win, await isWatching(deps, ctx, contract), code)
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
  code?: string,
): Promise<void> {
  const card = await collectionCard(deps, contract, win)
  if (!card) return void (await ctx.answerCallbackQuery({ text: GAP.none }).catch(() => {}))
  const kb = cardKb(deps, ctx, card, contract, win, await isWatching(deps, ctx, contract), code)
  await editCard(ctx, deps, card.html, kb)
}

const PAGE = 10
async function salesPage(
  ctx: Context,
  deps: BotDeps,
  contract: string,
  page: number,
  code?: string,
): Promise<void> {
  const st = deps.nft?.()?.get(contract)
  if (!st) return void (await ctx.answerCallbackQuery({ text: GAP.none }).catch(() => {}))
  const name = makeNftAlertCard("minted", "", st.col, [], { contract }).name
  const slug = st.col?.slug ?? null
  const { rows, total } = await recentSales(deps.sql, contract, (page - 1) * PAGE, PAGE)
  const pages = Math.max(1, Math.ceil(total / PAGE))
  const now = nowS(deps)
  const idw = Math.max(0, ...rows.map((r) => r.p.tokenId.length)) + 1
  const lines =
    rows.length === 0
      ? [GAP.noSales]
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
  if (page > 1) nav.push(btn("‹ Newer", `nr:${contract}:${page - 1}${suffix(code)}`))
  if (page < pages) nav.push(btn("Older ›", `nr:${contract}:${page + 1}${suffix(code)}`))
  const kb: Kb = []
  if (nav.length > 0) kb.push(nav)
  kb.push([
    btn("Back", `nw:${contract}:24h${suffix(code)}`),
    link("OpenSea", slug ? `${deps.linksBase}/n/s/${slug}` : viewUrl(deps, contract, null)),
  ])
  await editCard(ctx, deps, html, kb)
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

const LIST_TITLE: Record<string, string> = { m: "Minting now", u: "Upcoming" }
const LIST_EMPTY: Record<string, string> = { m: GAP.noMinting, u: GAP.noUpcoming }

async function showList(ctx: Context, deps: BotDeps, code: string): Promise<void> {
  const rows = await listRows(deps, ctx, code)
  const title = `<b>${LIST_TITLE[code] ?? "NFTs"}</b>`
  if (rows === null) return void (await show(ctx, GAP.loading, [[btn("Back", "nfts")]]))
  const back: Kb = [[btn("Back", "nfts")]]
  if (rows.length === 0) return void (await show(ctx, `${title}\n${LIST_EMPTY[code]}`, back))
  await show(ctx, title, [...rows.map((r) => [btn(r.label, `nc:${r.contract}:${code}`)]), ...back])
}

/** `/nft <collection> [window]` and the pick list: sends the card, the pick list or the reason there is none. */
async function nftCommand(ctx: Context, deps: BotDeps, text: string): Promise<void> {
  const state = deps.nft?.()
  if (!state) return void (await show(ctx, GAP.loading))
  if (!text.trim()) return void (await show(ctx, GAP.nfts))
  const q = parseNftQuery(state, text)
  await openMatch(ctx, deps, state, q.contract, text, q.window ?? "24h")
}

async function openMatch(
  ctx: Context,
  deps: BotDeps,
  state: NonNullable<ReturnType<NonNullable<BotDeps["nft"]>>>,
  m: Match,
  text: string,
  win: Window,
): Promise<void> {
  if (m.kind === "short") return void (await show(ctx, SHORT))
  if (m.kind === "none") return void (await show(ctx, GAP.none))
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
  if (lnk && "contract" in lnk) return false
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
  bot.callbackQuery(/^nc:(0x[0-9a-f]{40})(?::([a-z0-9]+))?$/, (ctx) =>
    sendCard(ctx, deps, ctx.match[1]!, "24h", ctx.match[2]),
  )
  bot.callbackQuery(/^nw:(0x[0-9a-f]{40}):(1h|24h|7d|30d)(?::([a-z0-9]+))?$/, (ctx) =>
    windowCard(ctx, deps, ctx.match[1]!, ctx.match[2] as Window, ctx.match[3]),
  )
  bot.callbackQuery(/^nr:(0x[0-9a-f]{40}):([0-9]{1,4})(?::([a-z0-9]+))?$/, (ctx) =>
    salesPage(ctx, deps, ctx.match[1]!, Math.max(1, Number(ctx.match[2])), ctx.match[3]),
  )
  bot.callbackQuery(/^nl:(m|u)$/, (ctx) => showList(ctx, deps, ctx.match[1]!))
}

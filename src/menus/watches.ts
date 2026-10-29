import type { Bot, Context } from "grammy"
import type { InlineKeyboardButton } from "grammy/types"
import { logAction } from "../actions"
import { quoteUnits } from "../cards/money"
import { clean, escapeHtml } from "../format"
import { lastMarketOf, launchOf } from "../history"
import { makeNftAlertCard } from "../nft/card"
import { matchCollection } from "../nft/match"
import type { NftState } from "../nft/state"
import {
  muteCollection,
  mutesOf,
  type Owner,
  remind,
  unmuteCollection,
  unremind,
  unwatch,
  viewerState,
  watch,
  watchesOf,
} from "../nft/watches"
import { classify } from "../platforms/telegram/errors"
import { btn, btnOn, findAddress, isAdmin, type Kb, show, stateBtn } from "../platforms/telegram/ui"
import { findTokens } from "../tokens"
import { chatKind, chatTitle, NOT_ADMIN } from "./alerts"
import { chatCode } from "./chat-code"
import {
  dm,
  NOT_FOUND,
  popup,
  TARGET_BAD_AMOUNT,
  TARGET_NO_PRICE,
  TARGET_PICK,
  TARGET_REPLACED,
  TARGET_SET,
  TARGET_TOKENS_ONLY,
  WATCH_LIMIT,
  WATCH_USAGE,
} from "./copy"
import type { BotDeps } from "./deps"
import { COPY, openMatch } from "./nft"
import { ensureUser, findUser, NO_USER, type User } from "./users"
import {
  addChatWatch,
  addWatch,
  replyHere,
  setTarget,
  watchToken,
  watchTokenForChat,
} from "./watchlist"
import { sendWelcome } from "./welcome"

const WATCHED_INTRO =
  "These are all the NFT collections you are currently watching. If you no longer wish to receive alerts for these, simply click Remove next to each collection."
const WATCHED_EMPTY =
  "You're not watching anything yet. Tap Watch on any alert or card to add it here."
const MUTED_INTRO = "I won't send you any alerts about these. Tap Unmute to undo."
const MUTED_EMPTY = "You haven't muted anything."

/** A list button: names are cut to 17 characters plus … when longer than 18. */
export const cutName = (name: string): string => {
  const c = [...name]
  return c.length > 18 ? `${c.slice(0, 17).join("")}…` : name
}

/** The collection's cleaned name, or its short address when MAKO has no snapshot. */
export function collectionName(deps: Pick<BotDeps, "nft">, contract: string): string {
  const col = deps.nft?.()?.get(contract)?.col ?? null
  return makeNftAlertCard("minted", "", col, [], { contract }).name
}

type St = { watching: boolean; muted: boolean; reminded: boolean }

/** Redraws the Watch, Mute and Remind me buttons of the tapped message from the viewer's state. */
async function restyle(ctx: Context, contract: string, st: St): Promise<void> {
  const kb = ctx.callbackQuery?.message?.reply_markup?.inline_keyboard
  if (!kb) return
  const re = new RegExp(`^(nwa|nws|nm|nmu|nrm|nrr):${contract}$`)
  const next = kb.map((row) =>
    row.map((b): InlineKeyboardButton => {
      const kind = "callback_data" in b ? re.exec(b.callback_data)?.[1] : undefined
      if (kind === "nwa" || kind === "nws")
        return stateBtn(
          { on: st.watching, off: "Watch", onText: "Watching" },
          `${st.watching ? "nws" : "nwa"}:${contract}`,
        )
      if (kind === "nm" || kind === "nmu")
        return stateBtn(
          { on: st.muted, off: "Mute", onText: "Muted" },
          `${st.muted ? "nmu" : "nm"}:${contract}`,
        )
      if (kind === "nrm" || kind === "nrr")
        return stateBtn(
          { on: st.reminded, off: "Remind me", onText: "Reminder set" },
          `${st.reminded ? "nrr" : "nrm"}:${contract}`,
        )
      return b
    }),
  )
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: next } }).catch((err) => {
    if (classify(err).kind !== "not_modified") throw err
  })
}

const watchKb = (c: string, on: boolean): Kb => [
  [
    stateBtn({ on, off: "Watch", onText: "Watching" }, `${on ? "nws" : "nwa"}:${c}`),
    btn("My alerts", "al:u"),
  ],
]

/** A DM: a pop-up for the tapped button, and the buttons of that message redrawn. */
function tap(
  deps: BotDeps,
  run: (user: User, contract: string, name: string) => Promise<{ text: string; edit: boolean }>,
) {
  return async (ctx: Context & { match: string | RegExpMatchArray }) => {
    // A tap on an old button never creates a user.
    const user = await findUser(deps.sql, ctx.from!.id)
    if (!user) return void (await ctx.answerCallbackQuery({ text: NO_USER, show_alert: true }))
    const contract = (ctx.match as RegExpMatchArray)[1]!
    const { text, edit } = await run(user, contract, collectionName(deps, contract))
    await ctx.answerCallbackQuery({ text }).catch(() => {})
    if (edit) await restyle(ctx, contract, await viewerState(deps.sql, user.id, contract))
  }
}

const log = (deps: BotDeps, action: string, contract: string) =>
  logAction(deps.sql, { chatType: "private", action, token: contract })

/** /start wn_<contract> and rn_<contract>: Watch or Remind me from a group alert. Sends the DM message. */
export async function nftDeepLink(
  ctx: Context,
  deps: BotDeps,
  user: User,
  kind: "wn" | "rn",
  contract: string,
): Promise<void> {
  const send = (html: string, kb?: Kb) =>
    ctx.reply(html, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}),
    })
  const state = deps.nft?.()
  if (!state) return void (await ctx.reply(COPY.loading))
  if (!state.get(contract)) return void (await ctx.reply(NOT_FOUND))
  const name = collectionName(deps, contract)
  if (kind === "rn") {
    await remind(deps.sql, user.id, contract)
    await log(deps, "remind", contract)
    await send(dm.reminderSet(name), [[btnOn("Reminder set", `nrr:${contract}`)]])
    return
  }
  const r = await watch(deps.sql, { userId: user.id }, contract)
  if (r === "limit") return void (await ctx.reply(WATCH_LIMIT))
  if (r === "added") await log(deps, "watch_nft", contract)
  await send(
    r === "added" ? dm.watching(name, "nft") : dm.alreadyWatching(name),
    watchKb(contract, true),
  )
}

type ListView = {
  owner: Owner
  title: string
  back: string
  /** The callback data of a row's name and Remove buttons. */
  open: (contract: string) => string
  remove: (contract: string) => string
}

async function watchedScreen(ctx: Context, deps: BotDeps, v: ListView) {
  const list = await watchesOf(deps.sql, v.owner)
  const back = [btn("Back", v.back)]
  if (list.length === 0) return show(ctx, `${v.title}\n${WATCHED_EMPTY}`, [back])
  await show(ctx, `${v.title}\n${WATCHED_INTRO}`, [
    ...list.map((c) => [
      btn(cutName(collectionName(deps, c)), v.open(c)),
      btn("Remove", v.remove(c)),
    ]),
    back,
  ])
}

/** A group's Watched NFTs, shown in an admin's DM (never in the group). Live admin check on every tap. */
async function groupWatchedScreen(
  ctx: Context,
  deps: BotDeps,
  chatId: string,
  remove?: string,
): Promise<void> {
  if (!(await isAdmin(ctx.api, chatId, ctx.from!.id))) {
    await ctx.answerCallbackQuery({ text: NOT_ADMIN, show_alert: true }).catch(() => {})
    return
  }
  const owner = { chatId }
  if (remove) {
    await unwatch(deps.sql, owner, remove)
    await logAction(deps.sql, {
      chatType: await chatKind(deps.sql, chatId),
      chatId,
      action: "unwatch_nft",
      token: remove,
    })
    await ctx
      .answerCallbackQuery({ text: popup.stop(collectionName(deps, remove)) })
      .catch(() => {})
  }
  await watchedScreen(ctx, deps, {
    owner,
    title: `<b>Watched NFTs for ${escapeHtml(await chatTitle(ctx, chatId))}</b>`,
    back: `al:${chatId}`,
    open: (c) => `nc:${c}:z${chatCode(chatId)}`,
    remove: (c) => `gl:${chatId}:n:${c}`,
  })
}

async function mutedScreen(ctx: Context, deps: BotDeps, owner: Owner) {
  const list = await mutesOf(deps.sql, owner)
  const back = [btn("Back", "al:u")]
  if (list.length === 0) return show(ctx, `<b>Muted NFTs</b>\n${MUTED_EMPTY}`, [back])
  await show(ctx, `<b>Muted NFTs</b>\n${MUTED_INTRO}`, [
    ...list.map((c) => [
      btn(cutName(collectionName(deps, c)), `nc:${c}:x`),
      btn("Unmute", `nml:um:${c}`),
    ]),
    back,
  ])
}

const AMOUNT = /^\$?(\d+(?:\.\d+)?)([km])?$/i

/**
 * `/watch <token> [amount]`. The last word is a USD amount when it has a `$`, a `k`/`m` suffix or a value of at
 * least 1,000, so a name ending in a small number (`pepe 2`) stays a name. A last word that starts like an amount
 * but isn't one (`500x`, `$5oo`), or is under one dollar, is a bad amount.
 */
export function parseWatchArgs(text: string): {
  query: string
  targetUsd: number | null
  badAmount: boolean
} {
  const words = text.trim().split(/\s+/).filter(Boolean)
  const query = words.join(" ")
  const last = words.at(-1) ?? ""
  if (words.length < 2 || /^0x[0-9a-f]{40}$/i.test(last))
    return { query, targetUsd: null, badAmount: false }
  const m = AMOUNT.exec(last)
  if (!m) return { query, targetUsd: null, badAmount: /^\$?\d/.test(last) }
  const value = Number(m[1])
  const unit = m[2]?.toLowerCase()
  if (!last.startsWith("$") && !unit && value < 1000)
    return { query, targetUsd: null, badAmount: false }
  // Whole dollars, so a typed target and a tapped pick (whose button carries whole dollars) store the same value.
  const targetUsd = Math.round(value * (unit === "k" ? 1e3 : unit === "m" ? 1e6 : 1))
  if (targetUsd <= 0) return { query, targetUsd: null, badAmount: true }
  return { query: words.slice(0, -1).join(" "), targetUsd, badAmount: false }
}

/** A collection whose slug or whole name is the query, not one that only contains it. */
const exactCollection = (state: NftState, q: string) => state.matches(q).some((m) => m.tier <= 2)

const shortCa = (ca: string) => `${ca.slice(0, 6)}…${ca.slice(-4)}`

/**
 * Watches a token with a market cap target, for the user in a DM or for the chat in a group, and sends one reply.
 * A typed command may create the user; a tap on the pick list may not.
 */
async function watchWithTarget(
  ctx: Context,
  deps: BotDeps,
  ca: string,
  targetUsd: number,
  fresh: boolean,
): Promise<void> {
  const l = (await launchOf(deps.sql, ca))!
  const name = clean(l.p.name, 64) || `$${clean(l.p.ticker, 32) || "?"}`
  const market = await lastMarketOf(deps.sql, ca)
  const price = market ? deps.prices.usd(market.quote) : null
  if (!market || price === null) return void (await replyHere(ctx, TARGET_NO_PRICE(name), false))
  const nowUsd = quoteUnits(market.marketCap) * price
  if (ctx.chat?.type === "private") {
    const found = fresh
      ? await ensureUser(deps.sql, ctx.from!.id)
      : { user: await findUser(deps.sql, ctx.from!.id), created: false }
    if (!found.user) return void (await ctx.reply(NO_USER))
    if ((await addWatch(deps, found.user, ca)) === "limit")
      return void (await ctx.reply(WATCH_LIMIT))
    const old = await setTarget(deps, { userId: found.user.id }, ca, targetUsd, nowUsd)
    await ctx.reply(
      old === null
        ? TARGET_SET(name, targetUsd, nowUsd)
        : TARGET_REPLACED(name, targetUsd, old, nowUsd),
    )
    // Action first, then the welcome card, as /start does for deep links.
    if (found.created) await sendWelcome(ctx, found.user.settings)
    return
  }
  const chatId = String(ctx.chat!.id)
  if ((await addChatWatch(deps, chatId, ca)) === "limit")
    return void (await replyHere(ctx, WATCH_LIMIT))
  const old = await setTarget(deps, { chatId }, ca, targetUsd, nowUsd)
  await replyHere(
    ctx,
    old === null
      ? TARGET_SET(name, targetUsd, nowUsd)
      : TARGET_REPLACED(name, targetUsd, old, nowUsd),
    false,
  )
}

/** Watches one token, with or without a target. */
async function watchOne(
  ctx: Context,
  deps: BotDeps,
  ca: string,
  targetUsd: number | null,
  fresh: boolean,
): Promise<void> {
  if (targetUsd !== null) return watchWithTarget(ctx, deps, ca, targetUsd, fresh)
  if (ctx.chat?.type !== "private") return watchTokenForChat(ctx, deps, ca)
  if (!fresh && !(await findUser(deps.sql, ctx.from!.id))) return void (await ctx.reply(NO_USER))
  return watchToken(ctx, deps, ca)
}

/**
 * /watch <token or collection> [amount]: in a DM for the user, in a group for the chat (admins only). A token is
 * found by address, ticker or name; an amount sets a market cap target on the token's watch.
 */
async function watchCommand(ctx: Context, deps: BotDeps, raw: string): Promise<void> {
  const isDm = ctx.chat?.type === "private"
  const text = raw.trim()
  if (!text) return void (await ctx.reply(WATCH_USAGE))
  if (!isDm && !(await isAdmin(ctx.api, ctx.chat!.id, ctx.from!.id)))
    return void (await ctx.reply(NOT_ADMIN))
  const { query, targetUsd, badAmount } = parseWatchArgs(text)
  if (badAmount) return void (await replyHere(ctx, TARGET_BAD_AMOUNT, false))
  const ca = findAddress(query)
  if (ca && (await launchOf(deps.sql, ca))) return watchOne(ctx, deps, ca, targetUsd, true)
  // A plain name (no `$`, no amount) that is exactly a collection's name or slug watches the collection, as
  // /watch did before tokens could be named; `$TICKER` or an address picks the token.
  const plainName = !ca && targetUsd === null && !query.startsWith("$")
  const state = deps.nft?.()
  const collectionFirst = plainName && state !== undefined && exactCollection(state, query)
  const hits = ca || collectionFirst ? [] : await findTokens(deps.sql, query)
  if (hits.length === 1) return watchOne(ctx, deps, hits[0]!.token, targetUsd, true)
  if (hits.length > 1) {
    const bare = query.replace(/^\$/, "").toLowerCase()
    const byTicker = hits.find((t) => t.ticker?.toLowerCase() === bare)
    const called = byTicker ? `$${clean(byTicker.ticker, 32)}` : query
    const kb: Kb = hits.map((t) => [
      btn(
        `${clean(t.name, 20) || `$${clean(t.ticker, 20) || "?"}`} · ${shortCa(t.token)}`,
        `wt:${t.token}:${targetUsd === null ? 0 : Math.round(targetUsd)}`,
      ),
    ])
    // The typed command may create the user, so the tap that follows finds one; taps never create users.
    const fresh = isDm ? await ensureUser(deps.sql, ctx.from!.id) : null
    await ctx.reply(TARGET_PICK(called), {
      reply_markup: { inline_keyboard: kb },
      message_thread_id:
        ctx.msg && "is_topic_message" in ctx.msg && ctx.msg.is_topic_message
          ? ctx.msg.message_thread_id
          : undefined,
    })
    // Action first, then the welcome card, as /start does for deep links.
    if (fresh?.created) await sendWelcome(ctx, fresh.user.settings)
    return
  }
  if (!state) return void (await ctx.reply(COPY.loading))
  const m = matchCollection(state, text)
  // A market cap target is for tokens: a collection named with an amount is refused, not watched.
  if (targetUsd !== null && (m.kind === "one" || matchCollection(state, query).kind === "one"))
    return void (await replyHere(ctx, TARGET_TOKENS_ONLY, false))
  if (m.kind !== "one") return openMatch(ctx, deps, state, m, text, "24h")
  const contract = m.contract
  const name = collectionName(deps, contract)
  if (isDm) {
    const { user, created } = await ensureUser(deps.sql, ctx.from!.id)
    const r = await watch(deps.sql, { userId: user.id }, contract)
    if (r === "limit") return void (await ctx.reply(WATCH_LIMIT))
    if (r === "added") await log(deps, "watch_nft", contract)
    await ctx.reply(r === "added" ? dm.watching(name, "nft") : dm.alreadyWatching(name), {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: watchKb(contract, true) },
    })
    // Action first, then the welcome card, as /start does for deep links.
    if (created) await sendWelcome(ctx, user.settings)
    return
  }
  const chatId = String(ctx.chat!.id)
  const r = await watch(deps.sql, { chatId }, contract)
  if (r === "limit") return void (await ctx.reply(WATCH_LIMIT))
  if (r === "added")
    await logAction(deps.sql, {
      chatType: ctx.chat!.type as "group",
      chatId,
      action: "watch_nft",
      token: contract,
    })
  await ctx.reply(r === "added" ? dm.groupWatching(name) : dm.alreadyWatching(name), {
    parse_mode: "HTML",
    message_thread_id:
      ctx.msg && "is_topic_message" in ctx.msg && ctx.msg.is_topic_message
        ? ctx.msg.message_thread_id
        : undefined,
  })
}

export function registerWatches(bot: Bot, deps: BotDeps): void {
  const pm = bot.chatType("private")
  const c = "(0x[0-9a-f]{40})"
  pm.callbackQuery(
    new RegExp(`^nwa:${c}$`),
    tap(deps, async (u, contract, name) => {
      const r = await watch(deps.sql, { userId: u.id }, contract)
      if (r === "limit") return { text: WATCH_LIMIT, edit: false }
      if (r === "added") await log(deps, "watch_nft", contract)
      return { text: popup.watch(name), edit: true }
    }),
  )
  pm.callbackQuery(
    new RegExp(`^nws:${c}$`),
    tap(deps, async (u, contract, name) => {
      await unwatch(deps.sql, { userId: u.id }, contract)
      await log(deps, "unwatch_nft", contract)
      return { text: popup.stop(name), edit: true }
    }),
  )
  pm.callbackQuery(
    new RegExp(`^nm:${c}$`),
    tap(deps, async (u, contract, name) => {
      const { wasWatching } = await muteCollection(deps.sql, { userId: u.id }, contract)
      await log(deps, "mute_collection", contract)
      return { text: wasWatching ? popup.muteUnwatched(name) : popup.mute(name), edit: true }
    }),
  )
  pm.callbackQuery(
    new RegExp(`^nmu:${c}$`),
    tap(deps, async (u, contract, name) => {
      await unmuteCollection(deps.sql, { userId: u.id }, contract)
      await log(deps, "unmute_collection", contract)
      return { text: popup.unmute(name), edit: true }
    }),
  )
  pm.callbackQuery(
    new RegExp(`^nrm:${c}$`),
    tap(deps, async (u, contract) => {
      await remind(deps.sql, u.id, contract)
      await log(deps, "remind", contract)
      return { text: popup.remind(), edit: true }
    }),
  )
  pm.callbackQuery(
    new RegExp(`^nrr:${c}$`),
    tap(deps, async (u, contract, name) => {
      await unremind(deps.sql, u.id, contract)
      await log(deps, "unremind", contract)
      return { text: popup.unremind(name), edit: true }
    }),
  )

  // Watched NFTs, in the DM only. A group's list is under its settings: gl:<chatId>:n.
  const mine = async (ctx: Context, contract?: string) => {
    const user = await findUser(deps.sql, ctx.from!.id)
    if (!user) return void (await show(ctx, NO_USER))
    if (contract) {
      await unwatch(deps.sql, { userId: user.id }, contract)
      await log(deps, "unwatch_nft", contract)
      await ctx
        .answerCallbackQuery({ text: popup.stop(collectionName(deps, contract)) })
        .catch(() => {})
    }
    await watchedScreen(ctx, deps, {
      owner: { userId: user.id },
      title: "<b>Watched NFTs</b>",
      back: "al:u",
      open: (c) => `nc:${c}:w`,
      remove: (c) => `nwl:rm:${c}`,
    })
  }
  pm.callbackQuery("nwl", (ctx) => mine(ctx))
  pm.callbackQuery(new RegExp(`^nwl:rm:${c}$`), (ctx) =>
    mine(ctx, (ctx.match as RegExpMatchArray)[1]),
  )
  pm.callbackQuery(/^gl:(-?\d+):n$/, (ctx) => groupWatchedScreen(ctx, deps, ctx.match[1]!))
  pm.callbackQuery(new RegExp(`^gl:(-?\\d+):n:${c}$`), (ctx) =>
    groupWatchedScreen(ctx, deps, ctx.match[1]!, ctx.match[2]),
  )
  pm.callbackQuery("nml", async (ctx) => {
    const user = await findUser(deps.sql, ctx.from.id)
    if (!user) return show(ctx, NO_USER)
    await mutedScreen(ctx, deps, { userId: user.id })
  })
  pm.callbackQuery(new RegExp(`^nml:um:${c}$`), async (ctx) => {
    const user = await findUser(deps.sql, ctx.from.id)
    if (!user) return show(ctx, NO_USER)
    const contract = (ctx.match as RegExpMatchArray)[1]!
    await unmuteCollection(deps.sql, { userId: user.id }, contract)
    await log(deps, "unmute_collection", contract)
    await ctx
      .answerCallbackQuery({ text: popup.unmute(collectionName(deps, contract)) })
      .catch(() => {})
    await mutedScreen(ctx, deps, { userId: user.id })
  })

  bot.command("watch", (ctx) => watchCommand(ctx, deps, ctx.match))
  // A pick from /watch's list of tokens with one name: `wt:<token>:<target in USD, or 0 for none>`.
  bot.callbackQuery(/^wt:(0x[0-9a-f]{40}):(\d+)$/, async (ctx) => {
    const chat = ctx.callbackQuery.message?.chat
    if (!chat) return void (await ctx.answerCallbackQuery())
    if (chat.type !== "private" && !(await isAdmin(ctx.api, chat.id, ctx.from.id)))
      return void (await ctx.answerCallbackQuery({ text: NOT_ADMIN, show_alert: true }))
    await ctx.answerCallbackQuery().catch(() => {})
    const ca = ctx.match[1]!
    if (!(await launchOf(deps.sql, ca))) return void (await ctx.reply(NOT_FOUND))
    const usd = Number(ctx.match[2])
    await watchOne(ctx, deps, ca, usd > 0 ? usd : null, false)
  })
}

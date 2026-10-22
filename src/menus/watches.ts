import type { Bot, Context } from "grammy"
import type { InlineKeyboardButton } from "grammy/types"
import { logAction } from "../actions"
import { clean, escapeHtml } from "../format"
import { launchOf } from "../history"
import { makeNftAlertCard } from "../nft/card"
import { matchCollection } from "../nft/match"
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
import { NOT_ADMIN } from "./alerts"
import { dm, NOT_FOUND, popup, WATCH_LIMIT, WATCH_USAGE } from "./copy"
import type { BotDeps } from "./deps"
import { COPY, openMatch } from "./nft"
import { ensureUser, findUser, NO_USER, type User } from "./users"
import { watchToken } from "./watchlist"
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

/** Who a Watched list belongs to: the user in a DM, the chat in a group (admins only). */
async function ownerOf(ctx: Context, deps: BotDeps): Promise<{ owner: Owner; dm: boolean } | null> {
  if (ctx.chat?.type === "private") {
    const user = await findUser(deps.sql, ctx.from!.id)
    if (!user) {
      await show(ctx, NO_USER)
      return null
    }
    return { owner: { userId: user.id }, dm: true }
  }
  if (!(await isAdmin(ctx.api, ctx.chat!.id, ctx.from!.id))) {
    await ctx.answerCallbackQuery({ text: NOT_ADMIN, show_alert: true }).catch(() => {})
    return null
  }
  return { owner: { chatId: String(ctx.chat!.id) }, dm: false }
}

async function watchedScreen(ctx: Context, deps: BotDeps, who: { owner: Owner; dm: boolean }) {
  const list = await watchesOf(deps.sql, who.owner)
  const title = who.dm
    ? "<b>Watched NFTs</b>"
    : `<b>Watched NFTs for ${escapeHtml(clean(ctx.chat?.title, 64))}</b>`
  const back = [btn("Back", who.dm ? "al:u" : "gs")]
  if (list.length === 0) return show(ctx, `${title}\n${WATCHED_EMPTY}`, [back])
  await show(ctx, `${title}\n${WATCHED_INTRO}`, [
    ...list.map((c) => [
      btn(cutName(collectionName(deps, c)), `nc:${c}:w`),
      btn("Remove", `nwl:rm:${c}`),
    ]),
    back,
  ])
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

/**
 * /watch <collection>: in a DM for the user, in a group for the chat (admins only). A token address in a
 * DM watches the token.
 */
async function watchCommand(ctx: Context, deps: BotDeps, raw: string): Promise<void> {
  const isDm = ctx.chat?.type === "private"
  const text = raw.trim()
  if (!text) return void (await ctx.reply(WATCH_USAGE))
  if (!isDm && !(await isAdmin(ctx.api, ctx.chat!.id, ctx.from!.id)))
    return void (await ctx.reply(NOT_ADMIN))
  const ca = findAddress(text)
  if (isDm && ca && (await launchOf(deps.sql, ca))) return watchToken(ctx, deps, text)
  const state = deps.nft?.()
  if (!state) return void (await ctx.reply(COPY.loading))
  const m = matchCollection(state, text)
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

  // Watched NFTs: the user's in a DM, the chat's in a group (admins only).
  bot.callbackQuery("nwl", async (ctx) => {
    const who = await ownerOf(ctx, deps)
    if (who) await watchedScreen(ctx, deps, who)
  })
  bot.callbackQuery(new RegExp(`^nwl:rm:${c}$`), async (ctx) => {
    const who = await ownerOf(ctx, deps)
    if (!who) return
    const contract = (ctx.match as RegExpMatchArray)[1]!
    await unwatch(deps.sql, who.owner, contract)
    await logAction(deps.sql, {
      chatType: ctx.chat!.type === "private" ? "private" : (ctx.chat!.type as "group"),
      chatId: ctx.chat!.id,
      action: "unwatch_nft",
      token: contract,
    })
    await ctx
      .answerCallbackQuery({ text: popup.stop(collectionName(deps, contract)) })
      .catch(() => {})
    await watchedScreen(ctx, deps, who)
  })
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
}

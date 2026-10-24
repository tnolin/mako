import type { Bot } from "grammy"
import { age, clean, count, escapeHtml } from "../format"
import { hotNow, justBonded, launchesOf, nearBonding } from "../history"
import { btn, type Kb, show } from "../platforms/telegram/ui"
import type { BotDeps } from "./deps"

export const EMPTY = {
  hot: "Nothing traded in the last 7 days.",
  near: "No tokens at 10% or more traded in the last 7 days.",
  bonded: "No tokens have bonded yet.",
} as const
const TITLE = { hot: "Hot now", near: "Near bonding", bonded: "Recently bonded" } as const
type Kind = keyof typeof EMPTY
type Entry = { token: string; detail: string }

async function entries(deps: BotDeps, kind: Kind): Promise<{ title: string; list: Entry[] }> {
  if (kind === "hot") {
    const { window, rows } = await hotNow(deps.sql)
    return {
      title: `${TITLE.hot} (${window})`,
      list: rows.map((r) => ({
        token: r.token,
        detail: `${count(r.trades)} trade${r.trades === 1 ? "" : "s"} (${window})`,
      })),
    }
  }
  if (kind === "near") {
    return {
      title: TITLE.near,
      list: (await nearBonding(deps.sql)).map((r) => ({
        token: r.token,
        detail: `${Math.floor(r.soldBps / 100)}%`,
      })),
    }
  }
  const now = Math.floor(Date.now() / 1000)
  return {
    title: TITLE.bonded,
    list: (await justBonded(deps.sql)).map((r) => ({
      token: r.p.token,
      detail: `bonded ${age(now - r.p.blockTimestamp)} ago`,
    })),
  }
}

/** A discovery screen: its HTML and keyboard. Read-only; never touches a user row. */
export async function listScreen(deps: BotDeps, kind: Kind): Promise<{ html: string; kb: Kb }> {
  const { title, list: all } = await entries(deps, kind)
  // A list ends with Back to the Tokens screen, and its rows open a card with Back to the list.
  const menu: Kb = [[btn("Back", "tk")]]
  const meta = await launchesOf(
    deps.sql,
    all.map((e) => e.token),
  )
  const ticker = (t: string) => clean(meta.get(t)?.ticker, 32)
  const name = (t: string) => clean(meta.get(t)?.name, 64)
  // A token without a name and a ticker has nothing to show, so it is left out.
  const list = all.filter((e) => ticker(e.token) && name(e.token))
  if (list.length === 0) return { html: `<b>${TITLE[kind]}</b>\n${EMPTY[kind]}`, kb: menu }
  const label = (t: string) => `$${ticker(t)}`
  const lines = list.map(
    (e, i) =>
      `${i + 1}. ${escapeHtml(label(e.token))} · ${escapeHtml(name(e.token))} · ${e.detail}`,
  )
  return {
    html: [`<b>${title}</b>`, ...lines].join("\n"),
    kb: [...list.map((e) => [btn(label(e.token), `t:${e.token}:${kind}`)]), ...menu],
  }
}

export function registerLists(bot: Bot, deps: BotDeps): void {
  bot.callbackQuery(/^l:(hot|near|bonded)$/, async (ctx) => {
    const { html, kb } = await listScreen(deps, ctx.match[1] as Kind)
    await show(ctx, html, kb)
  })
}

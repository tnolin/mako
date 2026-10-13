import type { Bot } from "grammy"
import { age, clean, count, escapeHtml } from "../format"
import { hotNow, justBonded, launchesOf, nearBonding } from "../history"
import { btn, type Kb, show } from "../platforms/telegram/ui"
import type { BotDeps } from "./deps"

export const EMPTY = {
  hot: "Nothing traded in the last hour.",
  near: "No curve tokens traded in the last 24 hours.",
  bonded: "No tokens have bonded yet.",
} as const
const TITLE = { hot: "Hot now", near: "Near bonding", bonded: "Just bonded" } as const
type Kind = keyof typeof EMPTY

async function entries(deps: BotDeps, kind: Kind): Promise<{ token: string; detail: string }[]> {
  if (kind === "hot") {
    return (await hotNow(deps.sql)).map((r) => ({
      token: r.token,
      detail: `${count(r.trades)} trade${r.trades === 1 ? "" : "s"} (1h)`,
    }))
  }
  if (kind === "near") {
    return (await nearBonding(deps.sql)).map((r) => ({
      token: r.token,
      detail: `${Math.floor(r.soldBps / 100)}%`,
    }))
  }
  const now = Math.floor(Date.now() / 1000)
  return (await justBonded(deps.sql)).map((r) => ({
    token: r.p.token,
    detail: `bonded ${age(now - r.p.blockTimestamp)} ago`,
  }))
}

export function registerLists(bot: Bot, deps: BotDeps): void {
  // Read-only screens: they never create or touch a user row.
  bot.callbackQuery(/^l:(hot|near|bonded)$/, async (ctx) => {
    const kind = ctx.match[1] as Kind
    const list = await entries(deps, kind)
    const menu: Kb = [[btn("Menu", "m")]]
    if (list.length === 0) {
      await show(ctx, `<b>${TITLE[kind]}</b>\n${EMPTY[kind]}`, menu)
      return
    }
    const meta = await launchesOf(
      deps.sql,
      list.map((e) => e.token),
    )
    const label = (t: string) => `$${clean(meta.get(t)?.ticker, 32) || "?"}`
    const lines = list.map(
      (e, i) =>
        `${i + 1}. ${escapeHtml(label(e.token))} · ${escapeHtml(clean(meta.get(e.token)?.name, 64))} · ${e.detail}`,
    )
    await show(ctx, [`<b>${TITLE[kind]}</b>`, ...lines].join("\n"), [
      ...list.map((e) => [btn(label(e.token), `t:${e.token}`)]),
      ...menu,
    ])
  })
}

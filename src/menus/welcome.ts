import type { Context } from "grammy"
import { btn, type Kb } from "../platforms/telegram/ui"
import { ALERT_HELP, ALERT_LABEL, ALERTS, type Settings } from "../settings"

export function welcomeText(): string {
  const w = Math.max(...ALERTS.map((a) => ALERT_LABEL[a].length)) + 2
  return [
    "<b>MAKO</b> · real-time alerts for Ink memecoins",
    "",
    "Your alerts:",
    ...ALERTS.map((a) => `<code>${ALERT_LABEL[a].padEnd(w)}${ALERT_HELP[a]}</code>`),
    "",
    "Tap an alert to turn it on or off. Thresholds and images are in My alerts.",
  ].join("\n")
}

export function welcomeKb(s: Settings): Kb {
  const toggles = ALERTS.map((a) =>
    btn(`${s.alerts[a].on ? "✓" : "·"} ${ALERT_LABEL[a]}`, `ob:${a}`),
  )
  const rows: Kb = []
  for (let i = 0; i < toggles.length; i += 2) rows.push(toggles.slice(i, i + 2))
  rows.push([btn("Turn all off", "ob:off"), btn("Done → menu", "ob:done")])
  return rows
}

/** The onboarding card for a user who was just created. */
export async function sendWelcome(ctx: Context, settings: Settings): Promise<void> {
  await ctx.reply(welcomeText(), {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: welcomeKb(settings) },
  })
}

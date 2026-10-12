import type { Bot, Context } from "grammy"
import type { BotDeps } from "./deps"

export async function openChatSettings(
  _ctx: Context,
  _deps: BotDeps,
  _chatId: string,
): Promise<void> {}
export function registerAlerts(_bot: Bot, _deps: BotDeps): void {}

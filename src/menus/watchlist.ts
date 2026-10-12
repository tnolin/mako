import type { Bot, Context } from "grammy"
import type { BotDeps } from "./deps"

export async function watchToken(_ctx: Context, _deps: BotDeps, _raw: string): Promise<void> {}
export function registerWatchlist(_bot: Bot, _deps: BotDeps): void {}

import { escapeHtml, usd } from "../format"

/**
 * Copy for the Watch, Mute and Remind me buttons, one function each, shared by tokens and NFTs. `name` is a token's `$TICKER` or a collection's cleaned name.
 * `popup.*` is plain text (a callback answer); `dm.*` is HTML for a message.
 */
export const popup = {
  watch: (name: string) => `Watching ${name}. I'll send you every alert for it.`,
  stop: (name: string) => `Stopped watching ${name}. It can still appear in your feeds.`,
  remind: () => "Reminder set. I'll message you 15 mins before each mint stage.",
  unremind: (name: string) => `Reminder removed for ${name}.`,
  mute: (name: string) => `Muted ${name}. I won't send you alerts about it.`,
  muteUnwatched: (name: string) => `Muted and unwatched ${name}.`,
  unmute: (name: string) => `Unmuted ${name}.`,
}

export const dm = {
  /** The first line is bold. */
  watching: (name: string, kind: "token" | "nft") =>
    `<b>Watching ${escapeHtml(name)}</b>\nI'll send you every alert for this ${kind === "token" ? "token" : "collection"} to your DMs.`,
  alreadyWatching: (name: string) => `You're already watching ${escapeHtml(name)}.`,
  reminderSet: (name: string) => `Reminder set for ${escapeHtml(name)}.`,
  /** An admin's /watch in a group. */
  groupWatching: (name: string) =>
    `Watching ${escapeHtml(name)}. I'll send every alert for it to this group.`,
}

export const NOT_FOUND =
  "I couldn't find a token or NFT with that name or address. Please confirm you have the right details and try again."

export const WATCH_LIMIT = "Watch limit reached."
export const WATCH_USAGE = "Send /watch followed by a token or NFT collection address."

/** `/watch <token> <amount>`. `name` is the token's name, plain text. Amounts are in USD. */
export const TARGET_SET = (name: string, target: number, now: number) =>
  target > now
    ? `Watching ${name}. I'll alert you when its market cap reaches ${usd(target)} (now ${usd(now)}).`
    : `Watching ${name}. I'll alert you when its market cap drops to ${usd(target)} (now ${usd(now)}).`
export const TARGET_REPLACED = (name: string, target: number, old: number, now: number) =>
  `${name}'s target is now ${usd(target)}, replacing ${usd(old)} (now ${usd(now)}).`
export const TARGET_NO_PRICE = (name: string) =>
  `I can't set a target for ${name} right now because I don't have a current price for it. Try again in a few minutes.`
export const TARGET_BAD_AMOUNT =
  "I couldn't read that amount. Try something like /watch $GOBLO 500k, 1.5m or $500000."
export const TARGET_TOKENS_ONLY =
  "Market cap alerts are for tokens only. Send /watch with the collection's name alone to watch it."
/** `called` is `$TICKER`, or the name as typed. */
export const TARGET_PICK = (called: string) => `More than one token is called ${called}. Which one?`

import { escapeHtml } from "../format"

/**
 * Owner copy for the Watch, Mute and Remind me buttons ("Button states" in the design notes), one function
 * each, shared by tokens and NFTs. `name` is a token's `$TICKER` or a collection's cleaned name.
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

/** Owner copy, 2026-10-23. */
export const NOT_FOUND =
  "I couldn't find a token or NFT with that name or address. Please confirm you have the right details and try again."

export const WATCH_LIMIT = "Watch limit reached."
export const WATCH_USAGE = "Send /watch followed by a token or NFT collection address."

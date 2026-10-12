import { GrammyError, HttpError } from "grammy"

export type FailureKind =
  | "retry_after"
  | "transient"
  | "blocked"
  | "removed"
  | "rights"
  | "topic"
  | "media"
  | "not_modified"
  | "migrated"
  | "other"

export type Failure = {
  kind: FailureKind
  description: string
  retryAfter?: number
  migrateTo?: number
}

/** Telegram's descriptions are the only signal for most failures; this table is the contract, tested case by case. */
const TABLE: [RegExp, FailureKind][] = [
  [/message is not modified/i, "not_modified"],
  [/bot was blocked by the user|user is deactivated/i, "blocked"],
  [/bot was kicked|bot is not a member|chat not found|CHANNEL_PRIVATE/i, "removed"],
  [
    /not enough rights|CHAT_WRITE_FORBIDDEN|CHAT_ADMIN_REQUIRED|need administrator rights|have no rights to send/i,
    "rights",
  ],
  [/TOPIC_CLOSED|TOPIC_DELETED|message thread not found/i, "topic"],
  [
    /wrong file identifier|failed to get HTTP URL content|wrong type of the web page content|IMAGE_PROCESS_FAILED|PHOTO_INVALID|WEBPAGE_MEDIA_EMPTY|wrong remote file/i,
    "media",
  ],
]

export function classify(err: unknown): Failure {
  if (err instanceof GrammyError) {
    const description = err.description
    if (err.error_code === 429)
      return { kind: "retry_after", description, retryAfter: err.parameters.retry_after ?? 5 }
    if (err.parameters.migrate_to_chat_id) {
      return { kind: "migrated", description, migrateTo: err.parameters.migrate_to_chat_id }
    }
    for (const [re, kind] of TABLE) if (re.test(description)) return { kind, description }
    if (err.error_code >= 500) return { kind: "transient", description }
    return { kind: "other", description }
  }
  if (err instanceof HttpError) return { kind: "transient", description: err.message }
  return { kind: "other", description: err instanceof Error ? err.message : String(err) }
}

import { GrammyError, HttpError } from "grammy"
import { expect, it } from "vitest"
import { classify } from "../src/platforms/telegram/errors"

const tg = (code: number, description: string, parameters: Record<string, number> = {}) =>
  new GrammyError(
    "call failed",
    { ok: false, error_code: code, description, parameters },
    "sendMessage",
    {},
  )

it.each([
  [429, "Too Many Requests: retry after 7", "retry_after"],
  [403, "Forbidden: bot was blocked by the user", "blocked"],
  [403, "Forbidden: user is deactivated", "blocked"],
  [403, "Forbidden: bot can't initiate conversation with a user", "blocked"],
  [403, "Forbidden: bot can't send messages to bots", "blocked"],
  [403, "Forbidden: bot was kicked from the supergroup chat", "removed"],
  [403, "Forbidden: bot is not a member of the channel chat", "removed"],
  [403, "Forbidden: the group chat was deleted", "removed"],
  [400, "Bad Request: chat not found", "removed"],
  [400, "Bad Request: not enough rights to send text messages to the chat", "rights"],
  [403, "Forbidden: CHAT_WRITE_FORBIDDEN", "rights"],
  [400, "Bad Request: CHAT_ADMIN_REQUIRED", "rights"],
  [400, "Bad Request: CHAT_RESTRICTED", "rights"],
  [400, "Bad Request: CHAT_SEND_PLAIN_FORBIDDEN", "rights"],
  [400, "Bad Request: CHAT_SEND_PHOTOS_FORBIDDEN", "rights"],
  [400, "Bad Request: TOPIC_CLOSED", "topic"],
  [400, "Bad Request: TOPIC_DELETED", "topic"],
  [400, "Bad Request: message thread not found", "topic"],
  [400, "Bad Request: failed to get HTTP URL content", "media"],
  [400, "Bad Request: wrong type of the web page content", "media"],
  [
    400,
    "Bad Request: message is not modified: specified new message content and reply markup are exactly the same",
    "not_modified",
  ],
  [502, "Bad Gateway", "transient"],
  [400, "Bad Request: can't parse entities", "other"],
  [400, "Bad Request: PEER_ID_INVALID", "other"],
])("classifies %i %s as %s", (code, description, kind) => {
  expect(classify(tg(code, description)).kind).toBe(kind)
})

it("classifies a retry_after response", () => {
  expect(classify(tg(429, "Too Many Requests", { retry_after: 7 })).kind).toBe("retry_after")
})

it("classifies a migration response", () => {
  expect(
    classify(
      tg(400, "Bad Request: group chat was upgraded to a supergroup chat", {
        migrate_to_chat_id: -100123,
      }),
    ).kind,
  ).toBe("migrated")
})

it("classifies a network failure as transient", () => {
  const err = new HttpError("Network request for 'sendMessage' failed!", new Error("ECONNRESET"))
  expect(classify(err).kind).toBe("transient")
})

it("carries retry_after and the migrated chat id", () => {
  expect(classify(tg(429, "Too Many Requests", { retry_after: 7 })).retryAfter).toBe(7)
  expect(
    classify(tg(400, "Bad Request: group chat was upgraded", { migrate_to_chat_id: -100123 }))
      .migrateTo,
  ).toBe(-100123)
})

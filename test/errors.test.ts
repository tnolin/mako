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
  [tg(429, "Too Many Requests: retry after 7", { retry_after: 7 }), "retry_after"],
  [tg(403, "Forbidden: bot was blocked by the user"), "blocked"],
  [tg(403, "Forbidden: user is deactivated"), "blocked"],
  [tg(403, "Forbidden: bot was kicked from the supergroup chat"), "removed"],
  [tg(403, "Forbidden: bot is not a member of the channel chat"), "removed"],
  [tg(400, "Bad Request: chat not found"), "removed"],
  [tg(400, "Bad Request: not enough rights to send text messages to the chat"), "rights"],
  [tg(403, "Forbidden: CHAT_WRITE_FORBIDDEN"), "rights"],
  [tg(400, "Bad Request: CHAT_ADMIN_REQUIRED"), "rights"],
  [tg(400, "Bad Request: TOPIC_CLOSED"), "topic"],
  [tg(400, "Bad Request: TOPIC_DELETED"), "topic"],
  [tg(400, "Bad Request: message thread not found"), "topic"],
  [tg(400, "Bad Request: failed to get HTTP URL content"), "media"],
  [tg(400, "Bad Request: wrong type of the web page content"), "media"],
  [
    tg(
      400,
      "Bad Request: message is not modified: specified new message content and reply markup are exactly the same",
    ),
    "not_modified",
  ],
  [
    tg(400, "Bad Request: group chat was upgraded to a supergroup chat", {
      migrate_to_chat_id: -100123,
    }),
    "migrated",
  ],
  [tg(502, "Bad Gateway"), "transient"],
  [
    new HttpError("Network request for 'sendMessage' failed!", new Error("ECONNRESET")),
    "transient",
  ],
  [tg(400, "Bad Request: can't parse entities"), "other"],
])("classifies %s", (err, kind) => {
  expect(classify(err).kind).toBe(kind)
})

it("carries retry_after and the migrated chat id", () => {
  expect(classify(tg(429, "Too Many Requests", { retry_after: 7 })).retryAfter).toBe(7)
  expect(
    classify(tg(400, "Bad Request: group chat was upgraded", { migrate_to_chat_id: -100123 }))
      .migrateTo,
  ).toBe(-100123)
})

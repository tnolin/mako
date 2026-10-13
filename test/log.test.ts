import { afterEach, expect, it, vi } from "vitest"
import { log } from "../src/log"

afterEach(() => vi.restoreAllMocks())

it("writes one JSON line with level, message, fields and bigints as strings", () => {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {})
  log("info", "poller batch", { events: 3, cursor: 12n })
  const line = JSON.parse(spy.mock.calls[0]?.[0] as string)
  expect(line).toMatchObject({ level: "info", msg: "poller batch", events: 3, cursor: "12" })
  expect(typeof line.t).toBe("string")
})

it("drops debug lines at the default level", () => {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {})
  log("debug", "noise")
  expect(spy).not.toHaveBeenCalled()
})

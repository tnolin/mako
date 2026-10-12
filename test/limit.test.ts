import { expect, it, vi } from "vitest"
import { createFailureLimiter } from "../src/delivery/limit"

function setup() {
  let t = 0
  const report = vi.fn()
  const lines: [string, string][] = []
  const limiter = createFailureLimiter({
    report,
    log: (level, msg) => void lines.push([level, msg]),
    now: () => t,
  })
  return { limiter, report, lines, advance: (ms: number) => (t += ms) }
}

it("reports 100 consecutive failures once", () => {
  const { limiter, report } = setup()
  for (let i = 0; i < 100; i++) limiter.fail("poller", new Error("db down"))
  expect(report).toHaveBeenCalledTimes(1)
})

it("reports again after 10 minutes of continued failure, per source", () => {
  const { limiter, report, advance } = setup()
  limiter.fail("poller", new Error("a"))
  limiter.fail("sender", new Error("b"))
  advance(9 * 60_000)
  limiter.fail("poller", new Error("a"))
  expect(report).toHaveBeenCalledTimes(2)
  advance(60_000)
  limiter.fail("poller", new Error("a"))
  expect(report).toHaveBeenCalledTimes(3)
})

it("logs one recovery line, then reports a new failure straight away", () => {
  const { limiter, report, lines } = setup()
  limiter.fail("poller", new Error("a"))
  limiter.fail("poller", new Error("a"))
  limiter.ok("poller")
  limiter.ok("poller")
  expect(lines.filter(([, m]) => m === "poller recovered")).toHaveLength(1)
  limiter.fail("poller", new Error("again"))
  expect(report).toHaveBeenCalledTimes(2)
})

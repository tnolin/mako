import { expect, it } from "vitest"
import { createHeartbeat } from "../src/heartbeat"

it("checks in ok while the indexer cursor moves and error after 10 static minutes", async () => {
  let t = 0
  let block: string | null = "100"
  const statuses: string[] = []
  const hb = createHeartbeat({
    readBlock: async () => block,
    checkIn: (s) => statuses.push(s),
    now: () => t,
  })
  await hb.tick()
  t += 9 * 60_000
  await hb.tick()
  t += 2 * 60_000
  await hb.tick()
  block = "101"
  t += 60_000
  await hb.tick()
  expect(statuses).toEqual(["ok", "ok", "error", "ok"])
})

it("checks in error when the cursor can't be read", async () => {
  const statuses: string[] = []
  const hb = createHeartbeat({
    readBlock: async () => {
      throw new Error("db down")
    },
    checkIn: (s) => statuses.push(s),
  })
  await hb.tick()
  expect(statuses).toEqual(["error"])
})

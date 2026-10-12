import { expect, it } from "vitest"
import { findAddress } from "../src/platforms/telegram/ui"

const LOWER = "0xd1a5a3b3c0ffee00112233445566778899aabbcc"
const CHECKSUMMED = "0xD1a5A3b3C0fFeE00112233445566778899AAbBcC"

it("lowercases checksummed addresses so they match event payloads", () => {
  expect(findAddress(CHECKSUMMED)).toBe(LOWER)
  expect(findAddress(`look at ${CHECKSUMMED}, please`)).toBe(LOWER)
  expect(findAddress(LOWER)).toBe(LOWER)
})

it("returns null when there is no address", () => {
  expect(findAddress(undefined)).toBeNull()
  expect(findAddress("0x1234")).toBeNull()
  expect(findAddress("hello")).toBeNull()
})

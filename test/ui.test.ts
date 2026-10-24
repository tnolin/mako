import { describe, expect, it } from "vitest"
import {
  btnOn,
  chosenBtn,
  findAddress,
  setButtonColours,
  stateBtn,
  toggleBtn,
} from "../src/platforms/telegram/ui"

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

describe("state buttons", () => {
  it("toggleBtn is green on and plain off", () => {
    expect(toggleBtn("BONDING", true, "x")).toEqual({
      text: "BONDING",
      callback_data: "x",
      style: "success",
    })
    expect(toggleBtn("BONDING", false, "x")).toEqual({ text: "BONDING", callback_data: "x" })
  })

  it("toggleBtn with textState adds on/off text", () => {
    expect(toggleBtn("BONDING", true, "x", { textState: true }).text).toBe("BONDING: on")
    expect(toggleBtn("BONDING", false, "x", { textState: true })).toEqual({
      text: "BONDING: off",
      callback_data: "x",
    })
  })

  it("stateBtn shows the state word when active", () => {
    const watch = { off: "Watch", onText: "Watching" }
    expect(stateBtn({ ...watch, on: false }, "w")).toEqual({ text: "Watch", callback_data: "w" })
    expect(stateBtn({ ...watch, on: true }, "w")).toEqual({
      text: "Watching",
      callback_data: "w",
      style: "success",
    })
  })

  it("chosenBtn is green when chosen and prefixes a dot with textState", () => {
    expect(chosenBtn("24h", true, "x")).toEqual({
      text: "24h",
      callback_data: "x",
      style: "success",
    })
    expect(chosenBtn("24h", false, "x")).toEqual({ text: "24h", callback_data: "x" })
    expect(chosenBtn("24h", true, "x", { textState: true }).text).toBe("· 24h")
    expect(chosenBtn("24h", false, "x", { textState: true }).text).toBe("24h")
  })

  it("setButtonColours(false) switches every helper to the text fallback", () => {
    setButtonColours(false)
    try {
      expect(toggleBtn("SWEEP", true, "x").text).toBe("SWEEP: on")
      expect(chosenBtn("1h", true, "x").text).toBe("· 1h")
      expect(stateBtn({ on: true, off: "Mute", onText: "Muted" }, "m").text).toBe("Muted")
    } finally {
      setButtonColours(true)
    }
  })

  it("no helper puts a check mark in a label", () => {
    const labels = [
      toggleBtn("A", true, "x").text,
      toggleBtn("A", true, "x", { textState: true }).text,
      stateBtn({ on: true, off: "Watch", onText: "Watching" }, "x").text,
      chosenBtn("A", true, "x", { textState: true }).text,
      btnOn("A", "x").text,
    ]
    for (const l of labels) expect(l).not.toMatch(/[✓✔]/)
  })
})

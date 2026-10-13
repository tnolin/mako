import { expect, it } from "vitest"
import {
  isPreviewHost,
  LAUNCHPADS,
  type Launchpad,
  launchpadNames,
  tradeLink,
  unknownTokenText,
} from "../src/launchpads"

const CA = "0x5ab27c4e9d1f03b8a6e2c5d7f940b1a8c3d6e3c8"

it("builds trade links with and without a referral code", () => {
  expect(tradeLink("inkypump", CA, { INKYPUMP_REF_CODE: "MAKO" })).toBe(
    `https://inkypump.com/ink/trade/${CA}?ref=MAKO`,
  )
  expect(tradeLink("inkypump", CA, {})).toBe(`https://inkypump.com/ink/trade/${CA}`)
})

it("falls back to the first launchpad for an unknown key", () => {
  expect(tradeLink("nope", CA, {})).toBe(`https://inkypump.com/ink/trade/${CA}`)
})

it("names launchpads from config only", () => {
  const two: Record<string, Launchpad> = {
    ...LAUNCHPADS,
    tsunami: {
      name: "Tsunami",
      tradeUrl: (ca) => `https://tsunami.example/${ca}`,
      refParam: "r",
      refEnv: "TSUNAMI_REF_CODE",
      previewHosts: [],
    },
  }
  expect(unknownTokenText()).toBe("Not a token on InkyPump. MAKO covers InkyPump launches for now.")
  expect(launchpadNames(two)).toBe("InkyPump or Tsunami")
  expect(unknownTokenText(two)).toBe(
    "Not a token on InkyPump or Tsunami. MAKO covers InkyPump or Tsunami launches for now.",
  )
})

it("recognises preview hosts", () => {
  expect(isPreviewHost("inkypump", "https://storage.inkypump.com/x.webp")).toBe(true)
  expect(isPreviewHost("inkypump", "https://ipfs.io/ipfs/x")).toBe(false)
  expect(isPreviewHost("inkypump", "not a url")).toBe(false)
})

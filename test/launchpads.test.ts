import { expect, it } from "vitest"
import {
  LAUNCHPADS,
  type Launchpad,
  launchpadNames,
  referralLink,
  TokenLaunchpads,
  tradeLink,
} from "../src/launchpads"

const CA = "0x5ab27c4e9d1f03b8a6e2c5d7f940b1a8c3d6e3c8"

it("builds trade links with and without a referral code", () => {
  expect(tradeLink("inkypump", CA, { INKYPUMP_REF_CODE: "MAKO" })).toBe(
    `https://inkypump.com/ink/trade/${CA}?ref=MAKO`,
  )
  expect(tradeLink("inkypump", CA, {})).toBe(`https://inkypump.com/ink/trade/${CA}`)
})

it("builds the referral join link, or the launchpad home without a code", () => {
  expect(referralLink("inkypump", { INKYPUMP_REF_CODE: "MAKO" })).toBe(
    "https://inkypump.com/ink/join/MAKO",
  )
  expect(referralLink("inkypump", {})).toBe("https://inkypump.com/ink")
})

it("falls back to the first launchpad for an unknown key", () => {
  expect(tradeLink("nope", CA, {})).toBe(`https://inkypump.com/ink/trade/${CA}`)
})

const two: Record<string, Launchpad> = {
  ...LAUNCHPADS,
  tsunami: {
    name: "Tsunami",
    tradeUrl: (ca) => `https://tsunami.example/${ca}`,
    refParam: "r",
    refEnv: "TSUNAMI_REF_CODE",
    referralUrl: () => "https://tsunami.example",
  },
}

it("trade link uses the token's launchpad", () => {
  const lps = new TokenLaunchpads([[CA, "tsunami"]])
  expect(tradeLink(lps.get(CA) ?? "inkypump", CA, { TSUNAMI_REF_CODE: "M" }, two)).toBe(
    `https://tsunami.example/${CA}?r=M`,
  )
  const other = "0x1111111111111111111111111111111111111111"
  lps.set(other, "inkypump")
  expect(lps.get(other)).toBe("inkypump")
})

it("unknown token falls back to InkyPump", () => {
  const lps = new TokenLaunchpads()
  expect(lps.get(CA)).toBeUndefined()
  expect(tradeLink(lps.get(CA) ?? "inkypump", CA, {}, two)).toBe(
    `https://inkypump.com/ink/trade/${CA}`,
  )
})

it("names launchpads from config only", () => {
  expect(launchpadNames(two)).toBe("InkyPump or Tsunami")
})

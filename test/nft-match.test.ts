import { beforeEach, describe, expect, it } from "vitest"
import { matchCollection, parseNftQuery } from "../src/nft/match"
import { createNftState, type NftState } from "../src/nft/state"
import { addr, nftCollection, nftStats } from "./helpers/events"

let state: NftState
let n = 0
const add = (
  i: number,
  o: Parameters<typeof nftCollection>[0] = {},
  owners?: number,
  sales?: number,
) => {
  state.apply({ id: String(++n), p: nftCollection({ contract: addr(i), ...o }) })
  if (owners !== undefined)
    state.apply({
      id: String(++n),
      p: nftStats({ contract: addr(i), owners, sales24h: sales ?? 0 }),
    })
  return addr(i)
}
beforeEach(() => {
  state = createNftState()
  n = 0
})

describe("matchCollection", () => {
  it("opens an exact slug straight away, even when other collections share the name", () => {
    const a = add(1, { slug: "wired", name: "WIRED" })
    add(2, { slug: "wired-2", name: "WIRED" })
    expect(matchCollection(state, "wired")).toEqual({ kind: "one", contract: a })
  })

  it("opens the one real WIRED among 15 with the same name", () => {
    for (let i = 1; i <= 14; i++) add(i, { slug: `copy-${i}`, name: "WIRED", verdict: "filtered" })
    const real = add(15, { slug: "the-real-one", name: "WIRED", verdict: "real" })
    expect(matchCollection(state, "wired")).toEqual({ kind: "one", contract: real })
  })

  it("gives a pick list for two real exact-name matches, best first", () => {
    const a = add(1, { slug: "w-a", name: "WIRED" }, 10, 1)
    const b = add(2, { slug: "w-b", name: "WIRED" }, 500, 1)
    add(3, { slug: "w-c", name: "WIRED", verdict: "pending" }, 9000, 90)
    const m = matchCollection(state, "wired")
    expect(m).toEqual({ kind: "pick", contracts: [b, a, addr(3)] })
  })

  it("orders the list by tier: exact name, prefix, then contains", () => {
    const contains = add(1, { slug: "c", name: "Super Wired" })
    const prefix = add(2, { slug: "p", name: "Wired Apes" })
    const exact1 = add(3, { slug: "e1", name: "WIRED" })
    const exact2 = add(4, { slug: "e2", name: "Wired" })
    expect(matchCollection(state, "wired")).toEqual({
      kind: "pick",
      contracts: [exact1, exact2, prefix, contains],
    })
  })

  it("shows at most 8 in a pick list", () => {
    for (let i = 1; i <= 12; i++) add(i, { slug: `s${i}`, name: `Hornet ${i}` })
    const m = matchCollection(state, "hornet")
    expect(m.kind === "pick" && m.contracts).toHaveLength(8)
  })

  it("treats under 3 letters or digits as short, and finds nothing for an unknown name or address", () => {
    add(1)
    expect(matchCollection(state, "ab")).toEqual({ kind: "short" })
    expect(matchCollection(state, "a b")).toEqual({ kind: "short" })
    expect(matchCollection(state, "zzzzz")).toEqual({ kind: "none" })
    expect(matchCollection(state, addr(99))).toEqual({ kind: "none" })
    expect(matchCollection(state, addr(1))).toEqual({ kind: "one", contract: addr(1) })
    expect(matchCollection(state, "https://opensea.io/collection/ink-hornet")).toEqual({
      kind: "one",
      contract: addr(1),
    })
  })
})

describe("parseNftQuery", () => {
  it("reads a trailing number as an item id only when the words before it name one collection", () => {
    const a = add(1, { slug: "ink-hornet", name: "Ink Hornet" })
    expect(parseNftQuery(state, "ink hornet 1485")).toEqual({
      contract: { kind: "one", contract: a },
      tokenId: "1485",
      window: null,
    })
    // kk98 is one word: a collection query, not an item.
    expect(parseNftQuery(state, "kk98")).toMatchObject({
      tokenId: null,
      contract: { kind: "none" },
    })
    expect(parseNftQuery(state, "nothing 12").tokenId).toBeNull()
  })

  it("reads a trailing window", () => {
    const a = add(1, { slug: "ink-hornet", name: "Ink Hornet" })
    expect(parseNftQuery(state, "ink-hornet 7d")).toEqual({
      contract: { kind: "one", contract: a },
      tokenId: null,
      window: "7d",
    })
    expect(parseNftQuery(state, "ink hornet 30D").window).toBe("30d")
    expect(parseNftQuery(state, "ink hornet").window).toBeNull()
  })
})

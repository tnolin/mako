import { describe, expect, it } from "vitest"
import { nftxPool } from "../src/events"
import {
  NFTX_HOME,
  NFTX_INK,
  NFTX_LOCKER,
  NFTX_SLUG_RE,
  nftxSlugOf,
  onNftx,
  safeSlug,
  walletText,
} from "../src/nft/nftx"
import { createNftState } from "../src/nft/state"
import { addr, nftAuction, nftCollection, nftLaunch, nftStats } from "./helpers/events"
import { loadNftx } from "./helpers/fixtures"

const fx = loadNftx()

/** The collection state after the poller applied `events` in order. */
function stateOf(...events: Parameters<ReturnType<typeof createNftState>["apply"]>[0]["p"][]) {
  const state = createNftState()
  for (const [i, p] of events.entries()) state.apply({ id: String(i + 1), p })
  return state.get(events[0]!.contract)!
}

describe("constants", () => {
  it("names the Locker, the Ink pages and the slug shape", () => {
    expect(NFTX_LOCKER).toBe("0xb4c5b5235b98114e9dc227b54e088c11680b2385")
    expect(NFTX_INK).toBe("https://nftx.io/ink")
    expect(NFTX_HOME).toBe("https://nftx.io/")
    expect(NFTX_SLUG_RE.test("lil-dudes")).toBe(true)
  })
})

describe("safeSlug", () => {
  it("accepts lil-dudes and refuses Lil-Dudes, lil/../x, an empty slug and 101 characters", () => {
    expect(safeSlug("lil-dudes")).toBe("lil-dudes")
    expect(safeSlug("a".repeat(100))).toBe("a".repeat(100))
    expect(safeSlug("Lil-Dudes")).toBeNull()
    expect(safeSlug("lil/../x")).toBeNull()
    expect(safeSlug("lil dudes")).toBeNull()
    expect(safeSlug("lil%2Fx")).toBeNull()
    expect(safeSlug("lil-dudes\n")).toBeNull()
    expect(safeSlug("")).toBeNull()
    expect(safeSlug("a".repeat(101))).toBeNull()
    expect(safeSlug(null)).toBeNull()
    expect(safeSlug(undefined)).toBeNull()
  })
})

describe("onNftx", () => {
  it("is true for Lil Dudes' open and false for an OpenSea-only collection", () => {
    expect(onNftx(stateOf(fx.lilDudes.launch))).toBe(true)
    expect(onNftx(stateOf(nftCollection()))).toBe(false)
  })

  it("is true for a collection row, an auction or a pool price on NFTX, even when Chimera holds the column", () => {
    expect(onNftx(stateOf(fx.lilDudes.collection))).toBe(true)
    expect(onNftx(stateOf(nftAuction()))).toBe(true)
    expect(onNftx(stateOf(nftStats({ nftxFloorWei: "1" })))).toBe(true)
    expect(onNftx(stateOf(nftStats({ nftxFloorWei: null })))).toBe(false)
    expect(
      onNftx(stateOf({ ...fx.lilDudes.collection, launchpad: "chimera" }, fx.lilDudes.launch)),
    ).toBe(true)
    expect(onNftx(stateOf({ ...fx.lilDudes.collection, launchpad: "chimera" }))).toBe(false)
    expect(onNftx(stateOf(nftLaunch()))).toBe(false)
  })
})

describe("nftxSlugOf", () => {
  const open = (nftxSlug: string | null) => ({
    ...fx.lilDudes.launch,
    contract: addr(0xc0),
    nftxSlug,
  })

  it("prefers the event's slug, then the auction, the open and the stats, and drops an invalid one", () => {
    const all = stateOf(
      nftStats({ nftxSlug: "from-stats" }),
      open("from-open"),
      nftAuction({ nftxSlug: "from-auction" }),
    )
    expect(nftxSlugOf(all, "from-event")).toBe("from-event")
    expect(nftxSlugOf(all)).toBe("from-auction")
    expect(nftxSlugOf(stateOf(nftStats({ nftxSlug: "from-stats" }), open("from-open")))).toBe(
      "from-open",
    )
    expect(nftxSlugOf(stateOf(nftStats({ nftxSlug: "from-stats" })))).toBe("from-stats")
    expect(nftxSlugOf(stateOf(nftStats({ nftxSlug: null })))).toBeNull()
    expect(nftxSlugOf(undefined, "lil-dudes")).toBe("lil-dudes")
    // A bad slug is dropped, not replaced by another source's.
    expect(nftxSlugOf(all, "Lil/../x")).toBeNull()
    expect(nftxSlugOf(stateOf(nftAuction({ nftxSlug: "Bad Slug" })))).toBeNull()
  })

  it("does not take an OpenSea slug", () => {
    expect(nftxSlugOf(stateOf(nftCollection({ slug: "ink-hornet" })))).toBeNull()
  })
})

describe("walletText", () => {
  it("names the Locker NFTX pool, in any letter case", () => {
    expect(walletText(NFTX_LOCKER)).toBe("NFTX pool")
    expect(walletText(NFTX_LOCKER.toUpperCase().replace("0X", "0x"))).toBe("NFTX pool")
    expect(walletText("0x761219aa4139836e0296f1215c2a4897c38c9296")).toBe("0x7612…9296")
  })
})

describe("nftxPool", () => {
  it("reads the pool price and count of an open and of a stats row", () => {
    expect(nftxPool(fx.lilDudes.launch)).toEqual({ floorWei: "899999999999999", poolCount: 35 })
    expect(nftxPool(fx.lilDudes.stats)).toEqual({ floorWei: "308559859825663", poolCount: 60 })
  })
})

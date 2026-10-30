import { describe, expect, it } from "vitest"
import { current } from "../src/events"
import { UNISWAP_V4_POOL_MANAGER } from "../src/pool"
import { bond, bondV1, launch, launchV1, nftSale, swap, trade, tradeV1 } from "./helpers/events"

describe("current", () => {
  it("current upgrades a v1 trade", () => {
    const v1 = tradeV1({ marketCap: "123" })
    const { v: _, ...rest } = v1
    expect(current(v1)).toEqual({ ...rest, v: 2, athMarketCap: "123" })
  })

  it("current upgrades a v1 bond onto Uniswap's pool manager", () => {
    const v1 = bondV1()
    const { v: _, ...rest } = v1
    expect(current(v1)).toEqual({ ...rest, v: 2, poolManager: UNISWAP_V4_POOL_MANAGER })
  })

  it("current upgrades a v1 launch as a curve launch with no pool or hook fields", () => {
    const v1 = launchV1()
    const { v: _, ...rest } = v1
    expect(current(v1)).toEqual({
      ...rest,
      v: 2,
      startsInPool: false,
      poolId: null,
      poolManager: null,
      customHook: null,
      hookModules: null,
    })
  })

  it("current leaves a v2 swap unchanged", () => {
    const s = swap()
    expect(current(s)).toBe(s)
  })

  it("current leaves v2 launchpad rows and NFT rows unchanged", () => {
    for (const e of [launch(), trade(), bond(), nftSale()]) expect(current(e)).toBe(e)
  })
})

import type { Address, BondEvent, Hash, LaunchEvent, TradeEvent } from "@ink-indexer/events"

export const NATIVE: Address = "0x0000000000000000000000000000000000000000"
export const T0 = 1_790_000_000
export const ETH = 10n ** 18n

export const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}`
export const hash = (n: number): Hash => `0x${n.toString(16).padStart(64, "0")}`

let seq = 0
const next = () => ++seq

/** Defaults: token 0xd1, creator 0xc1, 3 ETH target, 1e27 supply, ETH-quoted. */
export function launch(o: Partial<LaunchEvent> = {}): LaunchEvent {
  const n = next()
  return {
    v: 1,
    type: "launchpad.launch",
    chainId: 57073,
    launchpad: "inkypump",
    token: addr(0xd1),
    launchId: hash(0x1d),
    txHash: hash(n),
    logIndex: 0,
    blockNumber: String(1000 + n),
    blockTimestamp: T0,
    hook: addr(0x4b),
    creator: addr(0xc1),
    name: "Goblo",
    ticker: "GOBLO",
    description: null,
    imageUrl: "https://images.inkypump.com/original/abc.jpg",
    links: { telegram: null, twitter: null, website: null },
    quoteAsset: NATIVE,
    targetRaise: String(3n * ETH),
    totalSupply: String(10n ** 27n),
    ...o,
  }
}

/** Defaults: a 0.02 ETH buy by trader 0xe1 at 10% sold, after the launch block. */
export function trade(o: Partial<TradeEvent> = {}): TradeEvent {
  const n = next()
  return {
    v: 1,
    type: "launchpad.trade",
    chainId: 57073,
    launchpad: "inkypump",
    token: addr(0xd1),
    launchId: hash(0x1d),
    txHash: hash(n),
    logIndex: n,
    blockNumber: String(1000 + n),
    blockTimestamp: T0 + 60,
    side: "buy",
    trader: addr(0xe1),
    tokenAmount: String(10n ** 25n),
    quoteAmount: String(2n * 10n ** 16n),
    price: "1000",
    curveValue: String(3n * 10n ** 17n),
    target: String(3n * ETH),
    progressBpsBefore: 0,
    progressBpsAfter: 1000,
    soldBps: 1000,
    marketCap: String(5n * ETH),
    quoteAsset: NATIVE,
    ...o,
  }
}

export function bond(o: Partial<BondEvent> = {}): BondEvent {
  const n = next()
  return {
    v: 1,
    type: "launchpad.bond",
    chainId: 57073,
    launchpad: "inkypump",
    token: addr(0xd1),
    launchId: hash(0x1d),
    txHash: hash(n),
    logIndex: n,
    blockNumber: String(1000 + n),
    blockTimestamp: T0 + 3600,
    poolId: hash(0x1d),
    liquidityQuote: String(21n * 10n ** 17n),
    liquidityTokens: String(214n * 10n ** 24n),
    quoteAsset: NATIVE,
    ...o,
  }
}

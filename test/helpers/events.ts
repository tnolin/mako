import type {
  Address,
  BondEvent,
  BondEventV1,
  Hash,
  LaunchEvent,
  LaunchEventV1,
  NftCollectionEvent,
  NftDropEvent,
  NftLaunchEvent,
  NftListingEvent,
  NftMintEvent,
  NftSaleEvent,
  NftStatsEvent,
  SwapEvent,
  TradeEvent,
  TradeEventV1,
} from "@ink-indexer/events"
import { UNISWAP_V4_POOL_MANAGER } from "../../src/pool"

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
    v: 2,
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
    startsInPool: false,
    poolId: null,
    poolManager: null,
    customHook: null,
    hookModules: null,
    ...o,
  }
}

/** A launch row as stored before events schema version 2. */
export function launchV1(o: Partial<LaunchEventV1> = {}): LaunchEventV1 {
  const { v: _, startsInPool, poolId, poolManager, customHook, hookModules, ...rest } = launch()
  return { ...rest, v: 1, launchpad: "inkypump", targetRaise: String(3n * ETH), ...o }
}

/** Defaults: a 0.02 ETH buy by trader 0xe1 at 10% sold, after the launch block. ath defaults to the market cap. */
export function trade(o: Partial<TradeEvent> = {}): TradeEvent {
  const n = next()
  const marketCap = o.marketCap ?? String(5n * ETH)
  return {
    v: 2,
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
    marketCap,
    athMarketCap: marketCap,
    quoteAsset: NATIVE,
    ...o,
  }
}

/** A curve trade row as stored before events schema version 2. */
export function tradeV1(o: Partial<TradeEventV1> = {}): TradeEventV1 {
  const { v: _, athMarketCap, ...rest } = trade()
  return { ...rest, v: 1, launchpad: "inkypump", ...o }
}

export function bond(o: Partial<BondEvent> = {}): BondEvent {
  const n = next()
  return {
    v: 2,
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
    poolManager: UNISWAP_V4_POOL_MANAGER,
    liquidityQuote: String(21n * 10n ** 17n),
    liquidityTokens: String(214n * 10n ** 24n),
    quoteAsset: NATIVE,
    ...o,
  }
}

/** A bond row as stored before events schema version 2. */
export function bondV1(o: Partial<BondEventV1> = {}): BondEventV1 {
  const { v: _, poolManager, ...rest } = bond()
  return { ...rest, v: 1, launchpad: "inkypump", ...o }
}

/**
 * Defaults: a 0.05 ETH pool buy by trader 0xe1 through router 0x7e, market cap 20 ETH (also the ath), quote side
 * 4 ETH, pool hash(9), after the bond. ath defaults to the market cap.
 */
export function swap(o: Partial<SwapEvent> = {}): SwapEvent {
  const n = next()
  const marketCap = o.marketCap ?? String(20n * ETH)
  return {
    v: 2,
    type: "launchpad.swap",
    chainId: 57073,
    launchpad: "inkypump",
    token: addr(0xd1),
    launchId: hash(0x1d),
    txHash: hash(n),
    logIndex: n,
    blockNumber: String(1000 + n),
    blockTimestamp: T0 + 7200,
    poolId: hash(9),
    poolManager: UNISWAP_V4_POOL_MANAGER,
    side: "buy",
    trader: addr(0xe1),
    router: addr(0x7e),
    tokenAmount: String(25n * 10n ** 23n),
    quoteAmount: String(5n * 10n ** 16n),
    quoteAsset: NATIVE,
    price: String(2n * 10n ** 10n),
    marketCap,
    athMarketCap: marketCap,
    quoteLiquidity: String(4n * ETH),
    supply: String(10n ** 27n),
    ...o,
  }
}

/** Defaults: a 0.05 ETH OpenSea sale of item 1 in collection 0xc0, bought by 0xb1 from 0x51. */
export function nftSale(o: Partial<NftSaleEvent> = {}): NftSaleEvent {
  const n = next()
  return {
    v: 1,
    type: "nft.sale",
    chainId: 57073,
    contract: addr(0xc0),
    source: "chain",
    txHash: hash(n),
    logIndex: n,
    blockNumber: String(1000 + n),
    blockTimestamp: T0 + 60,
    tokenId: "1",
    priceWei: String(5n * 10n ** 16n),
    currency: "ETH",
    buyer: addr(0xb1),
    seller: addr(0x51),
    orderHash: hash(0x0d),
    itemName: null,
    imageUrl: null,
    rank: null,
    maxRank: null,
    floorWei: null,
    ...o,
  }
}

const nftBase = (n: number) => ({
  v: 1 as const,
  chainId: 57073 as const,
  contract: addr(0xc0),
  source: "chain" as const,
  txHash: hash(n),
  logIndex: n,
  blockNumber: String(1000 + n),
  blockTimestamp: T0 + 60,
})

/** Defaults: the real, verified-by-nothing collection "Ink Hornet" (slug ink-hornet) at 0xc0, all gates passed. */
export function nftCollection(o: Partial<NftCollectionEvent> = {}): NftCollectionEvent {
  return {
    ...nftBase(next()),
    type: "nft.collection",
    slug: "ink-hornet",
    name: "Ink Hornet",
    imageUrl: "https://i.example/hornet.png",
    links: { twitter: "InkHornet", website: "https://hornet.example", discord: null },
    standard: "erc721",
    kind: "drop",
    verdict: "real",
    gates: { page: "pass", structure: "pass", traits: "pass", farm: "pass", farmShareBps: 0 },
    manual: false,
    safelist: null,
    maxSupply: "2222",
    seadrop: true,
    openseaUrl: "https://opensea.io/collection/ink-hornet",
    rarityCalculatedAt: null,
    maxRank: null,
    launchpad: null,
    launchToken: null,
    creator: null,
    ...o,
  }
}

/** Defaults: a free GTD stage (588 wallets) and a 0.0005 ETH public stage a day later, from T0 + 3600. */
export function nftDrop(o: Partial<NftDropEvent> = {}): NftDropEvent {
  return {
    ...nftBase(next()),
    type: "nft.drop",
    slug: "ink-hornet",
    maxSupply: "2222",
    stages: [
      {
        type: "signed_presale",
        label: "GTD",
        priceWei: "0",
        startTime: T0 + 3600,
        endTime: T0 + 7200,
        maxPerWallet: 1,
        allowlistCount: 588,
      },
      {
        type: "public_sale",
        label: "Public",
        priceWei: String(5n * 10n ** 14n),
        startTime: T0 + 7200,
        endTime: null,
        maxPerWallet: 10,
        allowlistCount: null,
      },
    ],
    ...o,
  }
}

/** Defaults: GTD (stage 0) starting at T0 + 3600 with 300 of 2,222 minted. */
export function nftMint(o: Partial<NftMintEvent> = {}): NftMintEvent {
  return {
    ...nftBase(next()),
    type: "nft.mint",
    kind: "stage_start",
    stageIndex: 0,
    stageLabel: "GTD",
    stagePriceWei: "0",
    markBps: null,
    minted: "300",
    maxSupply: "2222",
    mintStartTs: T0 + 3600,
    stageStartTs: T0 + 3600,
    minters: 280,
    blockTimestamp: T0 + 3600,
    ...o,
  }
}

/** Defaults: a 0.04 ETH listing of item 1 against a 0.05 ETH floor read at T0, no rank. */
export function nftListing(o: Partial<NftListingEvent> = {}): NftListingEvent {
  return {
    ...nftBase(next()),
    type: "nft.listing",
    tokenId: "1",
    priceWei: String(4n * 10n ** 16n),
    currency: "ETH",
    maker: addr(0x51),
    expiresAt: T0 + 6 * 3600,
    orderHash: hash(0x0d),
    itemName: "Ink Hornet #1",
    imageUrl: null,
    floorWei: String(5n * 10n ** 16n),
    floorAt: T0,
    rank: null,
    maxRank: null,
    ...o,
  }
}

/** Defaults: floor 0.05 ETH against 0.05 ETH a day ago, 100 owners, 1 ETH and 10 sales in 24 h. */
export function nftStats(o: Partial<NftStatsEvent> = {}): NftStatsEvent {
  return {
    ...nftBase(next()),
    type: "nft.stats",
    floorWei: String(5n * 10n ** 16n),
    floor24hAgoWei: String(5n * 10n ** 16n),
    owners: 100,
    volume24hWei: String(10n ** 18n),
    sales24h: 10,
    totalSupply: "2222",
    maxSupply: "2222",
    listedCount: 40,
    listedCapped: false,
    ...o,
  }
}

/** Defaults: a Chimera campaign by creator 0xc1 for token 0xd2 (BLOOP). */
export function nftLaunch(o: Partial<NftLaunchEvent> = {}): NftLaunchEvent {
  return {
    ...nftBase(next()),
    type: "nft.launch",
    launchpad: "chimera",
    campaignId: "7",
    token: addr(0xd2),
    tokenSymbol: "BLOOP",
    tokenName: "Bloop",
    creator: addr(0xc1),
    poolId: hash(0x1d),
    ...o,
  }
}

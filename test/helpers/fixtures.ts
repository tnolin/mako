import { readFileSync } from "node:fs"
import type {
  BondEvent,
  LaunchEvent,
  NftAuctionEvent,
  NftCollectionEvent,
  NftEvent,
  NftLaunchEvent,
  NftSaleEvent,
  NftStatsEvent,
  StoredEvent,
  SwapEvent,
  TradeEvent,
} from "@ink-indexer/events"

/** Real launchpad rows as the indexer stored them, at whatever schema version they were written. */
export function loadFixture(name: string): Exclude<StoredEvent, NftEvent>[] {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"))
}

type Graduate = {
  launch: LaunchEvent
  closingBuy: TradeEvent
  bond: BondEvent
  swap: SwapEvent
  slot0SqrtPriceX96: string
}

/**
 * Tsunami launches, curve trades, graduations and Calamari pool swaps as the indexer builds them, from
 * transactions recorded on Ink mainnet. `slot0SqrtPriceX96` is the pool price right after the recorded swap.
 */
export type TsunamiFixtures = {
  shitcoin: { launch: LaunchEvent; seedBuy: TradeEvent }
  gm: Graduate
  usdc: Graduate
  usdcBuy: { launch: LaunchEvent; buy: TradeEvent }
  moved: Graduate & { sourcePoolId: string; destinationPoolId: string }
}

export function loadTsunami(): TsunamiFixtures {
  return JSON.parse(
    readFileSync(new URL("../fixtures/tsunami-events.json", import.meta.url), "utf8"),
  )
}

/**
 * NFTX collections and an auction as the indexer records them, from transactions on Ink mainnet. Each entry
 * carries its source `txHash` and `blockNumber`. `inktrons` is the one auction on Ink, with Lil Dudes as the
 * collection standing in for a floor token's.
 */
export type NftxFixtures = {
  lilDudes: {
    collection: NftCollectionEvent
    launch: NftLaunchEvent
    stats: NftStatsEvent
    arbitrageSale: NftSaleEvent
  }
  bubbleCats: { launch: NftLaunchEvent }
  humanInk: { launch: NftLaunchEvent }
  inktrons: {
    created: NftAuctionEvent
    live: NftAuctionEvent
    price: NftAuctionEvent
    ended: NftAuctionEvent
  }
}

export function loadNftx(): NftxFixtures {
  return JSON.parse(readFileSync(new URL("../fixtures/nftx-events.json", import.meta.url), "utf8"))
}

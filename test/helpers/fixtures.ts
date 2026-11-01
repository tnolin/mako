import { readFileSync } from "node:fs"
import type {
  BondEvent,
  LaunchEvent,
  NftEvent,
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

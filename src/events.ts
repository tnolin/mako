import type { IndexerEvent, StoredEvent } from "@ink-indexer/events"
import { UNISWAP_V4_POOL_MANAGER } from "./pool"

/**
 * The current shape of a stored event. `indexer.events` keeps rows written under events schema version 1, so this
 * is the one place that branches on `v`: rules and cards only ever see current shapes.
 */
export function current(p: StoredEvent): IndexerEvent {
  if (p.v !== 1) return p
  switch (p.type) {
    case "launchpad.trade":
      // Version 1 carried no ath; the market cap at the trade is the best figure the row has.
      return { ...p, v: 2, athMarketCap: p.marketCap }
    case "launchpad.bond":
      return { ...p, v: 2, poolManager: UNISWAP_V4_POOL_MANAGER }
    case "launchpad.launch":
      return {
        ...p,
        v: 2,
        startsInPool: false,
        poolId: null,
        poolManager: null,
        customHook: null,
        hookModules: null,
      }
  }
  return p as IndexerEvent
}

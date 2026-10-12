import type { TradeEvent } from "@ink-indexer/events"
import { expect, it } from "vitest"
import type { Row } from "../src/history"
import {
  devCounts,
  devPnl,
  launchTxTrades,
  prevSoldBps,
  pumpWindow,
  windowStats,
} from "../src/rules/stats"
import { addr, ETH, hash, T0, trade } from "./helpers/events"

const C = addr(0xc1)
const rows = (ts: Partial<TradeEvent>[]): Row<TradeEvent>[] =>
  ts.map((t, i) => ({ id: String(i + 1), p: trade(t) }))

it("reads the soldBps before an event", () => {
  const t = rows([{ soldBps: 1000 }, { soldBps: 2000 }, { soldBps: 2500 }])
  expect(prevSoldBps(t, "3")).toBe(2000)
  expect(prevSoldBps(t, "1")).toBe(0)
})

it("sums volume and counts inside a time window up to an id", () => {
  const t = rows([
    { blockTimestamp: T0, quoteAmount: String(ETH) },
    { blockTimestamp: T0 + 100, quoteAmount: String(2n * ETH), side: "sell" },
    { blockTimestamp: T0 + 200, quoteAmount: String(4n * ETH) },
  ])
  expect(windowStats(t, T0 + 50, "2")).toEqual({ volume: 2n * ETH, buys: 0, sells: 1 })
  expect(windowStats(t, 0, "3")).toEqual({ volume: 7n * ETH, buys: 2, sells: 1 })
})

it("computes dev realized PnL by average cost", () => {
  const t = rows([
    { trader: C, side: "buy", tokenAmount: String(10n ** 26n), quoteAmount: String(ETH) },
    { trader: addr(0xe1), side: "buy" },
    {
      trader: C,
      side: "sell",
      tokenAmount: String(5n * 10n ** 25n),
      quoteAmount: String(2n * ETH),
    },
  ])
  expect(devCounts(t, C, "3")).toEqual({ buys: 1, sells: 1 })
  expect(devPnl(t, C, "3")).toEqual({ realized: (3n * ETH) / 2n, basis: ETH / 2n })
})

it("gives a zero cost basis to tokens the dev never bought", () => {
  const t = rows([{ trader: C, side: "sell", tokenAmount: "100", quoteAmount: String(ETH) }])
  expect(devPnl(t, C, "1")).toEqual({ realized: ETH, basis: 0n })
})

it("finds launch-transaction trades", () => {
  const t = rows([{ txHash: hash(9) }, { txHash: hash(9) }, { txHash: hash(10) }])
  expect(launchTxTrades(t, hash(9)).map((r) => r.id)).toEqual(["1", "2"])
})

it("baselines a young token on the launch transaction", () => {
  const L = hash(9)
  const t = rows([
    { txHash: L, soldBps: 2000, blockTimestamp: T0 },
    { soldBps: 2500, blockTimestamp: T0 + 100 },
    { soldBps: 3600, blockTimestamp: T0 + 300 },
  ])
  expect(pumpWindow(t, t[2]!, L)).toEqual({ base: 2000, firstTs: T0 + 100 })
})

it("baselines an older token on the last trade at least 10 minutes back", () => {
  const t = rows([
    { soldBps: 3000, blockTimestamp: T0 + 1000 },
    { soldBps: 3500, blockTimestamp: T0 + 1500 },
    { soldBps: 4600, blockTimestamp: T0 + 1700 },
  ])
  expect(pumpWindow(t, t[2]!, hash(9))).toEqual({ base: 3000, firstTs: T0 + 1500 })
})

import type { Address, LaunchEvent, SwapEvent, TradeEvent } from "@ink-indexer/events"
import { UNISWAP_V4_POOL_MANAGER } from "../../src/pool"
import { addr, hash, launch, NATIVE, swap, trade } from "./events"

// Launches recorded on Ink mainnet: the token, creator, transaction, block, pool ids and module sets are the
// chain's. Supply, hook and bitmask-derived modules are read from the same transactions.

const padId = (token: string): LaunchEvent["launchId"] => `0x${token.slice(2).padStart(64, "0")}`
const MASTER_HOOK_A: Address = "0xbd7e7815c640a67cabd9a93a15d1f250aaeeaac8"
const ETH = 10n ** 18n

export const WAAPLX: Address = "0x943bf64d566c32a2bcd41ac92fb63c111cc9de8f"
export const USDG: Address = "0xe343167631d89b6ffc58b88d6b7fb0228795491d"

function master(o: Partial<LaunchEvent> & Pick<LaunchEvent, "token" | "creator">): LaunchEvent {
  return launch({
    launchpad: "hookit",
    launchId: padId(o.token),
    hook: MASTER_HOOK_A,
    targetRaise: null,
    startsInPool: true,
    poolManager: UNISWAP_V4_POOL_MANAGER,
    customHook: false,
    markets: null,
    totalSupply: String(1_000_000_000n * ETH),
    ...o,
  })
}

/** $HKT: factory A, ETH, five modules, no dev buy in the launch transaction. */
export const HKT = master({
  token: "0xcf010ba185fd6ee6027b141e2c32614d673f8258",
  creator: "0x93a00f2977e82ff72b487820e50ecf5c7a99e855",
  name: "HOOKIT",
  ticker: "HKT",
  description: "Hold one, get all",
  txHash: "0x9923d58f6cc0b902f1dd2276b7ba1a685ef4cd62b039b73027aee65ee5421f42",
  blockNumber: "56519919",
  blockTimestamp: 1790018330,
  poolId: "0xdc2f8c6d0a436fd2fb35c1003caf4acb25da7b58bd1475c7039917a30cb3ad59",
  hookModules: ["Anti-Snipe", "Anti-MEV", "Auto-Burn", "Deepen LPs", "Creator → Hook"],
})

/** HMU: factory A, five stock markets, wAAPLx first. */
export const HMU = master({
  token: "0xe6584337bfbbef47311c16bf000ca585b1279f58",
  creator: "0xa42d721ddc5247b5b939666b26081394ffa4ce8f",
  name: "Hook Me Up",
  ticker: "HMU",
  quoteAsset: WAAPLX,
  txHash: "0xd22d394736667d1b133e25c13a457db6047312245bd603539c72a42dd8bc2e2a",
  blockNumber: "56521188",
  blockTimestamp: 1790019599,
  poolId: "0x157434b1f871e7db239fd10ea63dad44068cb50770678e5bb3dbcc99088a1160",
  hookModules: ["Creator → Hook", "Hook → Creator"],
  markets: [
    {
      quoteAsset: WAAPLX,
      poolId: "0x157434b1f871e7db239fd10ea63dad44068cb50770678e5bb3dbcc99088a1160",
    },
    {
      quoteAsset: "0xf8c5308f80e459bb53d9ebe689854d9cbb2caa6f",
      poolId: "0x1148fe4233a3c863231368462d34a0499ce008a04a0c90b852dc3aa05b49240f",
    },
    {
      quoteAsset: "0x910cabde3eba7fc1ce64fd14bd680b9f60fa0f90",
      poolId: "0x02e4d60afc77aff00b82f242d95fd9629d6b0af58a61faaeca98e823b78d159b",
    },
    {
      quoteAsset: "0xa8ddb5cd96b5222afe198316e9a57caa642850d5",
      poolId: "0x40d849dade148389448e54829a8277e4ae5934f4e7d0daa252726d1b2be06c50",
    },
    {
      quoteAsset: "0xc3fdbe3a68ee5de461d30415a8165cf9aefe1171",
      poolId: "0xdd4a32af5b103bb004d3821102b201f9841be1931252e9855178d159ece8874c",
    },
  ],
})

/** QUILL: factory C, hook C, three modules. */
export const QUILL = master({
  token: "0x4f02a2e7b1ac335101a28e3fecd5909aeae7ffa8",
  creator: "0x9cccc64ae1bf4c3ffb2514f9f464f05eec39d039",
  name: "QUILL",
  ticker: "QL",
  hook: "0x4b533c432516fc1be4b0baefe6bff0942ad87fff",
  txHash: "0x65625a701bfd890a298f346c4c18629f17c4c588f22118918ba1c0c1aefc24bd",
  blockNumber: "58090378",
  blockTimestamp: 1791588789,
  totalSupply: "999952539025494405242336732",
  poolId: "0xced50060d055523063d2dd7d4d497314cb8859928eebfac62c9563b1453bb13f",
  hookModules: ["Anti-Snipe", "Anti-MEV", "Holder Airdrop"],
})

/** INKY: factory B2, USDG first, six modules. */
export const INKY = master({
  token: "0xd58106c950019a196a0ea9a4142004eb34b2aa68",
  creator: "0xc5e64c91b80edfa4b7d0abd0bcf8194793c6758a",
  name: "Inky",
  ticker: "INKY",
  quoteAsset: USDG,
  hook: "0x33200d9521ed99afbda8575f05348a583c7aaac8",
  txHash: "0x7626e54e08f7b4ef08617ae71ee0347057593990136474edf4f4b4b9e1215baf",
  blockNumber: "56801122",
  blockTimestamp: 1790299533,
  totalSupply: "999928127517104081502719383",
  poolId: "0xff4c17ed1e3bd016ef3e8c2d336792feb780fa8937a934f51cc800a2af8d3aa3",
  hookModules: [
    "Anti-Snipe",
    "Auto-Burn",
    "Deepen LPs",
    "Holder Airdrop",
    "Hook → Creator",
    "Fixed Fees",
  ],
})

/** QCARD: the DN404 factory, supply 4,444, a contract as creator. */
export const QCARD = master({
  token: "0xed3affd713421a2c2fadacd9fbf53b938a3c4968",
  creator: "0xf7cda685d97b43b89c81286b2f0220bbcb4f0527",
  name: "QCARD",
  ticker: "QCARD",
  hook: "0x1eee7628d070280da1b676c04d358d68b36f3fff",
  txHash: "0x27c8a179438f9c7ba98e7a1107a0642d2db908589aa5701a9e1a123c78fd9f19",
  blockNumber: "59915868",
  blockTimestamp: 1793414279,
  totalSupply: String(4444n * ETH),
  poolId: "0x0839eb81ce159a6271725f84a6d1b94ae861d77c425bbafd945222f643e03e47",
  hookModules: ["Hook → Creator", "Fixed Fees"],
})

/** A Master token whose bitmask turns no module on; built for the test, no recorded launch has this shape. */
export const NO_MODULES = master({
  token: addr(0xa101),
  creator: addr(0xa102),
  name: "Plain",
  ticker: "PLAIN",
  hookModules: [],
})

/**
 * bloop (C21): factory C, hook D. Its creator is a payout contract, not the transaction's sender, so the dev
 * buy's swap carries the creator as trader.
 */
export const BLOOP = master({
  token: "0xb0ff8207ebb8cc285fc53e4e3020592742636fa8",
  creator: "0x0dd3ee376fa6c46ff6264c37b13d0beaca85091e",
  name: "bloop",
  ticker: "BLOOP",
  hook: "0x8a29b2c508007707bbff1814386aa968bbecbfff",
  txHash: "0xd0db98a61b76fbfb49207cd0ad20c142f3a5e958e8f881ae89e48bf05bcefed0",
  blockNumber: "58774376",
  blockTimestamp: 1792272787,
  totalSupply: "999995018909414295482714525",
  poolId: "0x956455c902cf29eab277d2b7ffaae3aa2a94f457c61b0eac8f733bf45ef38ba8",
  hookModules: ["Backed Floor", "Auto-Burn", "Fixed Fees"],
})

/** The swap the factory made for bloop's dev buy; the transaction was sent by 0xacb0…338c. */
export const BLOOP_DEV_BUY: SwapEvent = swap({
  launchpad: "hookit",
  token: BLOOP.token,
  launchId: BLOOP.launchId,
  txHash: BLOOP.txHash,
  logIndex: 19,
  blockNumber: BLOOP.blockNumber,
  blockTimestamp: BLOOP.blockTimestamp,
  poolId: BLOOP.poolId as Address,
  side: "buy",
  trader: BLOOP.creator,
  router: "0x145c3f3560c23fda93ea79f2efeb7f33d8a9ff3e",
  tokenAmount: "483401872051755307237919",
  quoteAmount: "1018001458721333",
})

/** A custom-hook launch built for the test: no Hookit launch has used one. */
export const SYNTHETIC_CUSTOM = master({
  token: addr(0xc501),
  creator: addr(0xc502),
  name: "Example",
  ticker: "EXAMPLE",
  hook: "0x1234567890abcdef1234567890abcdef0000abcd",
  customHook: true,
  hookModules: ["Anti-Snipe"],
})

/** HOOC: a bonding-curve launch on the Classic factory, the creator's first buy in the launch transaction. */
export const HOOC = launch({
  launchpad: "hookit",
  token: "0xc332cdd032acb24225ee273e3e27cfb297cd24a8",
  launchId: padId("0xc332cdd032acb24225ee273e3e27cfb297cd24a8"),
  creator: "0x8224c388250da458f4a9710de40d1da6a0e980d6",
  name: "Hooctopus",
  ticker: "HOOC",
  hook: "0xaac738f140d529bc0662bddd812964d843362088",
  txHash: "0x0475aec85c26e10931c7b9f76357b58fd1556c7780155f0c5de4097baf55790b",
  blockNumber: "56519366",
  blockTimestamp: 1790017777,
  totalSupply: String(1_000_000_000n * ETH),
  targetRaise: String(42n * 10n ** 17n),
  startsInPool: false,
  customHook: false,
  hookModules: null,
})

/** The creator's launch-transaction buy on HOOC: 0.000657 ETH raised, 500K tokens sold. */
export const HOOC_FIRST_BUY: TradeEvent = trade({
  launchpad: "hookit",
  token: HOOC.token,
  launchId: HOOC.launchId,
  txHash: HOOC.txHash,
  logIndex: 22,
  blockNumber: HOOC.blockNumber,
  blockTimestamp: HOOC.blockTimestamp,
  side: "buy",
  trader: HOOC.creator,
  tokenAmount: "500000000000001517621615",
  quoteAmount: "656557761450682",
  price: "1313731334",
  curveValue: "656557761450682",
  target: String(42n * 10n ** 17n),
  progressBpsBefore: 0,
  progressBpsAfter: 1,
  soldBps: 1,
  marketCap: "1313731334464390199",
  athMarketCap: "1313731334464390199",
})

export { hash, NATIVE }

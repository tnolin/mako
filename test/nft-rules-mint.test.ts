import type { NftDropStage, NftEvent } from "@ink-indexer/events"
import { beforeEach, describe, expect, it } from "vitest"
import type { Row } from "../src/history"
import type { NftAlertCard } from "../src/nft/card"
import { CATCH_UP_MAX_S, LAUNCH_HOLD_S } from "../src/nft/policy"
import { mintMarket, mintRules, newCollectionCard, nftxOpenCard } from "../src/nft/rules/mint"
import { createNftState, type NftState } from "../src/nft/state"
import { nftViewPath } from "../src/platforms/telegram/render"
import type { Prices } from "../src/prices"
import { NATIVE } from "../src/prices"
import type { Candidate } from "../src/rules/index"
import { addr, nftCollection, nftDrop, nftLaunch, nftMint, nftStats } from "./helpers/events"
import { loadNftx } from "./helpers/fixtures"

const fx = loadNftx()
const H = 3600
const SEP6 = Date.UTC(2026, 8, 6) / 1000
const C = addr(0xc0)
const eth = (n: bigint) => String(n)
const stage = (
  label: string,
  h: number,
  price: bigint,
  o: Partial<NftDropStage> = {},
): NftDropStage => ({
  type: label === "Public" ? "public_sale" : "signed_presale",
  label,
  priceWei: eth(price),
  startTime: SEP6 + h * H,
  endTime: null,
  maxPerWallet: null,
  allowlistCount: label === "Public" ? null : 100,
  ...o,
})
const HORNET_STAGES = [
  stage("Team", 9, 0n, { allowlistCount: 5 }),
  stage("GTD", 10, 0n, { endTime: SEP6 + 13 * H, maxPerWallet: 1, allowlistCount: 588 }),
  stage("FCFS", 13, 25n * 10n ** 13n, {
    endTime: SEP6 + 17 * H,
    maxPerWallet: 4,
    allowlistCount: 2152,
  }),
  stage("Public", 17, 5n * 10n ** 14n, { maxPerWallet: 10 }),
]
const creator = { address: addr(0xaa), username: "INKHornetDEV", verified: false }

let state: NftState
let n = 0
let now = 0
let since = 0
beforeEach(() => {
  state = createNftState()
  n = 0
  since = 0
})
const prices: Prices = { usd: (q) => (q === NATIVE ? 2400 : null), symbol: () => "ETH" }
const ctx = () => ({ nft: state, now: () => now, nftSince: since, prices })
/** The poller's order: apply the event to the state, then run the rules with the previous snapshot. */
function process(p: NftEvent): Candidate[] {
  const ev: Row<NftEvent> = { id: String(++n), p }
  const prev = state.apply(ev)
  return mintRules(ev as never, prev, ctx())
}
const card = (c: Candidate | undefined) => c!.card as NftAlertCard
const rows = (c: Candidate | undefined) => card(c).rows.map(([l, v]) => `${l}|${v}`)
const only = (cs: Candidate[]) => {
  expect(cs).toHaveLength(1)
  return cs[0]!
}

describe("UPCOMING MINT", () => {
  it("lists the non-Team stages with time and price, Team left out, and no MINT STARTING for Team", () => {
    now = SEP6 - 2 * 24 * H + 6 * H + 1 // Sep 4 06:00:01 → in 2d 4h
    process(nftCollection({ creator }))
    const c = only(process(nftDrop({ stages: HORNET_STAGES, blockTimestamp: now })))
    expect(c).toMatchObject({
      alert: "upcoming",
      target: C,
      dedupeKey: `upcoming:${C}`,
      priority: 3,
      feedEligible: true,
    })
    expect(card(c).title).toBe("UPCOMING MINT")
    expect(rows(c)).toEqual([
      "starts|Sep 6 10:00 UTC (in 2d 4h)",
      "supply|2,222",
      "gtd|10:00 UTC · free",
      "fcfs|13:00 UTC · 0.00025 ETH",
      "public|17:00 UTC · 0.0005 ETH",
      "creator|INKHornetDEV",
    ])
    // The Team stage starting is not announced.
    now = SEP6 + 9 * H
    expect(process(nftMint({ stageIndex: 0, stageLabel: "Team", blockTimestamp: now }))).toEqual([])
  })

  it("shows a date on each stage row only when the stages span more than one day", () => {
    now = SEP6 - H
    process(nftCollection())
    const stages = [stage("GTD", 10, 0n), stage("Public", 30, 5n * 10n ** 14n)]
    const c = only(process(nftDrop({ stages, blockTimestamp: now })))
    expect(rows(c).slice(2)).toEqual([
      "gtd|Sep 6 10:00 UTC · free",
      "public|Sep 7 06:00 UTC · 0.0005 ETH",
    ])
  })

  it("is not feed-eligible for a burst that fails the structure gate or a page still pending", () => {
    now = SEP6 - H
    const gates = (o: object) =>
      nftCollection({
        gates: {
          page: "pass",
          structure: "pass",
          traits: "pass",
          farm: "pass",
          farmShareBps: 0,
          ...o,
        },
      })
    process(gates({ structure: "fail" }))
    expect(
      only(process(nftDrop({ stages: HORNET_STAGES, blockTimestamp: now }))).feedEligible,
    ).toBe(false)
    state = createNftState()
    process(gates({ page: "pending", structure: "pending" }))
    expect(
      only(process(nftDrop({ stages: HORNET_STAGES, blockTimestamp: now }))).feedEligible,
    ).toBe(false)
    state = createNftState()
    process(gates({ traits: "pending", farm: "pending" }))
    // The page and structure gates passed and the verdict isn't filtered: eligible before the mint proves the rest.
    expect(
      only(process(nftDrop({ stages: HORNET_STAGES, blockTimestamp: now }))).feedEligible,
    ).toBe(true)
    state = createNftState()
    process(nftCollection({ verdict: "filtered" }))
    expect(
      only(process(nftDrop({ stages: HORNET_STAGES, blockTimestamp: now }))).feedEligible,
    ).toBe(false)
  })

  it("produces nothing when no non-Team stage is still ahead, or the event is late", () => {
    process(nftCollection())
    now = SEP6 + 20 * H
    expect(process(nftDrop({ stages: HORNET_STAGES, blockTimestamp: now }))).toEqual([])
    state = createNftState()
    now = SEP6 - H
    process(nftCollection())
    expect(process(nftDrop({ stages: [HORNET_STAGES[0]!], blockTimestamp: now }))).toEqual([])
    expect(process(nftDrop({ stages: HORNET_STAGES, blockTimestamp: now - 31 * 60 }))).toEqual([])
    expect(process(nftDrop({ stages: HORNET_STAGES, blockTimestamp: now - 29 * 60 }))).toHaveLength(
      1,
    )
  })
})

describe("MINT STARTING", () => {
  beforeEach(() => {
    now = SEP6 - 5 * H
    process(nftCollection({ creator }))
    process(nftDrop({ stages: HORNET_STAGES, blockTimestamp: now }))
  })

  it("labels the GTD stage and fills its rows", () => {
    now = SEP6 + 10 * H
    const c = only(
      process(
        nftMint({
          stageIndex: 1,
          stageLabel: "GTD",
          stagePriceWei: "0",
          minted: "300",
          mintStartTs: SEP6 + 10 * H,
          stageStartTs: SEP6 + 10 * H,
          blockTimestamp: now,
        }),
      ),
    )
    expect(c).toMatchObject({
      alert: "mintstart",
      dedupeKey: `mintstart:${C}:1`,
      priority: 2,
      eventTs: now,
      feedEligible: false,
    })
    expect(card(c).title).toBe("MINT STARTING · GTD")
    expect(rows(c)).toEqual([
      "price|free",
      "ends|13:00 UTC (in 3h)",
      "limit|1 per wallet",
      "list|588 wallets",
      "minted|300 / 2,222 (13%)",
      "creator|INKHornetDEV",
    ])
  })

  it("shows the date on ends when the stage runs past its day, and omits list for public", () => {
    now = SEP6 + 17 * H
    const stages = [
      ...HORNET_STAGES.slice(0, 3),
      stage("Public", 17, 5n * 10n ** 14n, {
        endTime: SEP6 + 17 * H + 21 * 24 * H,
        maxPerWallet: 10,
      }),
    ]
    process(nftDrop({ stages, blockTimestamp: now }))
    const c = only(
      process(
        nftMint({
          stageIndex: 3,
          stageLabel: "Public",
          stagePriceWei: String(5n * 10n ** 14n),
          minted: "1640",
          blockTimestamp: now,
          stageStartTs: now,
        }),
      ),
    )
    expect(card(c).title).toBe("MINT STARTING · Public")
    expect(rows(c)).toEqual([
      "price|0.0005 ETH",
      "ends|Sep 27 17:00 UTC (in 21d)",
      "limit|10 per wallet",
      "minted|1,640 / 2,222 (73%)",
      "creator|INKHornetDEV",
    ])
  })

  it("cuts a long stage label to 12 characters", () => {
    now = SEP6 + 10 * H
    const c = only(
      process(
        nftMint({ stageIndex: 1, stageLabel: "A very long stage label", blockTimestamp: now }),
      ),
    )
    expect(card(c).title).toBe("MINT STARTING · A very long…")
  })

  it("is feed-eligible only for the public stage", () => {
    const start = (label: string, index: number, h: number) =>
      process(
        nftMint({
          stageIndex: index,
          stageLabel: label,
          minted: "0",
          mintStartTs: SEP6 + 10 * H,
          stageStartTs: SEP6 + h * H,
          blockTimestamp: SEP6 + h * H,
        }),
      )
    now = SEP6 + 13 * H
    expect(only(start("FCFS", 2, 13)).feedEligible).toBe(false)
    now = SEP6 + 17 * H
    expect(only(start("Public", 0, 17)).feedEligible).toBe(true)
  })

  it("is not feed-eligible when the stage cannot be matched to the drop", () => {
    now = SEP6 + 10 * H
    const c = only(
      process(
        nftMint({
          stageIndex: 1,
          stageLabel: "Mystery",
          mintStartTs: SEP6 + 8 * H,
          stageStartTs: SEP6 + 8 * H,
          blockTimestamp: SEP6 + 10 * H,
        }),
      ),
    )
    expect(c.feedEligible).toBe(false)
  })

  it("gives nothing for a Team stage", () => {
    now = SEP6 + 9 * H
    expect(process(nftMint({ stageIndex: 0, stageLabel: "Team", blockTimestamp: now }))).toEqual([])
  })

  it("is dropped after 3 minutes in the queue", () => {
    now = SEP6 + 10 * H + 181
    expect(
      process(nftMint({ stageIndex: 1, stageLabel: "GTD", blockTimestamp: SEP6 + 10 * H })),
    ).toEqual([])
    now = SEP6 + 10 * H + 179
    expect(
      process(nftMint({ stageIndex: 1, stageLabel: "GTD", blockTimestamp: SEP6 + 10 * H })),
    ).toHaveLength(1)
  })
})

describe("MINT STARTING without stages", () => {
  it("is the stage-less non-SeaDrop mint, reading minting for 32m", () => {
    process(
      nftCollection({
        seadrop: false,
        kind: "continuous",
        maxSupply: "4440",
        name: "PRTSCN",
        safelist: "verified",
        creator: {
          address: "0x7171000000000000000000000000000000007866",
          username: null,
          verified: false,
        },
      }),
    )
    now = SEP6 + 32 * 60
    const c = only(
      process(
        nftMint({
          stageLabel: "Mint",
          stageIndex: 0,
          minted: "2960",
          maxSupply: "4440",
          mintStartTs: SEP6,
          stageStartTs: SEP6,
          blockTimestamp: now,
        }),
      ),
    )
    expect(c).toMatchObject({
      alert: "mintstart",
      // Keeps the key MINT LIVE used, so a mint that already alerted is not sent again.
      dedupeKey: `mintlive:${C}`,
      priority: 2,
      feedEligible: true,
    })
    expect(card(c)).toMatchObject({ title: "MINT STARTING", name: "PRTSCN", verified: true })
    expect(rows(c)).toEqual([
      "minting|for 32m",
      "minted|2,960 / 4,440 (66%)",
      "creator|0x7171…7866",
    ])
  })

  it("reads minted without a total when the max supply is unknown", () => {
    process(nftCollection({ seadrop: false, maxSupply: null }))
    now = SEP6 + 1800
    const c = only(
      process(
        nftMint({
          stageLabel: "Mint",
          minted: "2960",
          maxSupply: "0",
          mintStartTs: SEP6,
          blockTimestamp: now,
        }),
      ),
    )
    expect(rows(c)).toEqual(["minting|for 30m", "minted|2,960"])
  })
})

describe("MINTED", () => {
  it("fills the 50% rows", () => {
    process(nftCollection({ creator }))
    process(nftDrop({ stages: HORNET_STAGES, blockTimestamp: SEP6 }))
    now = SEP6 + 13 * H + 2 * 60
    const c = only(
      process(
        nftMint({
          kind: "progress",
          markBps: 5000,
          stageIndex: 2,
          stageLabel: "FCFS",
          stagePriceWei: String(25n * 10n ** 13n),
          minted: "1111",
          mintStartTs: SEP6 + 13 * H + 2 * 60 - (4 * H + 2 * 60),
          stageStartTs: SEP6 + 13 * H,
          minters: 612,
          blockTimestamp: now,
        }),
      ),
    )
    expect(c).toMatchObject({
      alert: "minted",
      dedupeKey: `minted:5000:${C}`,
      priority: 3,
      markBps: 5000,
    })
    expect(c.feedEligible).toBe(false)
    expect(card(c).title).toBe("MINTED 50%")
    expect(rows(c)).toEqual([
      "minted|1,111 / 2,222 in 4h 2m",
      "stage|FCFS, started 2m ago · 0.00025 ETH",
      "minters|612 wallets",
    ])
  })

  it("reads free for a free stage, and leaves the stage row out for a stage-less mint", () => {
    process(nftCollection({ seadrop: false }))
    now = SEP6 + 1000
    const c = only(
      process(
        nftMint({
          kind: "progress",
          markBps: 2500,
          stageLabel: "Mint",
          stagePriceWei: "0",
          minters: 1,
          mintStartTs: SEP6,
          blockTimestamp: now,
        }),
      ),
    )
    expect(card(c).title).toBe("MINTED 25%")
    expect(rows(c).map((r) => r.split("|")[0])).toEqual(["minted", "minters"])
    expect(rows(c).at(-1)).toBe("minters|1 wallet")
  })

  it("is dropped after 30 minutes", () => {
    process(nftCollection())
    now = SEP6 + 1801
    expect(process(nftMint({ kind: "progress", markBps: 5000, blockTimestamp: SEP6 }))).toEqual([])
  })
})

describe("SOLD OUT", () => {
  const out = (o: Partial<ReturnType<typeof nftMint>> = {}) =>
    nftMint({
      kind: "sold_out",
      stageIndex: 2,
      stageLabel: "Community",
      stagePriceWei: String(5n * 10n ** 14n),
      minted: "1000",
      maxSupply: "1000",
      mintStartTs: SEP6,
      minters: 901,
      stageCounts: [
        { stageIndex: 0, label: "Team", minted: "100" },
        { stageIndex: 1, label: "Core", minted: "487" },
        { stageIndex: 2, label: "Community", minted: "413" },
        { stageIndex: 3, label: "Dead", minted: "0" },
      ],
      blockTimestamp: SEP6 + 2 * H,
      ...o,
    })
  const drop = () =>
    nftDrop({
      stages: [
        stage("Team", 0, 0n, { allowlistCount: 5 }),
        stage("Core", 0, 0n),
        stage("Community", 1, 5n * 10n ** 14n),
        stage("Dead", 2, 5n * 10n ** 14n),
      ],
      maxSupply: "1000",
    })

  it("lists minted, the mint price range, floor and listed, minters and the non-Team stage counts", () => {
    process(nftCollection({ name: "INKverse" }))
    process(drop())
    process({ ...nftStatsLike(5_500_000_000_000_000n, 84) })
    now = SEP6 + 2 * H
    const c = only(process(out()))
    expect(c).toMatchObject({ alert: "soldout", dedupeKey: `soldout:${C}`, priority: 1 })
    expect(rows(c)).toEqual([
      "minted|1,000 in 2h 0m",
      "mint|free – 0.0005 ETH",
      "floor|0.0055 ETH (11x mint)",
      "listed|84 (8.4%)",
      "minters|901 wallets",
      "stages|Core 487 · Community 413",
    ])
  })

  it("omits floor and listed when nothing is listed, and the multiple when every stage was free", () => {
    process(nftCollection())
    process(nftDrop({ stages: [stage("Core", 0, 0n)], maxSupply: "1000" }))
    process(nftStatsLike(null, 0))
    now = SEP6 + 2 * H
    const c = only(
      process(
        out({ stageCounts: [{ stageIndex: 0, label: "Core", minted: "1000" }], stageIndex: 0 }),
      ),
    )
    expect(rows(c).map((r) => r.split("|")[0])).toEqual(["minted", "mint", "minters", "stages"])
    expect(rows(c)[1]).toBe("mint|free")
    process(nftStatsLike(4n * 10n ** 15n, 5))
    const free = only(
      process(
        out({ stageCounts: [{ stageIndex: 0, label: "Core", minted: "1000" }], stageIndex: 0 }),
      ),
    )
    expect(rows(free)).toContain("floor|0.004 ETH")
  })

  it("leaves stages out for a mint without stages", () => {
    process(nftCollection({ seadrop: false }))
    now = SEP6 + 2 * H
    const c = only(process(out({ stageCounts: undefined, stageLabel: "Mint", stagePriceWei: "0" })))
    expect(rows(c).map((r) => r.split("|")[0])).toEqual(["minted", "minters"])
  })

  it("SOLD OUT for a collection without stages has minted, floor without a multiple, listed and minters", () => {
    process(nftCollection({ seadrop: false }))
    process({ ...nftStatsLike(4n * 10n ** 15n, 5) })
    now = SEP6 + 2 * H
    const c = only(process(out({ stageCounts: undefined, stageLabel: "Mint", stagePriceWei: "0" })))
    expect(rows(c)).toEqual([
      "minted|1,000 in 2h 0m",
      "floor|0.004 ETH",
      "listed|5 (0.5%)",
      "minters|901 wallets",
    ])
  })

  it("a SeaDrop SOLD OUT keeps its mint row and multiple", () => {
    process(nftCollection({ seadrop: true }))
    process(nftDrop({ stages: [stage("Core", 0, 5n * 10n ** 14n)], maxSupply: "1000" }))
    process({ ...nftStatsLike(4n * 10n ** 15n, 5) })
    now = SEP6 + 2 * H
    const c = only(
      process(
        out({ stageCounts: [{ stageIndex: 0, label: "Core", minted: "1000" }], stageIndex: 0 }),
      ),
    )
    expect(rows(c).slice(0, 3)).toEqual([
      "minted|1,000 in 2h 0m",
      "mint|0.0005 ETH",
      "floor|0.004 ETH (8x mint)",
    ])
  })
})

function nftStatsLike(floorWei: bigint | null, listedCount: number) {
  return {
    ...nftStats(),
    floorWei: floorWei === null ? null : String(floorWei),
    listedCount,
  }
}

describe("catch-up when a collection turns real", () => {
  it("sends one MINT STARTING reading started 34m ago, with no back-filled marks, and the original stage_start repeats its dedupe key", () => {
    const start = SEP6 + 10 * H
    process(
      nftCollection({
        verdict: "pending",
        gates: {
          page: "pending",
          structure: "pending",
          traits: "pending",
          farm: "n/a",
          farmShareBps: null,
        },
      }),
    )
    process(nftDrop({ stages: HORNET_STAGES, blockTimestamp: SEP6 - H }))
    now = start
    const original = only(
      process(
        nftMint({
          stageIndex: 1,
          stageLabel: "GTD",
          blockTimestamp: start,
          stageStartTs: start,
          mintStartTs: start,
        }),
      ),
    )
    expect(original.feedEligible).toBe(false)
    process(
      nftMint({
        kind: "progress",
        markBps: 2500,
        stageIndex: 1,
        blockTimestamp: start + 600,
        mintStartTs: start,
      }),
    )
    now = start + 34 * 60
    const caught = process(nftCollection({ verdict: "real", blockTimestamp: now }))
    const c = only(caught)
    expect(c).toMatchObject({
      alert: "mintstart",
      dedupeKey: original.dedupeKey,
      eventTs: now,
      feedEligible: false,
    })
    expect(card(c).title).toBe("MINT STARTING · GTD")
    expect(rows(c)[0]).toBe("started|34m ago")
    // Another real snapshot sends nothing: the verdict did not change.
    expect(process(nftCollection({ verdict: "real", blockTimestamp: now + 5 }))).toEqual([])
  })

  it("sends UPCOMING MINT when the first stage is still ahead", () => {
    now = SEP6 - 4 * H
    process(
      nftCollection({
        verdict: "pending",
        gates: {
          page: "pending",
          structure: "pending",
          traits: "pending",
          farm: "n/a",
          farmShareBps: null,
        },
      }),
    )
    process(nftDrop({ stages: HORNET_STAGES, blockTimestamp: now }))
    const caught = process(nftCollection({ verdict: "real", blockTimestamp: now }))
    const c = only(caught)
    expect(c).toMatchObject({ alert: "upcoming", dedupeKey: `upcoming:${C}`, feedEligible: true })
  })

  it("sends UPCOMING MINT when gates 1 and 2 first pass, before the verdict is real", () => {
    now = SEP6 - 4 * H
    process(
      nftCollection({
        verdict: "pending",
        gates: {
          page: "pending",
          structure: "pending",
          traits: "pending",
          farm: "n/a",
          farmShareBps: null,
        },
      }),
    )
    process(nftDrop({ stages: HORNET_STAGES, blockTimestamp: now }))
    const c = only(
      process(
        nftCollection({
          verdict: "pending",
          gates: {
            page: "pass",
            structure: "pass",
            traits: "pending",
            farm: "n/a",
            farmShareBps: null,
          },
          blockTimestamp: now,
        }),
      ),
    )
    expect(c.alert).toBe("upcoming")
  })

  it("sends MINT STARTING for a stage-less mint, and nothing once it sold out", () => {
    const start = SEP6
    process(nftCollection({ seadrop: false, verdict: "pending" }))
    now = start + 40 * 60
    process(nftMint({ stageLabel: "Mint", blockTimestamp: now, mintStartTs: start }))
    const c = only(process(nftCollection({ seadrop: false, verdict: "real", blockTimestamp: now })))
    expect(c).toMatchObject({ alert: "mintstart", dedupeKey: `mintlive:${C}`, eventTs: now })
    expect(rows(c)[0]).toBe("minting|for 40m")
    state = createNftState()
    process(nftCollection({ verdict: "pending" }))
    process(nftMint({ blockTimestamp: now, mintStartTs: start }))
    process(nftMint({ kind: "sold_out", blockTimestamp: now }))
    expect(process(nftCollection({ verdict: "real", blockTimestamp: now }))).toEqual([])
  })

  it("sends nothing once the stage has ended", () => {
    const start = SEP6 + 10 * H
    process(nftCollection({ verdict: "pending" }))
    process(nftDrop({ stages: HORNET_STAGES, blockTimestamp: SEP6 - H }))
    now = start
    process(
      nftMint({
        stageIndex: 1,
        stageLabel: "GTD",
        blockTimestamp: start,
        stageStartTs: start,
        mintStartTs: start,
      }),
    )
    now = SEP6 + 13 * H + 60 // GTD ended at 13:00
    expect(process(nftCollection({ verdict: "real", blockTimestamp: now }))).toEqual([])
  })

  it("without a stage end time, catches up only within an hour of the stage start", () => {
    const start = SEP6 + 17 * H
    const publicStart = () => {
      process(nftCollection({ verdict: "pending" }))
      process(nftDrop({ stages: HORNET_STAGES, blockTimestamp: SEP6 - H }))
      now = start
      process(
        nftMint({
          stageIndex: 3,
          stageLabel: "Public",
          blockTimestamp: start,
          stageStartTs: start,
          mintStartTs: SEP6 + 10 * H,
        }),
      )
    }
    publicStart()
    now = start + 59 * 60
    expect(only(process(nftCollection({ verdict: "real", blockTimestamp: now }))).alert).toBe(
      "mintstart",
    )
    state = createNftState()
    publicStart()
    process(
      nftMint({
        kind: "progress",
        markBps: 5000,
        stageIndex: 3,
        stageLabel: "Public",
        blockTimestamp: start + 2 * H,
        stageStartTs: start,
        mintStartTs: SEP6 + 10 * H,
      }),
    )
    now = start + 2 * H + 30 * 60
    expect(process(nftCollection({ verdict: "real", blockTimestamp: now }))).toEqual([])
    now = start + 3 * H + 60
    expect(process(nftCollection({ verdict: "pending", blockTimestamp: now }))).toEqual([])
    expect(process(nftCollection({ verdict: "real", blockTimestamp: now }))).toEqual([])
  })

  it("sends no MINT STARTING catch-up when the latest mint is over an hour old", () => {
    process(nftCollection({ seadrop: false, verdict: "pending" }))
    now = SEP6 + 40 * 60
    process(nftMint({ stageLabel: "Mint", blockTimestamp: now, mintStartTs: SEP6 }))
    now += H + 60
    expect(
      process(nftCollection({ seadrop: false, verdict: "real", blockTimestamp: now })),
    ).toEqual([])
  })

  describe("age of the stage", () => {
    const start = SEP6
    const openStage = [stage("Public", 0, 5n * 10n ** 14n, { endTime: start + 30 * 24 * H })]
    /** A Public stage that started at `start` and ends in a month, with a mint a few minutes before `at`. */
    const mintingSince = (at: number) => {
      process(nftCollection({ verdict: "pending" }))
      process(nftDrop({ stages: openStage, blockTimestamp: start - H }))
      now = start
      process(
        nftMint({
          stageIndex: 0,
          stageLabel: "Public",
          blockTimestamp: start,
          stageStartTs: start,
          mintStartTs: start,
        }),
      )
      process(
        nftMint({
          kind: "progress",
          markBps: 2500,
          stageIndex: 0,
          stageLabel: "Public",
          blockTimestamp: at - 300,
          stageStartTs: start,
          mintStartTs: start,
        }),
      )
      now = at
    }

    it("sends no catch-up when the collection turns real 3 days after the stage started", () => {
      mintingSince(start + 3 * 24 * H)
      expect(process(nftCollection({ verdict: "real", blockTimestamp: now }))).toEqual([])
    })

    it("sends one catch-up when the collection turns real 30 minutes after the stage started", () => {
      mintingSince(start + 30 * 60)
      const c = only(process(nftCollection({ verdict: "real", blockTimestamp: now })))
      expect(c.alert).toBe("mintstart")
      expect(rows(c)[0]).toBe("started|30m ago")
    })

    it("sends the catch-up at exactly CATCH_UP_MAX_S after the stage started, and not a second later", () => {
      mintingSince(start + CATCH_UP_MAX_S)
      expect(only(process(nftCollection({ verdict: "real", blockTimestamp: now }))).alert).toBe(
        "mintstart",
      )
      state = createNftState()
      mintingSince(start + CATCH_UP_MAX_S + 1)
      expect(process(nftCollection({ verdict: "real", blockTimestamp: now }))).toEqual([])
    })

    it("sends no MINT STARTING catch-up for a stage-less mint that started 3 days ago and minted 10 minutes ago", () => {
      process(nftCollection({ seadrop: false, verdict: "pending" }))
      process(
        nftMint({
          stageLabel: "Mint",
          blockTimestamp: start,
          mintStartTs: start,
          stageStartTs: start,
        }),
      )
      now = start + 3 * 24 * H
      process(
        nftMint({
          kind: "progress",
          markBps: 2500,
          stageLabel: "Mint",
          blockTimestamp: now - 600,
          mintStartTs: start,
          stageStartTs: start,
        }),
      )
      expect(
        process(nftCollection({ seadrop: false, verdict: "real", blockTimestamp: now })),
      ).toEqual([])
    })

    it("still sends UPCOMING MINT when the first stage is days ahead", () => {
      now = start
      process(nftCollection({ verdict: "pending" }))
      process(
        nftDrop({
          stages: [stage("Public", 3 * 24, 5n * 10n ** 14n)],
          blockTimestamp: now,
        }),
      )
      const c = only(process(nftCollection({ verdict: "real", blockTimestamp: now })))
      expect(c).toMatchObject({ alert: "upcoming", dedupeKey: `upcoming:${C}` })
    })
  })

  it("sends nothing on a verdict change to real when there is no drop and no mint", () => {
    now = SEP6
    process(nftCollection({ verdict: "pending" }))
    expect(process(nftCollection({ verdict: "real" }))).toEqual([])
  })
})

describe("Chimera launches", () => {
  const TOKEN = addr(0xd2)
  const launch = (o = {}) =>
    nftLaunch({
      contract: C,
      token: TOKEN,
      blockTimestamp: SEP6,
      creator: addr(0xc1),
      tokenSymbol: "BLOOP",
      tokenName: "Bloop",
      ...o,
    })
  const page = { name: "Bloop", imageUrl: "https://i.example/b.png" }

  it("a Chimera launch sends no NEW COLLECTION, held or not", () => {
    now = SEP6 + 30
    // With a page, the launch is not held.
    process(nftCollection({ launchpad: "chimera", launchToken: TOKEN, ...page }))
    expect(process(launch())).toEqual([])
    // Without one it is held, and the page appearing later still sends nothing.
    state = createNftState()
    process(nftCollection({ launchpad: "chimera", name: null, imageUrl: null, verdict: "pending" }))
    expect(process(launch())).toEqual([])
    now = SEP6 + 3 * 24 * H
    expect(process(nftCollection({ launchpad: "chimera", ...page, blockTimestamp: now }))).toEqual(
      [],
    )
    expect(
      process(nftCollection({ launchpad: "chimera", ...page, blockTimestamp: now + 5 })),
    ).toEqual([])
  })

  describe("newCollectionCard", () => {
    const build = (col: Parameters<typeof nftCollection>[0], l = {}) => {
      process(nftCollection({ launchpad: "chimera", launchToken: TOKEN, ...col }))
      process(launch(l))
      return newCollectionCard(state.get(C)!, state.get(C)!.launch!)
    }

    it("reads the name and ticker from the launch, lists the token address and has no social link", () => {
      const c = build({
        ...page,
        name: "BLOOP",
        links: { twitter: null, website: null, discord: null },
      })
      expect(c).toMatchObject({
        title: "NEW COLLECTION",
        name: "Bloop",
        marketplace: "Chimera",
        links: [],
      })
      expect(c.extra).toEqual([["token", TOKEN]])
      expect(c.rows.map(([l, v]) => `${l}|${v}`)).toEqual([
        "type|Chimera-404",
        "token|$BLOOP",
        "creator|0x0000…00c1",
      ])
    })

    it("shows the creator's OpenSea username when one exists", () => {
      const c = build({
        ...page,
        creator: { address: addr(0xc1), username: "bloopdev", verified: true },
      })
      expect(c.rows.at(-1)).toEqual(["creator", "bloopdev ✓"])
    })
  })
})

describe("NOW ON NFTX", () => {
  const LD = fx.lilDudes.collection.contract
  const BC = fx.bubbleCats.launch.contract
  const HI = fx.humanInk.launch.contract
  const open = fx.lilDudes.launch
  const col = (o: Partial<ReturnType<typeof nftCollection>> = {}) => ({
    ...fx.lilDudes.collection,
    ...o,
  })
  const stats = (o = {}) => nftStats({ contract: LD, totalSupply: "3333", owners: 212, ...o })
  beforeEach(() => {
    now = open.blockTimestamp + 60
  })

  it("Lil Dudes' open sends NOW ON NFTX · NFTX with floor 0.0009 ETH ($2.16), pool 35 NFTs, supply, holders and creator 0x9860…3b40, dedupe nftx:<contract>", () => {
    process(col())
    // Supply and holders are synthetic: the recorded open has no OpenSea stats.
    process(stats())
    const c = only(process(open))
    expect(c).toMatchObject({
      alert: "launch",
      target: LD,
      dedupeKey: `nftx:${LD}`,
      priority: 3,
      eventTs: open.blockTimestamp,
      feedEligible: true,
    })
    expect(c.separate).toBeUndefined()
    expect(card(c)).toMatchObject({
      title: "NOW ON NFTX",
      name: "Lil Dudes",
      marketplace: "NFTX",
      link: "nftx",
      nftxSlug: "lil-dudes",
      extra: [],
    })
    expect(rows(c)).toEqual([
      "floor|0.0009 ETH ($2.16)",
      "pool|35 NFTs",
      "supply|3,333",
      "holders|212",
      "creator|0x9860…3b40",
    ])
  })

  it("leaves supply, holders and the floor dollars out when they are not known", () => {
    process(col())
    const noRate = nftxOpenCard(
      state.get(LD)!,
      { ...open, nftxFloorWei: null, poolCount: null },
      null,
    )
    expect(noRate.rows.map(([l]) => l)).toEqual(["creator"])
    // An open the indexer wrote without the pool fields reads the same as null ones.
    const { nftxFloorWei: _f, poolCount: _c, ...bare } = open
    expect(nftxOpenCard(state.get(LD)!, bare, null).rows.map(([l]) => l)).toEqual(["creator"])
    const c = only(process(open))
    expect(rows(c)).toEqual(["floor|0.0009 ETH ($2.16)", "pool|35 NFTs", "creator|0x9860…3b40"])
  })

  it("shows the creator's OpenSea username when the page names the same account", () => {
    const creator = { address: open.creator, username: "dudemaker", verified: true }
    process(col({ creator }))
    expect(rows(only(process(open))).at(-1)).toBe("creator|dudemaker ✓")
    // Another account named on the page is not the NFTX creator.
    state = createNftState()
    process(col({ creator: { address: addr(0xaa), username: "someone", verified: false } }))
    expect(rows(only(process(open))).at(-1)).toBe("creator|0x9860…3b40")
  })

  it("an open whose collection is pending sends nothing, and sends once when a mark turns it real", () => {
    const bc = fx.bubbleCats.launch
    now = bc.blockTimestamp + 60
    const pending = col({
      contract: BC,
      verdict: "pending",
      manual: false,
      slug: "ink-bubble-cats-nft",
    })
    process(pending)
    expect(process(bc)).toEqual([])
    now += 3 * 24 * H
    const c = only(process({ ...pending, verdict: "real", manual: true, blockTimestamp: now }))
    expect(c).toMatchObject({
      alert: "launch",
      dedupeKey: `nftx:${BC}`,
      // The held open goes out stamped with the time the mark arrived.
      eventTs: now,
      feedEligible: true,
      separate: true,
    })
    expect(card(c)).toMatchObject({
      title: "NOW ON NFTX",
      marketplace: "NFTX",
      nftxSlug: "ink-bubble-cats",
    })
    expect(rows(c).slice(0, 2)).toEqual(["floor|0.00025 ETH ($0.60)", "pool|30 NFTs"])
  })

  it("a hand-marked collection with no OpenSea page reads its name from the open", () => {
    process(
      col({
        name: null,
        imageUrl: null,
        slug: null,
        openseaUrl: null,
        links: { twitter: null, website: null, discord: null },
      }),
    )
    const c = only(process(open))
    expect(card(c)).toMatchObject({
      name: "Lil Dudes",
      slug: null,
      imageUrl: null,
      nftxSlug: "lil-dudes",
    })
  })

  it("a second real snapshot and a real → filtered → real flip repeat the same dedupe key", () => {
    const hi = fx.humanInk.launch
    now = hi.blockTimestamp + 60
    const snap = (verdict: "pending" | "real" | "filtered", t = now) =>
      col({ contract: HI, verdict, name: "Human ink", blockTimestamp: t })
    process(snap("pending"))
    expect(process(hi)).toEqual([])
    now += 600
    const first = only(process(snap("real")))
    // The same snapshot again is not a transition.
    expect(process(snap("real", now + 1))).toEqual([])
    expect(process(snap("filtered", now + 2))).toEqual([])
    const again = only(process(snap("real", now + 3)))
    expect(first.dedupeKey).toBe(`nftx:${HI}`)
    expect(again.dedupeKey).toBe(first.dedupeKey)
    // A week after the open nothing is held any more.
    now = hi.blockTimestamp + LAUNCH_HOLD_S + 60
    expect(process(snap("filtered", now))).toEqual([])
    expect(process(snap("real", now + 1))).toEqual([])
  })

  it("is not sent from a held open older than the NFT alerts cutoff", () => {
    since = open.blockTimestamp + 1
    process(col({ verdict: "pending", manual: false }))
    process(open)
    expect(process(col({ verdict: "real" }))).toEqual([])
  })

  it("none of the three backfilled opens sends NOW ON NFTX, live or when Human ink turns real 21 days later", () => {
    // The indexer's backfill replays the three opens (2026-10-29) on 2026-11-19.
    for (const l of [fx.lilDudes.launch, fx.bubbleCats.launch]) {
      now = l.blockTimestamp + 21 * 24 * H
      process(col({ contract: l.contract }))
      expect(process(l)).toEqual([])
    }
    const hi = fx.humanInk.launch
    now = hi.blockTimestamp + 21 * 24 * H
    process(col({ contract: HI, verdict: "pending", manual: false }))
    expect(process(hi)).toEqual([])
    expect(process(col({ contract: HI, verdict: "real", blockTimestamp: now }))).toEqual([])
  })

  it("a collection launched on Chimera and opened on NFTX keeps both launches and sends NOW ON NFTX once, labelled · NFTX", () => {
    process(col({ launchpad: "chimera" }))
    expect(process(nftLaunch({ contract: LD, blockTimestamp: open.blockTimestamp }))).toEqual([])
    const c = only(process(open))
    expect(c.dedupeKey).toBe(`nftx:${LD}`)
    expect(card(c)).toMatchObject({ marketplace: "NFTX", link: "nftx" })
    expect(state.get(LD)).toMatchObject({
      launch: { launchpad: "chimera" },
      nftxLaunch: { launchpad: "nftx" },
    })
  })

  it("an open more than 30 minutes old sends nothing", () => {
    process(col())
    now = open.blockTimestamp + 31 * 60
    expect(process(open)).toEqual([])
  })

  describe("mint alerts of a collection on NFTX", () => {
    const milestone = (o = {}) =>
      nftMint({
        contract: LD,
        kind: "progress",
        markBps: 5000,
        stagePriceWei: "0",
        minted: "30",
        maxSupply: "60",
        mintStartTs: open.blockTimestamp,
        stageStartTs: open.blockTimestamp,
        blockTimestamp: now,
        ...o,
      })

    it("MINTED for a collection on NFTX without an OpenSea slug reads · NFTX and opens /n/x/<slug>", () => {
      process(col({ slug: null, name: "Lil Dudes" }))
      process(open)
      const c = only(process(milestone()))
      expect(card(c)).toMatchObject({ title: "MINTED 50%", marketplace: "NFTX", link: "nftx" })
      expect(nftViewPath(card(c))).toBe("/n/x/lil-dudes")
    })

    it("with an OpenSea slug it reads · OpenSea", () => {
      process(col({ slug: "lildudes3333" }))
      process(open)
      const c = only(process(milestone()))
      expect(card(c)).toMatchObject({ marketplace: "OpenSea", link: "opensea" })
      expect(nftViewPath(card(c))).toBe("/n/c/lildudes3333")
    })

    it("the other mint alerts follow the same label", () => {
      process(col({ slug: null }))
      process(open)
      const sold = only(process(milestone({ kind: "sold_out", markBps: null, minted: "60" })))
      expect(card(sold)).toMatchObject({ title: "SOLD OUT", marketplace: "NFTX", link: "nftx" })
      const start = only(
        process(milestone({ kind: "stage_start", markBps: null, stageLabel: "", minted: "5" })),
      )
      expect(card(start)).toMatchObject({ title: "MINT STARTING", marketplace: "NFTX" })
      // Scheduled drops and their edits, on a collection that has not sold out.
      state = createNftState()
      process(col({ slug: null }))
      process(open)
      now = SEP6 - 2 * 24 * H + 6 * H
      const first = only(
        process(nftDrop({ contract: LD, stages: HORNET_STAGES, blockTimestamp: now })),
      )
      expect(card(first)).toMatchObject({
        title: "UPCOMING MINT",
        marketplace: "NFTX",
        link: "nftx",
      })
      const edited = process(
        nftDrop({
          contract: LD,
          stages: HORNET_STAGES.map((s) =>
            s.label === "Public" ? { ...s, priceWei: eth(6n * 10n ** 14n) } : s,
          ),
          blockTimestamp: now,
        }),
      )
      expect(edited.map((c) => card(c).title)).toContain("MINT UPDATED")
      for (const c of edited.filter((c) => card(c).title === "MINT UPDATED"))
        expect(card(c)).toMatchObject({ marketplace: "NFTX", link: "nftx" })
    })

    it("mintMarket is NFTX only for a collection on NFTX with no OpenSea slug", () => {
      // A collection row from NFTX with no NFTX link name yet still reads NFTX, and links to its home page.
      process(col({ slug: null }))
      expect(mintMarket(state.get(LD)!)).toEqual({ market: "nftx", nftxSlug: null })
      process(open)
      expect(mintMarket(state.get(LD)!)).toEqual({ market: "nftx", nftxSlug: "lil-dudes" })
      process(col({ slug: "lildudes3333" }))
      expect(mintMarket(state.get(LD)!)).toEqual({})
      state = createNftState()
      process(nftCollection({ slug: null }))
      expect(mintMarket(state.get(C)!)).toEqual({})
    })
  })
})

it("shows no dollar amounts on any mint alert", () => {
  process(nftCollection({ creator }))
  now = SEP6 - H
  const all = [
    ...process(nftDrop({ stages: HORNET_STAGES, blockTimestamp: now })),
    ...process(
      nftMint({
        stageIndex: 2,
        stageLabel: "FCFS",
        stagePriceWei: String(25n * 10n ** 13n),
        blockTimestamp: now,
      }),
    ),
    ...process(
      nftMint({
        kind: "progress",
        markBps: 5000,
        stagePriceWei: String(25n * 10n ** 13n),
        blockTimestamp: now,
      }),
    ),
    ...process(
      nftMint({ kind: "sold_out", stagePriceWei: String(25n * 10n ** 13n), blockTimestamp: now }),
    ),
  ]
  expect(all.length).toBeGreaterThanOrEqual(3)
  for (const c of all) for (const [, v] of card(c).rows) expect(v).not.toContain("$")
})

// Production, 2026-10-25: two collections that minted long before the indexer's history each had one
// fresh mint. The indexer stamped that first stored mint as the stage start and crossed every mark at
// once, and the rules judged lateness by the event's block time.
describe("an old mint that mints again", () => {
  const legacyCol = (o: Parameters<typeof nftCollection>[0] = {}) =>
    nftCollection({
      kind: "legacy",
      seadrop: false,
      maxSupply: "6500",
      gates: { page: "pass", structure: "n/a", traits: "pending", farm: "n/a", farmShareBps: null },
      ...o,
    })
  const fresh = (o: Partial<ReturnType<typeof nftMint>> = {}) =>
    nftMint({
      stageIndex: 0,
      stageLabel: "Public",
      minted: "5822",
      maxSupply: "6500",
      minters: 1,
      mintStartTs: now,
      stageStartTs: now,
      blockTimestamp: now,
      ...o,
    })
  // Ink ATM Gang's schedule: two one-minute presales, then a public stage from Sep 7.
  const sep7 = SEP6 + 24 * H
  const ATM_STAGES = [
    stage("GTD", 24, 0n, { endTime: sep7 + 60, allowlistCount: 24 }),
    stage("WL", 24, 0n, { startTime: sep7 + 60, endTime: sep7 + 120, allowlistCount: 24 }),
    stage("Public", 24, 0n, { startTime: sep7 + 120, endTime: sep7 + 160 * 24 * H }),
  ]

  it("sends no MINT STARTING or MINTED for a legacy collection (Ink ATM Gang)", () => {
    now = SEP6 + 48 * 24 * H
    process(legacyCol())
    expect(process(fresh())).toEqual([])
    expect(process(fresh({ kind: "progress", markBps: 5000 }))).toEqual([])
    expect(process(fresh({ kind: "sold_out", minted: "6500" }))).toEqual([])
  })

  it("sends no MINT STARTING or MINTED once every stage of the schedule has ended (Krak Mask)", () => {
    now = SEP6 + 48 * 24 * H
    process(nftCollection({ kind: "drop", seadrop: true }))
    process(
      nftDrop({
        stages: [
          stage("GTD", 0, 0n, { endTime: SEP6 + 60, allowlistCount: 24 }),
          stage("Public", 0, 0n, { startTime: SEP6 + 60, endTime: SEP6 + 10 * 24 * H }),
        ],
        blockTimestamp: now - 60,
      }),
    )
    expect(process(fresh())).toEqual([])
    expect(process(fresh({ kind: "progress", markBps: 5000 }))).toEqual([])
  })

  it("sends no MINT STARTING when the scheduled stage started long ago and is still open", () => {
    now = SEP6 + 48 * 24 * H
    process(nftCollection({ kind: "drop", seadrop: true }))
    process(nftDrop({ stages: ATM_STAGES, blockTimestamp: now - 60 }))
    expect(process(fresh())).toEqual([])
  })

  it("still sends MINT STARTING for a stage whose scheduled start is a few minutes ago", () => {
    now = sep7 + 120 + 5 * 60
    process(nftCollection({ kind: "drop", seadrop: true }))
    process(nftDrop({ stages: ATM_STAGES, blockTimestamp: sep7 - H }))
    expect(only(process(fresh({ minted: "12" }))).alert).toBe("mintstart")
  })

  it("sends nothing for a drop change once the mint has started or ended", () => {
    now = SEP6 + 48 * 24 * H
    process(nftCollection({ kind: "drop", seadrop: true }))
    expect(process(nftDrop({ stages: ATM_STAGES, blockTimestamp: now }))).toEqual([])
    expect(
      process(
        nftDrop({
          stages: [stage("Public", 0, 0n, { endTime: SEP6 + 24 * H })],
          blockTimestamp: now,
        }),
      ),
    ).toEqual([])
  })

  it("sends no catch-up when a legacy collection turns real", () => {
    now = SEP6 + 48 * 24 * H
    process(legacyCol({ verdict: "pending" }))
    process(fresh())
    expect(process(legacyCol({ verdict: "real", blockTimestamp: now + 15 }))).toEqual([])
  })
})

// SeaDrop numbers the public stage 0, while OpenSea's drop lists the presales first. Stages are matched
// by time, as the indexer names them, never by list position.
describe("stage matching", () => {
  const T = SEP6 + 10 * H
  const ORDERED = [
    stage("GTD", 10, 0n, { endTime: T + 60, maxPerWallet: 1, allowlistCount: 24 }),
    stage("WL", 10, 0n, {
      startTime: T + 60,
      endTime: T + 120,
      maxPerWallet: 1,
      allowlistCount: 24,
    }),
    stage("Public", 10, 2n * 10n ** 13n, {
      startTime: T + 120,
      endTime: T + 30 * 24 * H,
      maxPerWallet: 8888,
    }),
  ]
  const publicStart = (o: Partial<ReturnType<typeof nftMint>> = {}) =>
    nftMint({
      stageIndex: 0,
      stageLabel: "Public",
      stagePriceWei: String(2n * 10n ** 13n),
      minted: "40",
      maxSupply: "8888",
      mintStartTs: T,
      stageStartTs: T + 120,
      blockTimestamp: T + 120,
      ...o,
    })

  it("MINT STARTING shows the public stage's end and limit for SeaDrop stage 0", () => {
    now = T + 120
    process(nftCollection({ creator, maxSupply: "8888" }))
    process(nftDrop({ stages: ORDERED, blockTimestamp: T - H }))
    expect(rows(only(process(publicStart())))).toEqual([
      "price|0.00002 ETH",
      "ends|Oct 6 10:00 UTC (in 29d 23h)",
      "limit|8888 per wallet",
      "minted|40 / 8,888 (0%)",
      "creator|INKHornetDEV",
    ])
  })

  it("a catch-up reads the public stage's end, not the first listed stage's", () => {
    process(nftCollection({ verdict: "pending", maxSupply: "8888" }))
    process(nftDrop({ stages: ORDERED, blockTimestamp: T - H }))
    now = T + 120
    process(publicStart())
    now = T + 30 * 60
    expect(only(process(nftCollection({ verdict: "real", blockTimestamp: now }))).alert).toBe(
      "mintstart",
    )
  })

  it("SOLD OUT prices each stage by its own label", () => {
    now = T + 3 * H
    process(nftCollection({ maxSupply: "100" }))
    process(nftDrop({ stages: ORDERED, maxSupply: "100", blockTimestamp: T - H }))
    const c = only(
      process(
        nftMint({
          kind: "sold_out",
          stageIndex: 0,
          stageLabel: "Public",
          stagePriceWei: String(2n * 10n ** 13n),
          minted: "100",
          maxSupply: "100",
          mintStartTs: T,
          minters: 90,
          stageCounts: [
            { stageIndex: 0, label: "Public", minted: "60" },
            { stageIndex: 1, label: "GTD", minted: "40" },
          ],
          blockTimestamp: now,
        }),
      ),
    )
    expect(rows(c)).toContain("mint|free – 0.00002 ETH")
  })
})

describe("MINT UPDATED", () => {
  const first = () => {
    process(nftCollection())
    process(nftDrop({ stages: HORNET_STAGES, blockTimestamp: now }))
  }
  const change = (stages: NftDropStage[], o: Partial<ReturnType<typeof nftDrop>> = {}) =>
    process(nftDrop({ stages, blockTimestamp: now, ...o })).filter((c) => c.alert === "reminder")
  const swap = (label: string, o: Partial<NftDropStage>) =>
    HORNET_STAGES.map((s) => (s.label === label ? { ...s, ...o } : s))

  it("shows what changed before the mint, old → new with the stage, and the upcoming status", () => {
    now = SEP6 - 3 * H
    first()
    const c = only(
      change(
        HORNET_STAGES.map((s) =>
          s.label === "GTD"
            ? { ...s, startTime: s.startTime + H }
            : s.label === "Public"
              ? { ...s, priceWei: eth(6n * 10n ** 14n) }
              : s,
        ),
        { maxSupply: "3000" },
      ),
    )
    expect(c).toMatchObject({
      alert: "reminder",
      mintUpdate: true,
      target: C,
      dedupeKey: `mintupdate:${C}:${c.eventId}`,
    })
    expect(card(c).title).toBe("MINT UPDATED")
    expect(rows(c)).toEqual([
      "status|upcoming, first stage Sep 6 11:00 UTC",
      "price|0.0005 ETH → 0.0006 ETH · Public",
      "starts|Sep 6 10:00 UTC → Sep 6 11:00 UTC · GTD",
      "supply|2,222 → 3,000",
    ])
  })

  it("shows the minted count while live, and limit, ends and added or removed stages", () => {
    now = SEP6 + 11 * H
    first()
    process(nftMint({ stageIndex: 1, stageLabel: "GTD", minted: "300", maxSupply: "2222" }))
    const stages = [
      ...swap("GTD", { maxPerWallet: 10000, endTime: SEP6 + 14 * H }).filter(
        (s) => s.label !== "FCFS",
      ),
      stage("Bonus", 20, 0n),
    ]
    const c = only(change(stages))
    expect(rows(c)).toEqual([
      "status|live, minted 300 / 2,222",
      "ends|Sep 6 13:00 UTC → Sep 6 14:00 UTC · GTD",
      "limit|1 per wallet → 10,000 per wallet · GTD",
      "stages|+ Bonus, − FCFS",
    ])
  })

  it("sends nothing without a previous drop, without a shown change, or for a Team stage change", () => {
    now = SEP6 - 3 * H
    process(nftCollection())
    expect(change(HORNET_STAGES)).toEqual([])
    expect(change(HORNET_STAGES)).toEqual([])
    expect(change(swap("Team", { priceWei: eth(1n) }))).toEqual([])
    expect(change(swap("Team", { startTime: SEP6 }))).toEqual([])
  })

  it("sends nothing once the mint sold out or every stage ended", () => {
    now = SEP6 + 11 * H
    first()
    process(nftMint({ kind: "sold_out", minted: "2222", maxSupply: "2222" }))
    expect(change(swap("GTD", { maxPerWallet: 3 }))).toEqual([])
    state = createNftState()
    now = SEP6 + 40 * H
    const ended = HORNET_STAGES.map((s) => ({ ...s, endTime: SEP6 + 20 * H }))
    process(nftCollection())
    process(nftDrop({ stages: ended, blockTimestamp: now }))
    expect(change(ended.map((s) => ({ ...s, priceWei: eth(1n) })))).toEqual([])
  })

  it("is dropped when the event is older than the late window", () => {
    now = SEP6 - 3 * H
    first()
    now += 1000
    expect(change(swap("GTD", { maxPerWallet: 3 }), { blockTimestamp: now - 1000 })).toEqual([])
  })
})

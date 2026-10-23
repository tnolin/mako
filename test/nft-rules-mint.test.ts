import type { NftDropStage, NftEvent } from "@ink-indexer/events"
import { beforeEach, describe, expect, it } from "vitest"
import type { Row } from "../src/history"
import type { NftAlertCard } from "../src/nft/card"
import { mintRules } from "../src/nft/rules/mint"
import { createNftState, type NftState } from "../src/nft/state"
import type { Candidate } from "../src/rules/index"
import { addr, nftCollection, nftDrop, nftLaunch, nftMint, nftStats } from "./helpers/events"

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
  type: label === "Public" ? "public" : "allow_list",
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
beforeEach(() => {
  state = createNftState()
  n = 0
})
const ctx = () => ({ nft: state, now: () => now })
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
      feedEligible: true,
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

describe("MINT LIVE", () => {
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
      alert: "mintlive",
      dedupeKey: `mintlive:${C}`,
      priority: 2,
      feedEligible: true,
    })
    expect(card(c)).toMatchObject({ title: "MINT LIVE", name: "PRTSCN", verified: true })
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
    expect(rows(c).map((r) => r.split("|")[0])).toEqual(["minted", "mint", "minters"])
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
      feedEligible: true,
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

  it("sends MINT LIVE for a stage-less mint, and nothing once it sold out", () => {
    const start = SEP6
    process(nftCollection({ seadrop: false, verdict: "pending" }))
    now = start + 40 * 60
    process(nftMint({ stageLabel: "Mint", blockTimestamp: now, mintStartTs: start }))
    const c = only(process(nftCollection({ seadrop: false, verdict: "real", blockTimestamp: now })))
    expect(c).toMatchObject({ alert: "mintlive", dedupeKey: `mintlive:${C}`, eventTs: now })
    expect(rows(c)[0]).toBe("minting|for 40m")
    state = createNftState()
    process(nftCollection({ verdict: "pending" }))
    process(nftMint({ blockTimestamp: now, mintStartTs: start }))
    process(nftMint({ kind: "sold_out", blockTimestamp: now }))
    expect(process(nftCollection({ verdict: "real", blockTimestamp: now }))).toEqual([])
  })

  it("sends nothing on a verdict change to real when there is no drop and no mint", () => {
    now = SEP6
    process(nftCollection({ verdict: "pending" }))
    expect(process(nftCollection({ verdict: "real" }))).toEqual([])
  })
})

describe("NEW COLLECTION", () => {
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

  it("comes from nft.launch once the page has a name and an image, with no social link", () => {
    now = SEP6 + 30
    process(
      nftCollection({
        launchpad: "chimera",
        launchToken: TOKEN,
        name: "BLOOP",
        links: { twitter: null, website: null, discord: null },
        verdict: "pending",
        gates: {
          page: "pending",
          structure: "n/a",
          traits: "pending",
          farm: "n/a",
          farmShareBps: null,
        },
      }),
    )
    const c = only(process(launch()))
    expect(c).toMatchObject({
      alert: "launch",
      dedupeKey: `launch:${C}`,
      priority: 3,
      eventTs: SEP6,
      feedEligible: true,
    })
    expect(card(c)).toMatchObject({
      title: "NEW COLLECTION",
      name: "Bloop",
      marketplace: "Chimera",
      links: [],
    })
    expect(card(c).extra).toEqual([["token", TOKEN]])
    expect(rows(c)).toEqual(["type|Chimera-404", "token|$BLOOP", "creator|0x0000…00c1"])
  })

  it("is held until the page has a name and an image, then sent at receipt time", () => {
    now = SEP6 + 30
    expect(process(launch())).toEqual([])
    process(nftCollection({ launchpad: "chimera", name: null, imageUrl: null, verdict: "pending" }))
    now = SEP6 + 3 * 24 * H
    expect(
      process(
        nftCollection({ launchpad: "chimera", name: "Bloop", imageUrl: null, blockTimestamp: now }),
      ),
    ).toEqual([])
    const c = only(
      process(
        nftCollection({
          launchpad: "chimera",
          name: "Bloop",
          imageUrl: "https://i.example/b.png",
          blockTimestamp: now,
        }),
      ),
    )
    expect(c).toMatchObject({ alert: "launch", dedupeKey: `launch:${C}`, eventTs: now })
    // A later snapshot does not send it again.
    expect(
      process(
        nftCollection({
          launchpad: "chimera",
          name: "Bloop",
          imageUrl: "https://i.example/b.png",
          blockTimestamp: now + 5,
        }),
      ),
    ).toEqual([])
  })

  it("is never sent when no page with a name and an image appears", () => {
    now = SEP6 + 30
    expect(process(launch())).toEqual([])
    now = SEP6 + 7 * 24 * H
    expect(process(nftCollection({ launchpad: "chimera", name: null, imageUrl: null }))).toEqual([])
    expect(
      process(
        nftCollection({ launchpad: "chimera", name: "", imageUrl: "https://i.example/b.png" }),
      ),
    ).toEqual([])
  })

  it("is dropped when the launch event is older than 30 minutes", () => {
    process(nftCollection({ launchpad: "chimera" }))
    now = SEP6 + 31 * 60
    expect(process(launch())).toEqual([])
  })

  it("shows the creator's OpenSea username when one exists", () => {
    now = SEP6 + 30
    process(
      nftCollection({
        launchpad: "chimera",
        creator: { address: addr(0xc1), username: "bloopdev", verified: true },
      }),
    )
    expect(rows(only(process(launch()))).at(-1)).toBe("creator|bloopdev ✓")
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

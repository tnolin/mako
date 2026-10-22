import type {
  NftCollectionEvent,
  NftDropEvent,
  NftDropStage,
  NftLaunchEvent,
  NftMintEvent,
} from "@ink-indexer/events"
import { age, clean, count, inText, utcDate, utcTime, wallets } from "../../format"
import type { Row } from "../../history"
import type { Candidate, RuleCtx } from "../../rules/types"
import { type AlertKind, LONG_WINDOW, PRIORITY } from "../../settings"
import {
  creatorRow,
  ethText,
  makeNftAlertCard,
  multiple,
  type NftAlertCard,
  type NftAlertKind,
  shortAddr,
} from "../card"
import { isTeamStage } from "../policy"
import type { CollectionState } from "../state"

type MintCtx = Pick<RuleCtx, "nft" | "now">
type Rows = NftAlertCard["rows"]

const lateS = (kind: AlertKind) => ((LONG_WINDOW as readonly string[]).includes(kind) ? 1800 : 180)
const isLate = (kind: AlertKind, ts: number, now: number) => now - ts > lateS(kind)

/** `free` for 0, else the ETH amount. Mint alerts never show dollars. */
const price = (wei: string | bigint): string =>
  BigInt(wei) === 0n ? "free" : ethText(BigInt(wei), null)
const knownMax = (max: string | null | undefined): max is string => !!max && BigInt(max) > 0n
/** `300 / 2,222 (13%)`, or just the count when the max supply is unknown. */
function mintedText(minted: string, max: string | null | undefined): string {
  if (!knownMax(max)) return count(Number(minted))
  const pct = Number((BigInt(minted) * 100n) / BigInt(max))
  return `${count(Number(minted))} / ${count(Number(max))} (${pct}%)`
}
const sameDay = (a: number, b: number) => utcDate(a) === utcDate(b)
const label = (s: string) => clean(s, 12)

const upcomingEligible = (col: NftCollectionEvent | null | undefined): boolean =>
  !!col && col.verdict !== "filtered" && col.gates.page === "pass" && col.gates.structure === "pass"
const feedOk = (st: CollectionState) => st.col?.verdict === "real"
const pageOk = (col: { name: string | null; imageUrl: string | null } | null | undefined) =>
  !!col?.name && !!col.imageUrl
/** A mint with no stages (not a SeaDrop drop): its one `stage_start` reads MINT LIVE. */
const stageless = (st: CollectionState): boolean => (st.col ? !st.col.seadrop : !st.drop)

type Base = { eventId: string; contract: string }
function cand(
  b: Base,
  alert: NftAlertKind,
  dedupeKey: string,
  card: NftAlertCard,
  eventTs: number,
  feedEligible: boolean,
  extra: Partial<Candidate> = {},
): Candidate {
  return {
    alert,
    eventId: b.eventId,
    target: b.contract,
    dedupeKey,
    priority: PRIORITY[alert],
    eventTs,
    card,
    feedEligible,
    ...extra,
  }
}

/** The first stage that isn't a Team stage, and only if it is still ahead. */
function firstOpenStage(drop: NftDropEvent | null, now: number): NftDropStage | null {
  const first = drop?.stages.find((s) => !isTeamStage(s))
  return first && first.startTime > now ? first : null
}

function upcoming(b: Base, st: CollectionState, drop: NftDropEvent, now: number): Candidate | null {
  const stages = drop.stages.filter((s) => !isTeamStage(s))
  const first = firstOpenStage(drop, now)
  if (!first) return null
  // A stage row shows its date only when the stages span more than one day.
  const dates = stages.some((s) => !sameDay(s.startTime, first.startTime))
  const rows: Rows = [
    ["starts", `${utcTime(first.startTime, true)} (in ${inText(first.startTime - now)})`],
  ]
  if (knownMax(drop.maxSupply)) rows.push(["supply", count(Number(drop.maxSupply))])
  for (const s of stages)
    rows.push([
      label(s.label.toLowerCase()),
      `${utcTime(s.startTime, dates)} · ${price(s.priceWei)}`,
    ])
  const creator = creatorRow(st.col)
  if (creator) rows.push(creator)
  const card = makeNftAlertCard("upcoming", "UPCOMING MINT", st.col, rows, { contract: b.contract })
  return cand(
    b,
    "upcoming",
    `upcoming:${b.contract}`,
    card,
    drop.blockTimestamp,
    upcomingEligible(st.col),
  )
}

/** MINT STARTING for a stage, or MINT LIVE for a mint without stages. `at` is the event time, or now for a catch-up. */
function stageStart(
  b: Base,
  st: CollectionState,
  ev: NftMintEvent,
  at: number,
  catchUp: boolean,
): Candidate | null {
  const creator = creatorRow(st.col)
  if (stageless(st)) {
    const rows: Rows = [
      ["minting", `for ${age(at - ev.mintStartTs)}`],
      ["minted", mintedText(ev.minted, ev.maxSupply)],
    ]
    if (creator) rows.push(creator)
    const card = makeNftAlertCard("mintlive", "MINT LIVE", st.col, rows, { contract: b.contract })
    return cand(b, "mintlive", `mintlive:${b.contract}`, card, at, feedOk(st))
  }
  const stage = st.drop?.stages[ev.stageIndex]
  if (isTeamStage({ label: ev.stageLabel, allowlistCount: stage?.allowlistCount ?? null }))
    return null
  const rows: Rows = []
  if (catchUp) rows.push(["started", `${age(at - ev.stageStartTs)} ago`])
  rows.push(["price", price(ev.stagePriceWei)])
  if (stage?.endTime != null) {
    rows.push([
      "ends",
      `${utcTime(stage.endTime, !sameDay(stage.endTime, ev.stageStartTs))} (in ${inText(stage.endTime - at)})`,
    ])
  }
  if (stage?.maxPerWallet != null) rows.push(["limit", `${stage.maxPerWallet} per wallet`])
  if (stage?.allowlistCount != null) rows.push(["list", wallets(stage.allowlistCount)])
  rows.push(["minted", mintedText(ev.minted, ev.maxSupply)])
  if (creator) rows.push(creator)
  const card = makeNftAlertCard(
    "mintstart",
    `MINT STARTING · ${label(ev.stageLabel)}`,
    st.col,
    rows,
    {
      contract: b.contract,
    },
  )
  return cand(b, "mintstart", `mintstart:${b.contract}:${ev.stageIndex}`, card, at, feedOk(st))
}

function minted(b: Base, st: CollectionState, ev: NftMintEvent): Candidate | null {
  if (ev.markBps === null) return null
  const rows: Rows = [
    [
      "minted",
      `${mintedText(ev.minted, ev.maxSupply).replace(/ \(\d+%\)$/, "")} in ${age(ev.blockTimestamp - ev.mintStartTs)}`,
    ],
  ]
  if (!stageless(st)) {
    rows.push([
      "stage",
      `${label(ev.stageLabel)}, started ${age(ev.blockTimestamp - ev.stageStartTs)} ago · ${price(ev.stagePriceWei)}`,
    ])
  }
  rows.push(["minters", wallets(ev.minters)])
  const card = makeNftAlertCard("minted", `MINTED ${ev.markBps / 100}%`, st.col, rows, {
    contract: b.contract,
  })
  return cand(
    b,
    "minted",
    `minted:${ev.markBps}:${b.contract}`,
    card,
    ev.blockTimestamp,
    feedOk(st),
    {
      markBps: ev.markBps,
    },
  )
}

function soldOut(b: Base, st: CollectionState, ev: NftMintEvent): Candidate {
  const rows: Rows = [
    ["minted", `${count(Number(ev.minted))} in ${age(ev.blockTimestamp - ev.mintStartTs)}`],
  ]
  // The stages that sold something, without Team stages: their prices and counts.
  const stages = (ev.stageCounts ?? [])
    .filter((s) => Number(s.minted) > 0)
    .map((s) => ({ ...s, def: st.drop?.stages[s.stageIndex] }))
    .filter((s) => !isTeamStage({ label: s.label, allowlistCount: s.def?.allowlistCount ?? null }))
  const prices =
    stages.length > 0
      ? stages.map((s) => BigInt(s.def?.priceWei ?? ev.stagePriceWei))
      : [BigInt(ev.stagePriceWei)]
  const lo = prices.reduce((a, c) => (c < a ? c : a))
  const hi = prices.reduce((a, c) => (c > a ? c : a))
  rows.push(["mint", lo === hi ? price(lo) : `${price(lo)} – ${price(hi)}`])
  const stats = st.stats
  const floor = stats?.floorWei != null && stats.listedCount !== 0 ? BigInt(stats.floorWei) : null
  if (floor !== null) {
    rows.push([
      "floor",
      `${ethText(floor, null)}${hi > 0n ? ` (${multiple(floor, hi)} mint)` : ""}`,
    ])
  }
  if (stats?.listedCount) {
    const supply = Number(knownMax(ev.maxSupply) ? ev.maxSupply : ev.minted)
    rows.push([
      "listed",
      stats.listedCapped
        ? `${count(stats.listedCount)}+`
        : `${count(stats.listedCount)} (${Number(((stats.listedCount / supply) * 100).toFixed(1))}%)`,
    ])
  }
  rows.push(["minters", wallets(ev.minters)])
  if (stages.length > 0) {
    rows.push([
      "stages",
      stages.map((s) => `${label(s.label)} ${count(Number(s.minted))}`).join(" · "),
    ])
  }
  const card = makeNftAlertCard("soldout", "SOLD OUT", st.col, rows, { contract: b.contract })
  return cand(b, "soldout", `soldout:${b.contract}`, card, ev.blockTimestamp, feedOk(st))
}

function newCollection(
  b: Base,
  st: CollectionState,
  launch: NftLaunchEvent,
  eventTs: number,
): Candidate {
  const rows: Rows = [["type", "Chimera-404"]]
  if (launch.tokenSymbol) rows.push(["token", `$${clean(launch.tokenSymbol, 32)}`])
  rows.push(creatorRow(st.col) ?? ["creator", shortAddr(launch.creator)])
  const base = makeNftAlertCard("launch", "NEW COLLECTION", st.col, rows, {
    contract: b.contract,
    extra: [["token", launch.token]],
  })
  // The name and ticker come from the launch.
  const card = { ...base, name: clean(launch.tokenName, 64) || base.name }
  // The page check was passed, so the All collections feed may carry it.
  return cand(b, "launch", `launch:${b.contract}`, card, eventTs, true)
}

/**
 * Candidates for a mint, drop, collection or launch event. The state already holds the event, and `prev` is
 * the collection snapshot it replaced. A collection that turns `real` (or first passes gates 1 and 2) after
 * its mint started gets one catch-up alert for the current state, stamped with the receipt time.
 */
export function mintRules(
  ev: Row<NftMintEvent | NftDropEvent | NftCollectionEvent | NftLaunchEvent>,
  prev: NftCollectionEvent | null,
  ctx: MintCtx,
): Candidate[] {
  const p = ev.p
  const now = ctx.now()
  const st = ctx.nft.get(p.contract)
  if (!st) return []
  const b: Base = { eventId: ev.id, contract: p.contract }
  const out: (Candidate | null)[] = []
  switch (p.type) {
    case "nft.drop":
      if (!isLate("upcoming", p.blockTimestamp, now)) out.push(upcoming(b, st, p, now))
      break
    case "nft.mint":
      if (p.kind === "stage_start") {
        const kind = stageless(st) ? "mintlive" : "mintstart"
        if (!isLate(kind, p.blockTimestamp, now))
          out.push(stageStart(b, st, p, p.blockTimestamp, false))
      } else if (p.kind === "progress") {
        if (!isLate("minted", p.blockTimestamp, now)) out.push(minted(b, st, p))
      } else if (!isLate("soldout", p.blockTimestamp, now)) {
        out.push(soldOut(b, st, p))
      }
      break
    case "nft.launch":
      if (pageOk(st.col) && !isLate("launch", p.blockTimestamp, now)) {
        out.push(newCollection(b, st, p, p.blockTimestamp))
      }
      break
    case "nft.collection": {
      // A launch held for its page goes out the first time the snapshot has a name and an image.
      if (st.launch && pageOk(p) && !pageOk(prev)) out.push(newCollection(b, st, st.launch, now))
      const becameReal = prev?.verdict !== "real" && p.verdict === "real"
      const becameEligible = !upcomingEligible(prev) && upcomingEligible(p)
      if (becameReal || becameEligible) {
        const up = upcomingEligible(p) && st.drop ? upcoming(b, st, st.drop, now) : null
        if (up) out.push({ ...up, eventTs: now })
        else if (becameReal && st.lastStage && !st.soldOut) {
          out.push(stageStart(b, st, st.lastStage, now, true))
        }
      }
      break
    }
  }
  return out.filter((c): c is Candidate => c !== null)
}

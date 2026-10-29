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
import {
  CATCH_UP_MAX_S,
  isTeamStage,
  LAUNCH_HOLD_S,
  MINT_RECENT_S,
  STAGE_START_MAX_S,
} from "../policy"
import type { CollectionState } from "../state"

type MintCtx = Pick<RuleCtx, "nft" | "now" | "nftSince">
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
/**
 * The drop stage running at `ts`. SeaDrop numbers its stages its own way (the public stage is 0) and
 * OpenSea lists them in another order, so a mint's stage is matched by time, as the indexer names it:
 * the latest-starting stage whose `[startTime, endTime)` holds `ts`. Null when none does.
 */
function stageAt(drop: NftDropEvent | null, ts: number): NftDropStage | null {
  let best: NftDropStage | null = null
  for (const s of drop?.stages ?? [])
    if (
      s.startTime <= ts &&
      (s.endTime == null || ts < s.endTime) &&
      (!best || s.startTime > best.startTime)
    )
      best = s
  return best
}
/**
 * Whether the mint is still running: its stage ends in the future, or, with no end time, the newest mint
 * event is under an hour old. The catch-up and the collection card's mint row both use it.
 */
export function mintLive(st: CollectionState, now: number): boolean {
  const end = st.lastStage && stageAt(st.drop, st.lastStage.stageStartTs)?.endTime
  if (end != null) return end > now
  const seen = [st.lastStage, st.lastMark].filter((m) => m !== null).map((m) => m.blockTimestamp)
  return seen.length > 0 && now - Math.max(...seen) < MINT_RECENT_S
}
/**
 * The indexer stamps a stage start at the first mint it stores, so a collection that minted before its
 * history and mints again looks like a new mint. No mint alert for a `legacy` collection, or once every
 * stage of a known schedule has ended.
 */
function oldMint(st: CollectionState, now: number): boolean {
  if (st.col?.kind === "legacy") return true
  const stages = st.drop?.stages.filter((s) => !isTeamStage(s)) ?? []
  return stages.length > 0 && stages.every((s) => s.endTime != null && s.endTime <= now)
}
/** A known schedule needs an open stage whose scheduled start is within STAGE_START_MAX_S of now. */
function startDue(st: CollectionState, now: number): boolean {
  const stages = st.drop?.stages.filter((s) => !isTeamStage(s)) ?? []
  return (
    stages.length === 0 ||
    stages.some(
      (s) =>
        Math.abs(now - s.startTime) <= STAGE_START_MAX_S && (s.endTime == null || s.endTime > now),
    )
  )
}
/**
 * Whether the stage a mint event reports is the public one. The indexer types every drop stage and the
 * public sale is `public`; allowlist, Team and any other stage is private. A stage that can't be matched
 * to the drop is not treated as public.
 */
const publicStage = (st: CollectionState, ev: NftMintEvent): boolean =>
  stageAt(st.drop, ev.stageStartTs)?.type === "public"
/** A mint with no stages (not a SeaDrop drop): its one `stage_start` reads MINT STARTING without a stage label. */
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

/** The UPCOMING MINT card, or null once the first non-Team stage has started. The Upcoming list opens it too. */
export function upcomingCard(
  col: NftCollectionEvent | null,
  drop: NftDropEvent,
  now: number,
): NftAlertCard | null {
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
  const creator = creatorRow(col)
  if (creator) rows.push(creator)
  return makeNftAlertCard("upcoming", "UPCOMING MINT", col, rows, { contract: drop.contract })
}

function upcoming(b: Base, st: CollectionState, drop: NftDropEvent, now: number): Candidate | null {
  const card = upcomingCard(st.col, drop, now)
  if (!card) return null
  return cand(
    b,
    "upcoming",
    `upcoming:${b.contract}`,
    card,
    drop.blockTimestamp,
    upcomingEligible(st.col),
  )
}

/** MINT STARTING for a stage, or for a mint without stages (no stage label). `at` is the event time, or now for a catch-up. */
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
    const card = makeNftAlertCard("mintstart", "MINT STARTING", st.col, rows, {
      contract: b.contract,
    })
    // The key predates the fold into MINT STARTING; keeping it stops a second card for a mint already sent.
    return cand(b, "mintstart", `mintlive:${b.contract}`, card, at, feedOk(st))
  }
  const stage = stageAt(st.drop, ev.stageStartTs)
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
  // The All collections feed carries only the stage that opens the mint to everyone; a watcher gets every non-Team stage.
  return cand(
    b,
    "mintstart",
    `mintstart:${b.contract}:${ev.stageIndex}`,
    card,
    at,
    feedOk(st) && publicStage(st, ev),
  )
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
    // Progress marks go to watchers only.
    false,
    {
      markBps: ev.markBps,
    },
  )
}

function soldOut(b: Base, st: CollectionState, ev: NftMintEvent): Candidate {
  const rows: Rows = [
    ["minted", `${count(Number(ev.minted))} in ${age(ev.blockTimestamp - ev.mintStartTs)}`],
  ]
  // The stages that sold something, without Team stages: their prices and counts. A count names its
  // stage by the label the indexer matched by time, so the drop stage is found by that label.
  const stages = (ev.stageCounts ?? [])
    .filter((s) => Number(s.minted) > 0)
    .map((s) => ({ ...s, def: st.drop?.stages.find((d) => d.label === s.label) }))
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

/** Non-Team stages by label, to match a stage between two drop events. */
const byLabel = (drop: NftDropEvent) =>
  new Map(drop.stages.filter((s) => !isTeamStage(s)).map((s) => [s.label, s]))
const change = (a: string, b: string, stage?: string) =>
  `${a} → ${b}${stage === undefined ? "" : ` · ${label(stage)}`}`
const limitText = (n: number | null) => (n === null ? "none" : `${count(n)} per wallet`)
const endText = (t: number | null) => (t === null ? "open" : utcTime(t, true))

/** The latest minted count the state knows, over the drop's max supply. */
function liveMinted(st: CollectionState, drop: NftDropEvent): string {
  const seen = [st.lastStage, st.lastMark, st.soldOut].filter((m) => m !== null)
  const latest = seen.reduce((a, m) => (BigInt(m.minted) > a ? BigInt(m.minted) : a), 0n)
  const max = seen[0]?.maxSupply ?? drop.maxSupply
  return knownMax(max) ? `${count(Number(latest))} / ${count(Number(max))}` : count(Number(latest))
}

/**
 * MINT UPDATED: the changed fields between two drop events of a collection whose mint has not sold out
 * or ended. Team stages are left out, and stages are matched by label. Null when nothing shown changed.
 */
function mintUpdated(
  b: Base,
  st: CollectionState,
  drop: NftDropEvent,
  prev: NftDropEvent,
  now: number,
): Candidate | null {
  if (st.soldOut || oldMint(st, now)) return null
  const rows: Rows = []
  const before = byLabel(prev)
  const after = byLabel(drop)
  // One row per changed field and stage, in the order the card lists the fields.
  const fields: [string, (s: NftDropStage) => string][] = [
    ["price", (s) => price(s.priceWei)],
    ["starts", (s) => utcTime(s.startTime, true)],
    ["ends", (s) => endText(s.endTime)],
    ["limit", (s) => limitText(s.maxPerWallet)],
  ]
  for (const [field, show] of fields)
    for (const [name, s] of after) {
      const o = before.get(name)
      if (o && show(o) !== show(s)) rows.push([field, change(show(o), show(s), name)])
    }
  const moves = [
    ...[...after.keys()].filter((n) => !before.has(n)).map((n) => `+ ${label(n)}`),
    ...[...before.keys()].filter((n) => !after.has(n)).map((n) => `− ${label(n)}`),
  ]
  if (moves.length > 0) rows.push(["stages", moves.join(", ")])
  if (prev.maxSupply !== drop.maxSupply) {
    const n = (m: string | null | undefined) => (knownMax(m) ? count(Number(m)) : "unknown")
    rows.push(["supply", change(n(prev.maxSupply), n(drop.maxSupply))])
  }
  if (rows.length === 0) return null
  const first = [...after.values()][0]
  const status =
    first && first.startTime <= now
      ? `live, minted ${liveMinted(st, drop)}`
      : `upcoming${first ? `, first stage ${utcTime(first.startTime, true)}` : ""}`
  const card = makeNftAlertCard(
    "mintstart",
    "MINT UPDATED",
    st.col,
    [["status", status], ...rows],
    {
      contract: b.contract,
    },
  )
  return cand(
    b,
    "reminder",
    `mintupdate:${b.contract}:${b.eventId}`,
    card,
    drop.blockTimestamp,
    false,
    {
      mintUpdate: true,
    },
  )
}

/**
 * Candidates for a mint, drop, collection or launch event. The state already holds the event, and `prev` is
 * the collection or drop snapshot it replaced. A collection that turns `real` (or first passes the page and structure gates) after
 * its mint started gets one catch-up alert for the current state, stamped with the receipt time, only if the
 * stage it reports started at most CATCH_UP_MAX_S ago. A stage that has been open longer is not news.
 */
export function mintRules(
  ev: Row<NftMintEvent | NftDropEvent | NftCollectionEvent | NftLaunchEvent>,
  prevSnapshot: NftCollectionEvent | NftDropEvent | null,
  ctx: MintCtx,
): Candidate[] {
  const p = ev.p
  const prev = prevSnapshot?.type === "nft.collection" ? prevSnapshot : null
  const now = ctx.now()
  const st = ctx.nft.get(p.contract)
  if (!st) return []
  const b: Base = { eventId: ev.id, contract: p.contract }
  const out: (Candidate | null)[] = []
  switch (p.type) {
    case "nft.drop":
      if (!isLate("upcoming", p.blockTimestamp, now)) out.push(upcoming(b, st, p, now))
      if (prevSnapshot?.type === "nft.drop" && !isLate("reminder", p.blockTimestamp, now))
        out.push(mintUpdated(b, st, p, prevSnapshot, now))
      break
    case "nft.mint":
      if (oldMint(st, now)) break
      if (p.kind === "stage_start") {
        if (!isLate("mintstart", p.blockTimestamp, now) && startDue(st, now))
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
      // A launch held for its page goes out the first time the snapshot has a name and an image, within
      // a week of the launch and never for one from before the alerts cutoff.
      const held = st.launch
      if (
        held &&
        pageOk(p) &&
        !pageOk(prev) &&
        now - held.blockTimestamp <= LAUNCH_HOLD_S &&
        held.blockTimestamp >= (ctx.nftSince ?? 0)
      )
        out.push(newCollection(b, st, held, now))
      const becameReal = prev?.verdict !== "real" && p.verdict === "real"
      const becameEligible = !upcomingEligible(prev) && upcomingEligible(p)
      if (becameReal || becameEligible) {
        const up = upcomingEligible(p) && st.drop ? upcoming(b, st, st.drop, now) : null
        if (up) out.push({ ...up, eventTs: now })
        else if (
          becameReal &&
          st.lastStage &&
          !st.soldOut &&
          now - st.lastStage.stageStartTs <= CATCH_UP_MAX_S &&
          !oldMint(st, now) &&
          mintLive(st, now)
        ) {
          out.push(stageStart(b, st, st.lastStage, now, true))
        }
      }
      break
    }
  }
  return out.filter((c): c is Candidate => c !== null)
}

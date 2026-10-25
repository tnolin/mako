import type { Sql } from "./db"
import { cursorBlock } from "./history"
import type { Logger } from "./log"
import { DEFAULT_BIGSALE_WEI, ethTrim } from "./nft/policy"

export type HealthEvent = {
  level: "error" | "info"
  message: string
  /** Sentry groups by this: one issue per incident, so each incident is a new issue and emails. */
  fingerprint: string[]
  extra?: Record<string, unknown>
}

export type HealthDeps = {
  sql: Sql
  /** The chain's latest block. A throw skips the cursor check for that tick. */
  chainHead: () => Promise<bigint>
  /** A collection's current verdict, from the bot's NFT state. */
  verdictOf: (contract: string) => string | undefined
  report: (e: HealthEvent) => void
  /** Every report is also logged as `health`, and each run as `health checks`, for instances without Sentry. */
  log: Logger
  /** Unix seconds. */
  now?: () => number
}

type Result = { bad: boolean; message: string; extra?: Record<string, unknown> } | null
type Check = { name: string; label: string; forS: number; run: () => Promise<Result> }

const DAY_S = 86_400
const QUIET_KEY = "health:quiet"
const age = (s: number) =>
  s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m`

/**
 * The outage checks (ADR 0017), run every 5 minutes. Each error fires once per incident, kept in
 * `bot.state` so a restart doesn't fire it again, and sends a recovered note when it clears. A quiet
 * day with no alert sent gets one info note with a summary, at most once a day.
 */
export function createHealth(deps: HealthDeps) {
  const { sql } = deps
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  // shortcut: when a condition went bad is kept in memory, so a restart restarts the 10-minute wait of
  // the lag check. Keep it in bot.state too if restarts during an incident become common.
  const badSince = new Map<string, number>()

  const checks: Check[] = [
    {
      name: "events",
      label: "no new indexer events",
      forS: 0,
      async run() {
        const [r] = await sql<{ at: number }[]>`
          select extract(epoch from created_at)::float8 as at from indexer.events order by id desc limit 1`
        const idle = r ? now() - r.at : Number.POSITIVE_INFINITY
        return { bad: idle > 3600, message: "Health: no new indexer events for 60 minutes" }
      },
    },
    {
      name: "cursor",
      label: "indexer cursor behind the chain head",
      forS: 0,
      async run() {
        const head = await deps.chainHead().catch(() => null)
        const block = await cursorBlock(sql)
        if (head === null || block === null) return null
        const behind = head - BigInt(block)
        return {
          bad: behind > 100n,
          message: `Health: indexer cursor ${behind} blocks behind the chain head`,
          extra: { head: String(head), cursor: block },
        }
      },
    },
    {
      name: "lag",
      label: "bot behind the indexer",
      forS: 600,
      async run() {
        const [r] = await sql<{ behind: string | null }[]>`
          select ((select max(id) from indexer.events)
            - (select value::bigint from bot.state where key = 'events_cursor'))::text as behind`
        const behind = Number(r?.behind ?? 0)
        return {
          bad: behind > 500,
          message: `Health: bot ${behind} events behind the indexer for 10 minutes`,
        }
      },
    },
    {
      name: "failed",
      label: "failed deliveries",
      forS: 0,
      async run() {
        const [r] = await sql<{ n: number }[]>`
          select count(*)::int as n from bot.deliveries
          where status = 'failed' and created_at > to_timestamp(${now() - 3600})`
        return { bad: r!.n >= 10, message: `Health: ${r!.n} failed deliveries in the last hour` }
      },
    },
  ]

  async function open(): Promise<Map<string, number>> {
    const rows = await sql<{ key: string; value: string }[]>`
      select key, value from bot.state where key like 'health:%' and key <> ${QUIET_KEY}`
    return new Map(rows.map((r) => [r.key.slice("health:".length), Number(r.value)]))
  }

  function emit(kind: "error" | "recovered" | "quiet", check: string, e: HealthEvent): void {
    deps.log(e.level, "health", { kind, check, message: e.message })
    deps.report(e)
  }

  async function runCheck(
    c: Check,
    incidents: Map<string, number>,
  ): Promise<"ok" | "failing" | "skipped"> {
    const r = await c.run()
    if (r === null) return "skipped"
    const t = now()
    const started = incidents.get(c.name)
    if (!r.bad) {
      badSince.delete(c.name)
      if (started === undefined) return "ok"
      await sql`delete from bot.state where key = ${`health:${c.name}`}`
      emit("recovered", c.name, {
        level: "info",
        message: `Health recovered: ${c.label} (lasted ${age(t - started)})`,
        fingerprint: ["health", c.name, String(started), "recovered"],
      })
      return "ok"
    }
    const since = badSince.get(c.name) ?? t
    badSince.set(c.name, since)
    if (started !== undefined || t - since < c.forS) return "failing"
    await sql`insert into bot.state (key, value) values (${`health:${c.name}`}, ${String(t)})
      on conflict (key) do nothing`
    emit("error", c.name, {
      level: "error",
      message: r.message,
      fingerprint: ["health", c.name, String(t)],
      extra: r.extra,
    })
    return "failing"
  }

  async function quietDay(): Promise<void> {
    const t = now()
    const [r] = await sql<{ sent: boolean; last: string | null }[]>`
      select exists (select 1 from bot.deliveries where status = 'sent' and sent_at > to_timestamp(${t - DAY_S})) as sent,
        (select value from bot.state where key = ${QUIET_KEY}) as last`
    if (r!.sent || (r!.last !== null && t - Number(r!.last) < DAY_S)) return
    await sql`insert into bot.state (key, value) values (${QUIET_KEY}, ${String(t)})
      on conflict (key) do update set value = excluded.value`
    emit("quiet", "quiet", {
      level: "info",
      message: ["Health: no alert sent in 24 hours", ...(await summary())].join("\n"),
      fingerprint: ["health", "quiet", String(t)],
    })
  }

  /** What the last day held, so a quiet day reads as quiet rather than broken. */
  async function summary(): Promise<string[]> {
    const head = Number((await cursorBlock(sql)) ?? 0)
    // shortcut: Ink makes one block per second, so the last day is the last 86,400 blocks.
    const from = head - DAY_S
    const types = await sql<{ type: string; n: number }[]>`
      select type, count(*)::int as n from indexer.events where block >= ${from}
      group by type order by n desc, type`
    const rows = await sql<{ type: string; contract: string; price: string | null }[]>`
      select type, payload->>'contract' as contract, payload->>'priceWei' as price
      from indexer.events where block >= ${from} and type in ('nft.sale', 'nft.mint')`
    let best: bigint | null = null
    const mints = { real: 0, filtered: 0, other: 0 }
    for (const r of rows) {
      const v = deps.verdictOf(r.contract)
      if (r.type === "nft.mint")
        mints[v === "real" ? "real" : v === "filtered" ? "filtered" : "other"]++
      else if (v === "real" && r.price !== null && (best === null || BigInt(r.price) > best))
        best = BigInt(r.price)
    }
    return [
      `Events: ${types.map((x) => `${x.type} ${x.n}`).join(", ") || "none"}`,
      `Biggest sale in a real collection: ${best === null ? "none" : `${ethTrim(String(best))} ETH`} (BIG SALE minimum ${ethTrim(DEFAULT_BIGSALE_WEI)} ETH)`,
      `Mints: ${mints.real} from real collections, ${mints.filtered} from filtered, ${mints.other} other`,
    ]
  }

  return {
    async tick(): Promise<void> {
      const incidents = await open()
      const results: Record<string, string> = {}
      for (const c of checks) results[c.name] = await runCheck(c, incidents)
      deps.log("info", "health checks", results)
      await quietDay()
    },
  }
}

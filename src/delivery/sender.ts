import type postgres from "postgres"
import type { Payload } from "../cards/card"
import type { Sql } from "../db"
import type { Logger } from "../log"
import type { PendingRow, SendResult } from "../platforms/telegram/send"
import { type AlertKind, LONG_WINDOW, PRIORITY, readSettings } from "../settings"
import { createFailureLimiter } from "./limit"
import type { Notify } from "./notices"
import type { ChatType } from "./recipients"

export type SenderDeps = {
  sql: Sql
  send: (row: PendingRow) => Promise<SendResult>
  notify: Notify
  log: Logger
  report: (err: unknown) => void
  now?: () => number
  /** Shared by startSender so settle and tick failures are rate-limited together. */
  limiter?: ReturnType<typeof createFailureLimiter>
}

const MAX_IN_FLIGHT = 10
const PER_SECOND = 25
const MAX_ATTEMPTS = 5
const LONG = [...LONG_WINDOW] as string[]

export function createSender(deps: SenderDeps) {
  const { sql, notify } = deps
  const now = deps.now ?? Date.now
  // shortcut: throttle state lives in memory, so a restart forgets pacing for a few seconds. Upgrade path: persist next-send times in bot.state.
  const limiter = deps.limiter ?? createFailureLimiter({ report: deps.report, log: deps.log })
  const nextAt = new Map<string, number>()
  const recent: number[] = []

  const dropPending = (chatId: string, thread?: number | null) =>
    thread === undefined
      ? sql`update bot.deliveries set status = 'skipped', summarized = true where chat_id = ${chatId} and status = 'pending'`
      : sql`update bot.deliveries set status = 'skipped', summarized = true
            where chat_id = ${chatId} and status = 'pending' and thread_id is not distinct from ${thread}`

  async function lateDrop() {
    await sql`
      update bot.deliveries set status = 'skipped'
      where status = 'pending'
        and event_ts < now() - case when alert = any(${LONG}) then interval '30 minutes' else interval '3 minutes' end`
  }

  async function throttledCheck(chatId: string) {
    const [s] = await sql<{ n: number }[]>`
      select count(*)::int as n from bot.deliveries
      where chat_id = ${chatId} and alert = 'summary' and created_at > now() - interval '1 hour'`
    if ((s?.n ?? 0) < 3) return
    const feeds = await sql<{ alert: AlertKind; n: number }[]>`
      select alert, count(*)::int as n from bot.deliveries
      where chat_id = ${chatId} and status = 'skipped' and alert not in ('summary', 'notice')
        and created_at > now() - interval '1 hour'
      group by alert order by n desc, alert`
    const total = feeds.reduce((a, f) => a + f.n, 0)
    if (feeds[0])
      await notify(chatId, "throttled", { top: feeds[0].alert, topCount: feeds[0].n, total })
  }

  async function summarize() {
    const rows = await sql<
      { chatId: string; chatType: ChatType; thread: number | null; n: number }[]
    >`
      select d.chat_id::text as "chatId", min(d.chat_type) as "chatType",
             max((c.settings->>'thread')::int) as thread, count(*)::int as n
      from bot.deliveries d left join bot.chats c on c.chat_id = d.chat_id
      where d.status = 'skipped' and not d.summarized and d.alert not in ('summary', 'notice')
        and not exists (
          select 1 from bot.deliveries s
          where s.chat_id = d.chat_id and s.alert = 'summary' and s.created_at > now() - interval '10 minutes')
      group by d.chat_id`
    for (const r of rows) {
      const html = `${r.n} alert${r.n === 1 ? "" : "s"} skipped in the last 10 min due to high volume.`
      const payload: Payload =
        r.chatType === "private"
          ? { type: "text", html, buttons: [[{ text: "My alerts", data: "al:u" }]] }
          : { type: "text", html }
      await sql.begin(async (tx) => {
        await tx`update bot.deliveries set summarized = true where chat_id = ${r.chatId} and status = 'skipped' and not summarized`
        await tx`
          insert into bot.deliveries (chat_id, chat_type, thread_id, alert, dedupe_key, priority, event_ts, card)
          values (${r.chatId}, ${r.chatType}, ${r.chatType === "supergroup" ? r.thread : null}, 'summary',
                  ${`summary:${Date.now()}:${r.chatId}`}, ${PRIORITY.summary}, now(), ${tx.json(payload as unknown as postgres.JSONValue)})`
      })
      if (r.chatType !== "private") await throttledCheck(r.chatId)
    }
  }

  async function topicBroken(r: PendingRow) {
    const [c] = await sql<
      { settings: unknown }[]
    >`select settings from bot.chats where chat_id = ${r.chat_id}`
    const s = readSettings(c?.settings)
    if ((r.thread_id ?? null) === (s.thread ?? null)) {
      await sql`update bot.chats set active = false, paused_reason = 'topic' where chat_id = ${r.chat_id}`
      await dropPending(r.chat_id)
    } else {
      s.pausedRoutes = [...new Set([...(s.pausedRoutes ?? []), r.alert as AlertKind])]
      await sql`update bot.chats set settings = ${sql.json(s as unknown as postgres.JSONValue)} where chat_id = ${r.chat_id}`
      await dropPending(r.chat_id, r.thread_id)
    }
    await notify(r.chat_id, `topic:${r.alert}`, { alert: r.alert as AlertKind })
  }

  async function settle(r: PendingRow, res: SendResult) {
    const gap = r.chat_type === "private" ? 1000 : 3000
    if (res.ok || res.kind === "not_modified") {
      await sql`update bot.deliveries set status = 'sent', sent_at = now() where id = ${r.id}`
      nextAt.set(r.chat_id, now() + gap)
      return
    }
    switch (res.kind) {
      case "retry_after":
        nextAt.set(r.chat_id, now() + (res.retryAfter ?? 5) * 1000)
        return
      case "transient": {
        const attempts = r.attempts + 1
        await sql`
          update bot.deliveries set attempts = ${attempts}, error = ${res.description},
            status = case when ${attempts}::int >= ${MAX_ATTEMPTS}::int then 'failed' else status end
          where id = ${r.id}`
        if (attempts >= MAX_ATTEMPTS) {
          deps.log("warn", "delivery failed after retries", {
            chatId: r.chat_id,
            alert: r.alert,
            attempts,
            error: res.description,
          })
        }
        nextAt.set(r.chat_id, now() + 5000)
        return
      }
      case "blocked":
        await sql`update bot.users set blocked_at = now() where platform_user_id = ${r.chat_id}`
        await dropPending(r.chat_id)
        return
      case "removed":
        await sql`update bot.chats set removed_at = now(), active = false where chat_id = ${r.chat_id}`
        await dropPending(r.chat_id)
        await notify(r.chat_id, "removed")
        return
      case "rights":
        await sql`update bot.chats set active = false, paused_reason = 'rights' where chat_id = ${r.chat_id}`
        await dropPending(r.chat_id)
        await notify(r.chat_id, "rights")
        return
      case "topic":
        await topicBroken(r)
        return
      case "migrated":
        if (res.migrateTo === undefined) {
          await failOther(r, res, gap)
          return
        }
        await migrate(r.chat_id, String(res.migrateTo))
        return
      default:
        await failOther(r, res, gap)
    }
  }

  async function failOther(r: PendingRow, res: { kind: string; description: string }, gap: number) {
    await sql`update bot.deliveries set status = 'failed', error = ${res.description} where id = ${r.id}`
    deps.report(new Error(`send failed (${res.kind}): ${res.description}`))
    nextAt.set(r.chat_id, now() + gap)
  }

  /** A group that became a supergroup gets a new chat id; its queue follows, in one transaction. */
  async function migrate(from: string, to: string) {
    await sql.begin(async (tx) => {
      const [existing] = await tx`select 1 from bot.chats where chat_id = ${to}`
      if (existing) {
        await tx`update bot.chats set active = false, removed_at = now() where chat_id = ${from}`
      } else {
        await tx`update bot.chats set chat_id = ${to}, kind = 'supergroup' where chat_id = ${from}`
      }
      // Rows that already exist under the new id win; their old twins would collide on dedupe_key.
      await tx`
        delete from bot.deliveries d where d.chat_id = ${from} and d.status = 'pending'
          and exists (select 1 from bot.deliveries n where n.chat_id = ${to} and n.dedupe_key = d.dedupe_key)`
      await tx`
        update bot.deliveries set chat_id = ${to}, chat_type = 'supergroup'
        where chat_id = ${from} and status = 'pending'`
    })
  }

  return {
    async tick() {
      await lateDrop()
      await summarize()
      const t = now()
      while (recent.length > 0 && recent[0]! <= t - 1000) recent.shift()
      const budget = Math.min(MAX_IN_FLIGHT, PER_SECOND - recent.length)
      if (budget <= 0) return
      const heads = await sql<(PendingRow & { priority: number; created_at: Date })[]>`
        select distinct on (chat_id) id::text, chat_id::text, chat_type, thread_id, alert, token, card, attempts,
               priority, created_at
        from bot.deliveries where status = 'pending' order by chat_id, priority, created_at`
      // Across chats, the most urgent heads go first when the global budget can't cover them all.
      const ready = heads
        .filter((r) => (nextAt.get(r.chat_id) ?? 0) <= t)
        .sort((a, b) => a.priority - b.priority || a.created_at.getTime() - b.created_at.getTime())
        .slice(0, budget)
      let settleFailed = false
      await Promise.all(
        ready.map(async (r) => {
          recent.push(now())
          const res = await deps.send(r)
          try {
            await settle(r, res)
          } catch (err) {
            // One chat's failed write must not stop the others, nor re-send this row on the next tick.
            settleFailed = true
            nextAt.set(r.chat_id, now() + 5000)
            try {
              limiter.fail("settle", err)
            } catch {
              // Reporting must never end the tick.
            }
          }
        }),
      )
      if (ready.length > 0 && !settleFailed) limiter.ok("settle")
    },
  }
}

/** Ticks every 250 ms, one tick at a time. Returns a stop function. */
export function startSender(deps: SenderDeps): () => void {
  const limiter = deps.limiter ?? createFailureLimiter({ report: deps.report, log: deps.log })
  const sender = createSender({ ...deps, limiter })
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const loop = async () => {
    try {
      await sender.tick()
      limiter.ok("sender")
    } catch (err) {
      try {
        limiter.fail("sender", err)
      } catch {
        // Reporting must never end the loop; the next tick retries.
      }
    }
    if (!stopped) timer = setTimeout(loop, 250)
  }
  void loop()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

import type { Sql } from "../db"
import type { Logger } from "../log"

/** Rolls deliveries older than `days` into bot.delivery_daily and deletes them. Returns rows deleted. */
export async function runRetention(sql: Sql, days = 90): Promise<number> {
  const cutoff = `${days} days`
  return sql.begin(async (tx) => {
    await tx`
      insert into bot.delivery_daily (day, alert, chat_type, status, count)
      select created_at::date, alert, chat_type, status, count(*) from bot.deliveries
      where created_at < now() - ${cutoff}::interval
      group by 1, 2, 3, 4
      on conflict (day, alert, chat_type, status) do update set count = bot.delivery_daily.count + excluded.count`
    const deleted =
      await tx`delete from bot.deliveries where created_at < now() - ${cutoff}::interval`
    return deleted.count
  })
}

export function msUntil0300Utc(now: Date): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3))
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1)
  return next.getTime() - now.getTime()
}

/** Runs at startup, then daily at 03:00 UTC. Returns a stop function. */
export function startRetention(sql: Sql, log: Logger, report: (err: unknown) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = async () => {
    try {
      log("info", "retention done", { deleted: await runRetention(sql) })
    } catch (err) {
      log("error", "retention failed", { error: String(err) })
      report(err)
    }
    timer = setTimeout(run, msUntil0300Utc(new Date()))
  }
  void run()
  return () => clearTimeout(timer)
}

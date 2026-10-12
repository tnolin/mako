import type { Logger } from "../log"

/**
 * Loop failures: every failure is logged, Sentry gets the first one and then at most one per
 * `windowMs` per source while it keeps failing. Success after failures logs one recovery line.
 */
export function createFailureLimiter(deps: {
  report: (err: unknown) => void
  log: Logger
  now?: () => number
  windowMs?: number
}) {
  const now = deps.now ?? Date.now
  const windowMs = deps.windowMs ?? 10 * 60_000
  const failing = new Map<string, { since: number; reportedAt: number; count: number }>()
  return {
    fail(source: string, err: unknown): void {
      deps.log("error", `${source} failed`, { error: String(err) })
      const t = now()
      const s = failing.get(source)
      if (!s) {
        failing.set(source, { since: t, reportedAt: t, count: 1 })
        deps.report(err)
        return
      }
      s.count++
      if (t - s.reportedAt >= windowMs) {
        s.reportedAt = t
        deps.report(err)
      }
    },
    ok(source: string): void {
      const s = failing.get(source)
      if (!s) return
      failing.delete(source)
      deps.log("info", `${source} recovered`, {
        failures: s.count,
        seconds: Math.round((now() - s.since) / 1000),
      })
    },
  }
}

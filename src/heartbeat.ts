/**
 * Sentry cron heartbeat: `ok` while indexer.cursors.block moved in the last 10 minutes, `error`
 * otherwise. A dead bot or host shows up in Sentry as a missed check-in.
 */
export function createHeartbeat(deps: {
  readBlock: () => Promise<string | null>
  checkIn: (status: "ok" | "error") => void
  now?: () => number
  staleMs?: number
}) {
  const now = deps.now ?? Date.now
  const staleMs = deps.staleMs ?? 10 * 60_000
  let last: string | null | undefined
  let changedAt = now()
  return {
    async tick() {
      let block: string | null
      try {
        block = await deps.readBlock()
      } catch {
        deps.checkIn("error")
        return
      }
      if (block !== last) {
        last = block
        changedAt = now()
      }
      deps.checkIn(now() - changedAt <= staleMs ? "ok" : "error")
    },
  }
}

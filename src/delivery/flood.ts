/** More than this many launches on one launchpad within FLOOD_WINDOW_S is a flood. */
export const FLOOD_LAUNCHES = 10
export const FLOOD_WINDOW_S = 300
/** One NEW TOKENS card per chat per minute of flood, sent after the minute plus a grace for indexer lag. */
export const BATCH_S = 60
export const BATCH_GRACE_S = 30
export const BATCH_SHOWN = 10
export const BATCH_NAME_MAX = 20

export type LaunchMark = { id: string; launchpad: string; ts: number }

/**
 * Launch id → id of the launch that started its flood, for launches in flood. A launch is in flood when its
 * launchpad had more than FLOOD_LAUNCHES launches in the FLOOD_WINDOW_S up to and including it (id order).
 * `all` must hold every launch from at least 2 × FLOOD_WINDOW_S before the first launch the caller cares
 * about, so that launch's predecessor is classified with a full window. The sliding window assumes
 * timestamps never decrease in id order, which holds because events are inserted in block order.
 */
export function floodStarts(all: LaunchMark[]): Map<string, string> {
  const out = new Map<string, string>()
  const byLp = new Map<string, LaunchMark[]>()
  for (const l of all) byLp.set(l.launchpad, [...(byLp.get(l.launchpad) ?? []), l])
  for (const ls of byLp.values()) {
    let start: string | null = null
    let lo = 0
    for (let i = 0; i < ls.length; i++) {
      const l = ls[i]!
      while (ls[lo]!.ts <= l.ts - FLOOD_WINDOW_S) lo++
      if (i - lo + 1 > FLOOD_LAUNCHES) {
        start ??= l.id
        out.set(l.id, start)
      } else {
        start = null
      }
    }
  }
  return out
}

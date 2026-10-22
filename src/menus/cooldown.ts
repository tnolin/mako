export const REFRESH_COOLDOWN_MS = 15_000

/**
 * Per-key cooldown. Returns the whole seconds left, or 0 and records the tap.
 * shortcut: in memory and per process, so a restart clears it; expired keys are swept on every tap
 * (O(keys)). Move to a shared store only if the bot runs as several processes.
 */
export function refreshCooldown(
  ms: number,
  now: () => number = () => Date.now(),
): (key: string) => number {
  const last = new Map<string, number>()
  return (key) => {
    const t = now()
    for (const [k, at] of last) if (t - at >= ms) last.delete(k)
    const at = last.get(key)
    if (at !== undefined) return Math.ceil((ms - (t - at)) / 1000)
    last.set(key, t)
    return 0
  }
}

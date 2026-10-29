/** Below this 10-minute gain, in bps, a token's bonded PUMPING re-arms for every recipient. */
export const REARM_BPS = 500

/** One poll batch's view of the re-arm state: reads go through to the committed state, writes stay here. */
export type PumpDraft = {
  /** Whether `recipient` already had a PUMPING for `token` since the token last re-armed. */
  fired(token: string, recipient: string): boolean
  mark(token: string, recipient: string): void
  /** Records a token's current gain; under +5% it re-arms the token for everyone. */
  observe(token: string, gainBps: number): void
  /** Applies this draft's changes. Call it once the batch's deliveries are written. */
  commit(): void
}

/**
 * Bonded PUMPING fires once per recipient and token, then waits until the token's 10-minute gain falls under
 * +5%. Each poll batch works on a draft, so a batch whose write fails leaves the state as it was.
 */
// shortcut: re-arm state is in memory; a restart can repeat one PUMPING. Persist it in bot.state if repeats
// after deploys become a problem.
export class PumpArm {
  private fired = new Map<string, Set<string>>()

  draft(): PumpDraft {
    const touched = new Map<string, Set<string>>()
    const own = (token: string): Set<string> => {
      let s = touched.get(token)
      if (!s) {
        s = new Set(this.fired.get(token))
        touched.set(token, s)
      }
      return s
    }
    return {
      fired: (token, recipient) =>
        (touched.get(token) ?? this.fired.get(token))?.has(recipient) ?? false,
      mark: (token, recipient) => {
        own(token).add(recipient)
      },
      observe: (token, gainBps) => {
        if (gainBps < REARM_BPS) own(token).clear()
      },
      commit: () => {
        for (const [token, s] of touched) {
          if (s.size === 0) this.fired.delete(token)
          else this.fired.set(token, s)
        }
        touched.clear()
      },
    }
  }
}

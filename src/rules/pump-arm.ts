/** Below this 10-minute gain, in bps, a token's bonded PUMPING re-arms for every recipient. */
export const REARM_BPS = 500

/** One poll batch's view of the re-arm state: reads go through to the committed state, writes stay here. */
export type PumpDraft = {
  /** Whether `recipient` already had a PUMPING for `token` since the token last re-armed. */
  fired(token: string, recipient: string): boolean
  /** Records that event `eventId` sent `recipient` a PUMPING for `token`. */
  mark(token: string, recipient: string, eventId: string): void
  /** Records a token's gain at event `eventId`; under +5% it re-arms the token for everyone. */
  observe(token: string, gainBps: number, eventId: string): void
  /**
   * Applies this draft's changes, in event order: those of events up to and including `uptoId` when given, else all
   * that are left. Call it for the events whose deliveries are written.
   */
  commit(uptoId?: string): void
}

type Op =
  | { eventId: bigint; kind: "mark"; token: string; recipient: string }
  | { eventId: bigint; kind: "rearm"; token: string }

/**
 * Bonded PUMPING fires once per recipient and token, then waits until the token's 10-minute gain falls under
 * +5%. Each poll batch works on a draft and commits the changes of the events it has written, so a batch whose
 * write fails is routed again from the state its written events left.
 */
// shortcut: re-arm state is in memory; a restart can repeat one PUMPING. Persist it in bot.state if repeats
// after deploys become a problem.
export class PumpArm {
  private fired = new Map<string, Set<string>>()

  private apply(op: Op): void {
    if (op.kind === "rearm") {
      this.fired.delete(op.token)
      return
    }
    const s = this.fired.get(op.token) ?? new Set<string>()
    s.add(op.recipient)
    this.fired.set(op.token, s)
  }

  draft(): PumpDraft {
    // The draft's own view: the committed state plus every change it has recorded.
    const view = new Map<string, Set<string>>()
    const own = (token: string): Set<string> => {
      let s = view.get(token)
      if (!s) {
        s = new Set(this.fired.get(token))
        view.set(token, s)
      }
      return s
    }
    let ops: Op[] = []
    return {
      fired: (token, recipient) =>
        (view.get(token) ?? this.fired.get(token))?.has(recipient) ?? false,
      mark: (token, recipient, eventId) => {
        own(token).add(recipient)
        ops.push({ eventId: BigInt(eventId), kind: "mark", token, recipient })
      },
      observe: (token, gainBps, eventId) => {
        if (gainBps >= REARM_BPS) return
        own(token).clear()
        ops.push({ eventId: BigInt(eventId), kind: "rearm", token })
      },
      commit: (uptoId) => {
        const upto = uptoId === undefined ? null : BigInt(uptoId)
        const now = upto === null ? ops : ops.filter((o) => o.eventId <= upto)
        for (const op of now) this.apply(op)
        ops = upto === null ? [] : ops.filter((o) => o.eventId > upto)
      },
    }
  }
}

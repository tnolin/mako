export type Launchpad = {
  name: string
  tradeUrl: (ca: string) => string
  refParam: string
  refEnv: string
  /** The page that tags a visitor with a referral code, or the launchpad home without one. */
  referralUrl: (code?: string) => string
}

/** Every launchpad name in user-facing text comes from here. */
export const LAUNCHPADS = {
  inkypump: {
    name: "InkyPump",
    tradeUrl: (ca: string) => `https://inkypump.com/ink/trade/${ca}`,
    refParam: "ref",
    refEnv: "INKYPUMP_REF_CODE",
    referralUrl: (code) =>
      code
        ? `https://inkypump.com/ink/join/${encodeURIComponent(code)}`
        : "https://inkypump.com/ink",
  },
} satisfies Record<string, Launchpad>

export type LaunchpadKey = keyof typeof LAUNCHPADS

/**
 * Each token's launchpad key, held in memory so the Trade redirect never reads the database. Loaded once at start
 * and kept current by the poller from the launches it reads.
 * shortcut: one entry per launched token for the life of the process. Past a few hundred thousand tokens, keep
 * only recently traded ones and resolve the rest with a cached lookup.
 */
export class TokenLaunchpads {
  private readonly byToken: Map<string, string>
  constructor(entries: Iterable<readonly [string, string]> = []) {
    this.byToken = new Map(entries)
  }
  set(token: string, key: string): void {
    this.byToken.set(token, key)
  }
  get(token: string): string | undefined {
    return this.byToken.get(token)
  }
}

// shortcut: an unknown key falls back to the first launchpad, which is only right while there is one.
// Upgrade path: once a second launchpad exists, treat an unknown key as an error.
export function launchpadOf(key: string, list: Record<string, Launchpad> = LAUNCHPADS): Launchpad {
  return list[key] ?? Object.values(list)[0]!
}

export function tradeLink(
  key: string,
  ca: string,
  env: Record<string, string | undefined> = process.env,
  list: Record<string, Launchpad> = LAUNCHPADS,
): string {
  const lp = launchpadOf(key, list)
  const url = new URL(lp.tradeUrl(ca))
  const code = env[lp.refEnv]
  if (code) url.searchParams.set(lp.refParam, code)
  return url.href
}

/**
 * The Trade redirect's target: each token's trade page on its own launchpad, from the in-memory map, so the
 * redirect never reads the database. A token the map doesn't hold yet goes to InkyPump.
 */
export function tradeTarget(
  launchpads: TokenLaunchpads,
  env: Record<string, string | undefined> = process.env,
  list: Record<string, Launchpad> = LAUNCHPADS,
): (ca: string) => string {
  return (ca) => tradeLink(launchpads.get(ca) ?? "inkypump", ca, env, list)
}

export function referralLink(
  key: string,
  env: Record<string, string | undefined> = process.env,
  list: Record<string, Launchpad> = LAUNCHPADS,
): string {
  const lp = launchpadOf(key, list)
  return lp.referralUrl(env[lp.refEnv] || undefined)
}

/** "A", "A or B", "A, B or C". */
export function launchpadNames(list: Record<string, Launchpad> = LAUNCHPADS): string {
  const names = Object.values(list).map((l) => l.name)
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`
}

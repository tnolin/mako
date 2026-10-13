export type Launchpad = {
  name: string
  tradeUrl: (ca: string) => string
  refParam: string
  refEnv: string
  /** Image hosts whose links Telegram previews; other hosts are sent with sendPhoto. */
  previewHosts: readonly string[]
}

/** Every launchpad name in user-facing text comes from here. */
export const LAUNCHPADS = {
  inkypump: {
    name: "InkyPump",
    tradeUrl: (ca: string) => `https://inkypump.com/ink/trade/${ca}`,
    refParam: "ref",
    refEnv: "INKYPUMP_REF_CODE",
    previewHosts: ["images.inkypump.com", "storage.inkypump.com", "inkypump.com"],
  },
} satisfies Record<string, Launchpad>

export type LaunchpadKey = keyof typeof LAUNCHPADS

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

/** "InkyPump", "InkyPump or Tsunami", "A, B or C". */
export function launchpadNames(list: Record<string, Launchpad> = LAUNCHPADS): string {
  const names = Object.values(list).map((l) => l.name)
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`
}

export function unknownTokenText(list: Record<string, Launchpad> = LAUNCHPADS): string {
  const n = launchpadNames(list)
  return `Not a token on ${n}. MAKO covers ${n} launches for now.`
}

export function isPreviewHost(
  key: string,
  url: string,
  list: Record<string, Launchpad> = LAUNCHPADS,
): boolean {
  try {
    return launchpadOf(key, list).previewHosts.includes(new URL(url).hostname)
  } catch {
    return false
  }
}

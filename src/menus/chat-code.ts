/**
 * A group's id as a short lowercase code, so a card opened from the group's Watched list can carry its
 * Back target inside the 64 bytes of callback data: -1001234 → s1234, -5 → g5.
 */
export function chatCode(id: string | number): string {
  const s = String(id)
  return s.startsWith("-100") ? `s${s.slice(4)}` : `g${s.slice(1)}`
}

export const chatFromCode = (code: string): string =>
  code.startsWith("s") ? `-100${code.slice(1)}` : `-${code.slice(1)}`

import type { LaunchEvent } from "@ink-indexer/events"
import { shortAddress } from "../quotes"

/** The longest value the hooks row holds, so a card keeps the width of the others. */
const MAX_VALUE = 31

/**
 * The `hooks` row of a Hookit card, or null for another launchpad. A Master token lists the modules its hook runs, in
 * the order its token page shows them; whole names are dropped from the end, and the count of the dropped ones
 * follows as ` +N`, until the value fits.
 */
export function hooksRow(l: LaunchEvent): [string, string] | null {
  if (l.launchpad !== "hookit") return null
  if (l.customHook && typeof l.hook === "string") {
    return ["hooks", `custom ${shortAddress(l.hook)}`]
  }
  if (!l.startsInPool) return ["hooks", "Classic"]
  // Stored rows are untrusted: a malformed list shows as no modules, and a name too long for the row is dropped.
  const modules = Array.isArray(l.hookModules)
    ? l.hookModules.filter((m) => typeof m === "string" && m.length <= MAX_VALUE)
    : []
  if (modules.length === 0) return ["hooks", "Master"]
  let value = ""
  for (let shown = modules.length; shown >= 1; shown--) {
    value = modules.slice(0, shown).join(", ")
    if (shown < modules.length) value += ` +${modules.length - shown}`
    if (value.length <= MAX_VALUE) break
  }
  return ["hooks", value]
}

/** `rows` with the hooks row last, for a Hookit token. */
export function withHooks(rows: [string, string][], l: LaunchEvent): [string, string][] {
  const hooks = hooksRow(l)
  return hooks ? [...rows, hooks] : rows
}

import { readFileSync } from "node:fs"
import type { LaunchpadEvent } from "@ink-indexer/events"

export function loadFixture(name: string): LaunchpadEvent[] {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"))
}

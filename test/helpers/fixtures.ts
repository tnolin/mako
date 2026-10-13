import { readFileSync } from "node:fs"
import type { IndexerEvent } from "@ink-indexer/events"

export function loadFixture(name: string): IndexerEvent[] {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"))
}

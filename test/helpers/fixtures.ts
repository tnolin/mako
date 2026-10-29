import { readFileSync } from "node:fs"
import type { NftEvent, StoredEvent } from "@ink-indexer/events"

/** Real launchpad rows as the indexer stored them, at whatever schema version they were written. */
export function loadFixture(name: string): Exclude<StoredEvent, NftEvent>[] {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"))
}

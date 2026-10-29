import type { Sql } from "./db"
import { type TokenHit, tokensNamed } from "./history"

export type { TokenHit }

/**
 * Tokens matching a ticker (with or without `$`) or a name exactly, ignoring case: bonded first, then by the most
 * recent trade or swap, at most 8.
 */
export function findTokens(sql: Sql, query: string): Promise<TokenHit[]> {
  const q = query.trim()
  const bare = q.replace(/^\$/, "")
  if (bare === "") return Promise.resolve([])
  return tokensNamed(sql, bare, [...new Set([q, bare])])
}

import type { Sql } from "../db"
import { viewerState } from "../nft/watches"

/** What a DM user already did with a token or collection, so an alert's buttons open in that state. */
export type Viewer = {
  nft(
    tg: number,
    contract: string,
  ): Promise<{ watching: boolean; muted: boolean; reminded: boolean }>
  token(tg: number, ca: string): Promise<{ watching: boolean; muted: boolean }>
}

export function createViewer(sql: Sql): Viewer {
  const userOf = async (tg: number) =>
    (await sql<{ id: string }[]>`select id::text from bot.users where platform_user_id = ${tg}`)[0]
      ?.id
  return {
    async nft(tg, contract) {
      const id = await userOf(tg)
      return id
        ? viewerState(sql, id, contract)
        : { watching: false, muted: false, reminded: false }
    },
    async token(tg, ca) {
      const id = await userOf(tg)
      if (!id) return { watching: false, muted: false }
      const kinds = await sql<{ kind: string }[]>`
        select kind from bot.subscriptions where user_id = ${id} and target = ${ca}`
      return {
        watching: kinds.some((k) => k.kind === "watch"),
        muted: kinds.some((k) => k.kind === "mute"),
      }
    },
  }
}

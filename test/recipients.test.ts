import { describe, expect, it } from "vitest"
import type { Card } from "../src/cards/card"
import { type Audience, route } from "../src/delivery/recipients"
import type { Candidate } from "../src/rules/index"
import { type AlertKind, basicPreset, type Settings } from "../src/settings"
import { addr, T0 } from "./helpers/events"

const TOKEN = addr(0xc5)
let seq = 0

function cand(alert: AlertKind, o: Partial<Candidate> = {}): Candidate {
  const id = String(++seq)
  return {
    alert,
    eventId: id,
    target: TOKEN,
    dedupeKey: `${alert}:${id}`,
    priority: 3,
    eventTs: T0,
    card: { alert, title: alert, rows: [], links: [] } as unknown as Card,
    ...o,
  }
}
const dm = (id: string) => ({
  userId: id,
  chatId: `10${id}`,
  settings: basicPreset("private") as Settings,
})
const grp = (chatId: string) => ({
  chatId,
  chatType: "supergroup" as const,
  settings: basicPreset("supergroup") as Settings,
})
function audience(o: Partial<Audience> = {}): Audience {
  return {
    users: [],
    chats: [],
    watch: new Map(),
    chatWatch: new Map(),
    mute: new Map(),
    lastPump: new Map(),
    watches: new Map(),
    nftMutes: new Map(),
    listingSent: new Map(),
    lastFloor: new Map(),
    ...o,
  }
}
const who = (ds: ReturnType<typeof route>) => ds.map((d) => `${d.chatId}:${d.alert}`).sort()

/** One candidate per token alert type that can reach a feed, each flagged or not. */
const set = (customHook: boolean) => [
  cand("new", { customHook }),
  cand("pumping", { customHook }),
  cand("big", { customHook, sizeBps: 1000 }),
  cand("devsell", { customHook }),
]

describe("custom-hook tokens in feeds", () => {
  it("a custom-hook token's NEW TOKEN, PUMPING, BIG BUY and DEV SELL skip the feed", () => {
    const aud = audience({ users: [dm("1")], chats: [grp("-200")] })
    expect(route(set(true), aud)).toEqual([])
  })

  it("its PUMPING, BIG BUY and DEV SELL reach a user and a group that watch it (synthetic launch)", () => {
    const aud = audience({
      users: [dm("1"), dm("2")],
      chats: [grp("-200"), grp("-201")],
      watch: new Map([[TOKEN, new Set(["1"])]]),
      chatWatch: new Map([[TOKEN, new Set(["-200"])]]),
    })
    expect(who(route(set(true), aud))).toEqual([
      "-200:big",
      "-200:devsell",
      "-200:pumping",
      "101:big",
      "101:devsell",
      "101:pumping",
    ])
  })

  it("an approved Hookit token reaches the feed", () => {
    const aud = audience({ users: [dm("1")], chats: [grp("-200")] })
    expect(who(route(set(false), aud))).toEqual([
      "-200:big",
      "-200:devsell",
      "-200:new",
      "-200:pumping",
      "101:big",
      "101:devsell",
      "101:new",
      "101:pumping",
    ])
  })
})

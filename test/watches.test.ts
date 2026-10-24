import { afterAll, beforeEach, expect, inject, it } from "vitest"
import type { Sql } from "../src/db"
import { deleteUserData } from "../src/menus/users"
import {
  muteCollection,
  mutesOf,
  remind,
  remindersOf,
  unmuteCollection,
  unremind,
  unwatch,
  watch,
  watchesOf,
} from "../src/nft/watches"
import { addUser } from "./helpers/bot"
import { resetDb } from "./helpers/db"

const C1 = `0x${"c1".repeat(20)}`
const C2 = `0x${"c2".repeat(20)}`
let sql: Sql
let u: string
beforeEach(async () => {
  await sql?.end()
  sql = await resetDb(inject("databaseUrl"))
  u = await addUser(sql, 101)
})
afterAll(() => sql.end())

it("a watch is unique per owner and the 51st is refused", async () => {
  const owner = { userId: u }
  expect(await watch(sql, owner, C1)).toBe("added")
  expect(await watch(sql, owner, C1)).toBe("exists")
  for (let i = 2; i <= 50; i++)
    expect(await watch(sql, owner, `0x${String(i).padStart(40, "0")}`)).toBe("added")
  expect(await watchesOf(sql, owner)).toHaveLength(50)
  expect(await watch(sql, owner, C2)).toBe("limit")
  expect(await watch(sql, owner, C1)).toBe("exists")
  // A chat has its own 50.
  expect(await watch(sql, { chatId: "-1001" }, C2)).toBe("added")
})

it("a row with both owners violates the check", async () => {
  await expect(
    sql`insert into bot.nft_watches (user_id, chat_id, contract) values (${u}, -5, ${C1})`,
  ).rejects.toThrow(/check/)
  await expect(
    sql`insert into bot.collection_mutes (user_id, chat_id, contract) values (${u}, -5, ${C1})`,
  ).rejects.toThrow(/check/)
  await expect(sql`insert into bot.nft_watches (contract) values (${C1})`).rejects.toThrow(/check/)
})

it("unwatch removes the watch", async () => {
  await watch(sql, { userId: u }, C1)
  await unwatch(sql, { userId: u }, C1)
  expect(await watchesOf(sql, { userId: u })).toEqual([])
})

it("mute removes the watch and reports wasWatching", async () => {
  const owner = { userId: u }
  await watch(sql, owner, C1)
  expect(await muteCollection(sql, owner, C1)).toEqual({ wasWatching: true })
  expect(await watchesOf(sql, owner)).toEqual([])
  expect(await mutesOf(sql, owner)).toEqual([C1])
  expect(await muteCollection(sql, owner, C2)).toEqual({ wasWatching: false })
  expect(await muteCollection(sql, owner, C2)).toEqual({ wasWatching: false })
  await unmuteCollection(sql, owner, C1)
  expect(await mutesOf(sql, owner)).toEqual([C2])
})

it("watch removes the mute", async () => {
  const owner = { chatId: "-1001" }
  await muteCollection(sql, owner, C1)
  expect(await watch(sql, owner, C1)).toBe("added")
  expect(await mutesOf(sql, owner)).toEqual([])
})

it("remind removes the mute, and unremind removes the reminder", async () => {
  const owner = { userId: u }
  await muteCollection(sql, owner, C1)
  await remind(sql, u, C1)
  await remind(sql, u, C1)
  expect(await mutesOf(sql, owner)).toEqual([])
  expect(await remindersOf(sql, u)).toEqual([C1])
  await unremind(sql, u, C1)
  expect(await remindersOf(sql, u)).toEqual([])
})

it("delete my data removes the user's watches, mutes and reminders, and keeps chat watches", async () => {
  await watch(sql, { userId: u }, C1)
  await muteCollection(sql, { userId: u }, C2)
  await remind(sql, u, C2)
  await watch(sql, { chatId: "-1001" }, C1)
  await deleteUserData(sql, 101)
  expect(await sql`select 1 from bot.nft_watches where user_id is not null`).toHaveLength(0)
  expect(await sql`select 1 from bot.collection_mutes`).toHaveLength(0)
  expect(await sql`select 1 from bot.reminders`).toHaveLength(0)
  expect(await watchesOf(sql, { chatId: "-1001" })).toEqual([C1])
})

it("unremind stops a watch's reminders, and remind starts them again", async () => {
  await watch(sql, { userId: u }, C1)
  const off = async () =>
    (
      await sql<
        { reminders_off: boolean }[]
      >`select reminders_off from bot.nft_watches where user_id = ${u}`
    )[0]!.reminders_off
  expect(await off()).toBe(false)
  await unremind(sql, u, C1)
  expect(await off()).toBe(true)
  await remind(sql, u, C1)
  expect(await off()).toBe(false)
  // A collection that is not watched is untouched.
  await unremind(sql, u, C2)
  expect(await watchesOf(sql, { userId: u })).toEqual([C1])
})

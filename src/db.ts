import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import postgres from "postgres"

/** postgres.js client. bigint columns come back as strings; Telegram ids are converted with Number(). */
export function connect(url: string) {
  return postgres(url, { max: 10, onnotice: () => {} })
}

export type Sql = ReturnType<typeof connect>

const MIGRATIONS = join(import.meta.dirname, "migrations")

/** Applies pending `bot` migrations in file-name order, each in its own transaction. */
export async function migrate(sql: Sql): Promise<string[]> {
  await sql`create schema if not exists bot`
  await sql`create table if not exists bot.migrations (name text primary key, applied_at timestamptz not null default now())`
  const done = new Set(
    (await sql<{ name: string }[]>`select name from bot.migrations`).map((r) => r.name),
  )
  const applied: string[] = []
  for (const name of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    if (done.has(name)) continue
    await sql.begin(async (tx) => {
      await tx.unsafe(readFileSync(join(MIGRATIONS, name), "utf8"))
      await tx`insert into bot.migrations (name) values (${name})`
    })
    applied.push(name)
  }
  return applied
}

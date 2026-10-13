import { readFileSync } from "node:fs"
import { connect, type Sql } from "../../src/db"

const GRANTS = readFileSync(
  new URL("../../scripts/deploy/grants.sql", import.meta.url),
  "utf8",
).replaceAll(" mako;", " mako_test;")

/** A connection that logs in as `mako_test`, a role with exactly the production grants. */
export async function connectAsBotRole(adminSql: Sql, url: string): Promise<Sql> {
  await adminSql.unsafe(`
    do $$ begin
      if exists (select from pg_roles where rolname = 'mako_test') then
        execute 'drop owned by mako_test'; execute 'drop role mako_test';
      end if;
    end $$`)
  await adminSql.unsafe(`create role mako_test login password 'mako_test'`)
  await adminSql.unsafe(GRANTS)
  // In production `mako` owns the bot schema; here the test superuser created it.
  await adminSql.unsafe(
    "grant usage on schema bot to mako_test; grant all on all tables in schema bot to mako_test; grant all on all sequences in schema bot to mako_test",
  )
  const u = new URL(url)
  u.username = "mako_test"
  u.password = "mako_test"
  return connect(u.href)
}

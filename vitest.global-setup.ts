import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import EmbeddedPostgres from "embedded-postgres"
import type { TestProject } from "vitest/node"

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string
  }
}

// CI sets TEST_DATABASE_URL (postgres service container). Locally we start a throwaway Postgres.
// DATABASE_URL is the runtime database and is never used here: tests drop the `bot` and `indexer` schemas.
export default async function setup(project: TestProject) {
  const url = process.env.TEST_DATABASE_URL || undefined
  if (url) {
    project.provide("databaseUrl", url)
    return
  }
  const port = 54330
  const pg = new EmbeddedPostgres({
    databaseDir: mkdtempSync(join(tmpdir(), "mako-pg-")),
    user: "ink",
    password: "ink",
    port,
    persistent: false,
  })
  await pg.initialise()
  await pg.start()
  await pg.createDatabase("mako_test")
  project.provide("databaseUrl", `postgres://ink:ink@localhost:${port}/mako_test`)
  return async () => {
    await pg.stop()
  }
}

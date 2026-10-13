// Exports real indexer events as a test fixture (public chain data, payloads only).
//   pnpm tsx --env-file=.env scripts/export-fixture.ts <name> --token <address> [--token <address>...]
//   pnpm tsx --env-file=.env scripts/export-fixture.ts <name> --ids <fromId> <toId>
import { writeFileSync } from "node:fs"
import { connect } from "../src/db"

const [name, ...args] = process.argv.slice(2)
const url = process.env.DATABASE_URL
if (!name || !url)
  throw new Error("usage: export-fixture.ts <name> --token <addr>... | --ids <from> <to>")
const sql = connect(url)
const tokens = args.flatMap((a, i) =>
  a === "--token" && args[i + 1] ? [args[i + 1]!.toLowerCase()] : [],
)
const ids = args.indexOf("--ids")
const rows =
  ids >= 0
    ? await sql`select payload from indexer.events where confirmed and id between ${args[ids + 1]!} and ${args[ids + 2]!} order by id`
    : await sql`select payload from indexer.events where confirmed and entity = any(${tokens}) order by id`
writeFileSync(`test/fixtures/${name}.json`, `${JSON.stringify(rows.map((r) => r.payload))}\n`)
console.log(`wrote ${rows.length} events to test/fixtures/${name}.json`)
await sql.end()

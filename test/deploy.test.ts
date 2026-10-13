import { readFileSync } from "node:fs"
import { expect, it } from "vitest"

const read = (f: string) => readFileSync(new URL(`../scripts/deploy/${f}`, import.meta.url), "utf8")

it.each([
  ["ink-indexer.service", "ink-indexer", "/opt/ink-indexer", "apps/indexer/src/main.ts start"],
  ["mako-bot.service", "mako", "/opt/mako", "src/main.ts"],
])("%s restarts forever as a dedicated non-root user", (file, user, dir, entry) => {
  const u = read(file)
  for (const line of [
    `User=${user}`,
    "Group=ink",
    `WorkingDirectory=${dir}`,
    "Restart=always",
    "RestartSec=5",
    "StartLimitIntervalSec=0",
    `ExecStart=/usr/bin/node --import tsx ${entry}`,
  ]) {
    expect(u).toContain(line)
  }
  expect(u).toMatch(/^EnvironmentFile=\/etc\/ink\/\S+\.env$/m)
  expect(u).not.toMatch(/^User=root/m)
})

it("keeps logs and backups for 14 days, and Caddy writes no access log", () => {
  expect(read("journald-retention.conf")).toContain("MaxRetentionSec=14day")
  expect(read("backup.sh")).toContain("-mtime +13 -delete")
  expect(read("backup.sh")).toContain("pg_dump -Fc -n bot ink")
  const caddy = read("Caddyfile")
  expect(caddy).toContain("reverse_proxy 127.0.0.1:8080")
  expect(caddy).not.toMatch(/^\s*log\b/m)
})

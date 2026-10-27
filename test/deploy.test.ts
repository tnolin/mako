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

it("deploy guide grants CREATE on the database for the migrations", () => {
  const guide = readFileSync(new URL("../docs/deploy.md", import.meta.url), "utf8")
  expect(guide).toContain("grant create on database ink to indexer, mako")
})

it("keeps logs and backups for 14 days, and Caddy writes no access log", () => {
  expect(read("journald-retention.conf")).toContain("MaxRetentionSec=14day")
  expect(read("backup.sh")).toContain("-mtime +13 -delete")
  const caddy = read("Caddyfile")
  expect(caddy).toContain("reverse_proxy 127.0.0.1:8080")
  expect(caddy).not.toMatch(/^\s*log\b/m)
})

it("copies each nightly dump to an S3-compatible bucket and keeps 14 days there too, with credentials from a root-only env file", () => {
  const b = read("backup.sh")
  expect(b).toContain('rclone copyto "$dir/$name" ":s3:$S3_BUCKET/$name"')
  expect(b).toContain('rclone delete --min-age 13d ":s3:$S3_BUCKET"')
  expect(b).toContain('RCLONE_S3_PROVIDER="${S3_PROVIDER:-Other}"')
  expect(read("mako-backup.service")).toContain("EnvironmentFile=/etc/ink/backup.env")
  const example = read("backup.env.example")
  for (const k of [
    "S3_PROVIDER",
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ]) {
    expect(example).toMatch(new RegExp(`^${k}=$`, "m"))
  }
})

it("update.sh stops unless a snapshot was just taken", () => {
  const u = read("update.sh")
  expect(u).toMatch(/read -r -p "[^"]*snapshot[^"]*" snap/)
  expect(u.indexOf("snapshot")).toBeLessThan(u.indexOf("git fetch"))
})

it("deploy guide disables password and root SSH login with a drop-in that wins over cloud-init", () => {
  const guide = readFileSync(new URL("../docs/deploy.md", import.meta.url), "utf8")
  expect(guide).toContain("/etc/ssh/sshd_config.d/00-hardening.conf")
  for (const line of [
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "PermitRootLogin no",
  ]) {
    expect(guide).toContain(line)
  }
  expect(guide).toContain("sshd -T")
  expect(guide).toContain("/var/run/reboot-required")
  expect(guide).toContain("apt -y install unattended-upgrades ufw git curl ca-certificates rclone")
})

it("nightly dump holds the bot and indexer schemas and leaves out only rebuildable chain rows", () => {
  const b = read("backup.sh")
  expect(b).toMatch(/pg_dump -Fc -n bot -n indexer /)
  const skipped = [...b.matchAll(/--exclude-table-data=indexer\.(\w+)/g)].map((m) => m[1])
  expect(skipped.sort()).toEqual(["nft_burns", "nft_mints", "nft_sales", "nft_seadrop_mints"])
  const guide = readFileSync(new URL("../docs/deploy.md", import.meta.url), "utf8")
  for (const t of skipped) expect(guide).toContain(`indexer.${t}`)
})

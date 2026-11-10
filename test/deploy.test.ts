import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

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
  expect(guide).toContain(
    "PermitRootLogin no\\nX11Forwarding no\\n' > /etc/ssh/sshd_config.d/00-hardening.conf",
  )
  expect(guide).toContain("permitrootlogin|x11forwarding)")
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

const guide = () => readFileSync(new URL("../docs/deploy.md", import.meta.url), "utf8")

const SERVICE_USERS = ["mako", "ink-indexer"]
const under = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`)
const paths = (line: string) => line.match(/\/[\w.\-/$]*[\w.-]/g) ?? []

/** Every `install -d -o <service user> ...` target in the guide: the directories it hands to a service user. */
const handedToServices = () =>
  [...guide().matchAll(/install -d (?:-m \S+ )?-o (\S+) -g \S+ (\S+)/g)]
    .filter((m) => [...SERVICE_USERS, "$r"].includes(m[1]!))
    .map((m) => m[2]!.replace(/["';]/g, ""))

/** Directories a service user can write: its node_modules and its home directory. */
function writableDirs(): string[] {
  const homes = [...guide().matchAll(/^useradd .*--home-dir (\S+) .* (\S+)$/gm)]
    .filter((m) => SERVICE_USERS.includes(m[2]!))
    .map((m) => m[1]!)
  return [...SERVICE_USERS.map((u) => `/opt/${u}/node_modules`), ...homes]
}

it("gives the service users only node_modules and their home directories to write", () => {
  expect(handedToServices().length).toBeGreaterThanOrEqual(3)
  for (const t of handedToServices()) expect(t).toMatch(/\/node_modules$/)
  expect(writableDirs().sort()).toEqual([
    "/opt/ink-indexer/node_modules",
    "/opt/mako/node_modules",
    "/var/lib/ink-indexer",
    "/var/lib/mako",
  ])
  // Workspace packages get their node_modules the same way, in setup, migration and update.sh.
  expect(guide()).toContain('for d in . apps/* packages/*; do [ -f "$d/package.json" ]')
  expect(read("update.sh")).toContain("for d in . apps/* packages/*; do")
})

it("keeps backup.sh free of paths under the app trees", () => {
  expect(read("backup.sh")).not.toMatch(/\/opt\/|\bsource\b|^\. /m)
})

it("runs nothing as root or postgres from a path a service user can write", () => {
  const writable = writableDirs()
  const bad: string[] = []
  for (const f of ["mako-backup.service", "mako-bot.service", "ink-indexer.service"]) {
    const u = read(f)
    const user = /^User=(\S+)/m.exec(u)?.[1] ?? "root"
    if (SERVICE_USERS.includes(user)) continue
    for (const line of u.split("\n").filter((l) => /^Exec/.test(l))) {
      for (const p of paths(line)) if (writable.some((w) => under(p, w))) bad.push(`${f}: ${p}`)
    }
  }
  for (const line of guide()
    .split("\n")
    .map((l) => l.trim())) {
    const asService = /sudo -u (mako|ink-indexer|\$r)\b/.test(line)
    const runsPrivileged =
      /sudo -u postgres|\bpsql\b/.test(line) || /^(cp|install -m|install -D|bash|sh) /.test(line)
    if (asService || !runsPrivileged) continue
    for (const p of paths(line)) if (writable.some((w) => under(p, w))) bad.push(`guide: ${line}`)
  }
  expect(bad).toEqual([])
  expect(read("mako-backup.service")).toContain("ExecStart=/usr/local/lib/mako/backup.sh")
})

it("update.sh runs git as root with hooks off and gives the service user only node_modules", () => {
  const u = read("update.sh")
  expect(u).toContain("git -c core.hooksPath=/dev/null")
  expect(u).not.toMatch(/sudo -u "\$user" git/)
  expect(u).toContain('install -d -o "$user" -g ink "$d/node_modules"')
  expect(u).toContain("/usr/local/lib/mako/backup.sh")
  expect(u).toContain("/usr/local/sbin/mako-update")
})

it("restore drill runs as an unprivileged restore login mapped by a peer map", () => {
  const g = guide()
  expect(g).toContain("create role restore login nosuperuser nocreaterole nocreatedb")
  expect(g).toContain("restore   postgres   restore")
  expect(g).toContain("local   scratch   restore   peer map=restore")
  expect(g).toContain("createdb -O restore scratch")
  expect(g).not.toMatch(/sudo -u postgres (pg_restore|psql) (?!-U restore)[^\n]*scratch/)
  const restores = g.split("\n").filter((l) => l.includes("pg_restore"))
  expect(restores.filter((l) => l.startsWith("sudo")).length).toBeGreaterThan(0)
  for (const l of restores.filter((l) => l.startsWith("sudo")))
    expect(l).toContain("-U restore -d scratch --no-owner --no-privileges")
})

it("documents the redirect rate limit and the migration to root-owned checkouts", () => {
  const g = guide()
  expect(g).toContain("--hashlimit-above 30/minute")
  expect(g).toContain("Moving an existing server to the root-owned layout")
})

const migration = () => {
  const section = guide().split("### Moving an existing server")[1] ?? ""
  const blocks = [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1])
  const block = blocks.find((b) => b?.includes("git clone"))
  if (!block) throw new Error("migration block not found")
  return block
}
const sh = (script: string) => spawnSync("bash", ["-c", script], { encoding: "utf8" })

it("migration node_modules loop survives set -euo pipefail on a tree without apps/ or packages/", () => {
  const line = migration()
    .split("\n")
    .find((l) => l.includes("for d in . apps/* packages/*"))
  expect(line).toBeDefined()
  const dir = mkdtempSync(join(tmpdir(), "mako-tree-"))
  writeFileSync(join(dir, "package.json"), "{}")
  const script = `set -euo pipefail; r=mako; install() { :; }; ${(line as string).trim().replace("/opt/$r", dir)}; echo done`
  const run = sh(script)
  expect(run.stdout.trim()).toBe("done")
  expect(run.status).toBe(0)
})

describe("migration tag guard", () => {
  // The guard is everything in the migration subshell before the services are stopped.
  const guardScript = (tags: string, running: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "mako-env-"))
    for (const [f, v] of Object.entries(running))
      writeFileSync(join(dir, f), `SENTRY_RELEASE=${v}\n`)
    const block = migration().replaceAll("/etc/ink", dir)
    return `${tags}\n${block.slice(0, block.indexOf("  systemctl stop"))})\n`
  }
  const running = { "mako.env": "v0.6.0", "indexer.env": "indexer-v0.7.0" }

  it("passes when both tags differ from the running ones", () => {
    expect(sh(guardScript("mako_tag=v0.6.1 indexer_tag=indexer-v0.7.1", running)).status).toBe(0)
  })
  it("refuses when a tag equals the running tag", () => {
    const run = sh(guardScript("mako_tag=v0.6.0 indexer_tag=indexer-v0.7.1", running))
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain("already running")
  })
  it("refuses when a tag is not set", () => {
    const run = sh(guardScript("mako_tag=v0.6.1", running))
    expect(run.status).not.toBe(0)
    expect(run.stderr).toContain("set mako_tag and indexer_tag first")
  })
})

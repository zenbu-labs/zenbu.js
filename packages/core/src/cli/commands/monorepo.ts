import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
// todo: should only be exposed when an env var is passed.

const MARKER_FILE = ".zenbu-dev-link"
const DEFAULT_MONOREPO = path.join(os.homedir(), ".zenbu", "plugins", "zenbu")

function resolveProjectDir(): string {
  const cwd = process.cwd()
  if (
    fs.existsSync(path.join(cwd, "zenbu.config.ts")) ||
    fs.existsSync(path.join(cwd, "zenbu")) ||
    fs.existsSync(path.join(cwd, MARKER_FILE))
  ) {
    return cwd
  }
  console.error("zen monorepo: not in a zenbu project (no zenbu.config.ts or zenbu/ found)")
  process.exit(1)
}

function resolveMonorepoPath(explicit?: string): string {
  const candidate = explicit || process.env.ZENBU_DEV || DEFAULT_MONOREPO
  const resolved = path.resolve(candidate)

  if (!fs.existsSync(resolved)) {
    console.error(`zen dev link: monorepo not found at ${resolved}`)
    process.exit(1)
  }

  if (!fs.existsSync(path.join(resolved, "packages", "core"))) {
    console.error(`zen monorepo link: ${resolved} doesn't look like a zenbu monorepo (missing packages/core)`)
    process.exit(1)
  }

  return resolved
}

async function link(argv: string[]) {
  const projectDir = resolveProjectDir()
  const monorepoPath = resolveMonorepoPath(argv[0])
  const zenbuDir = path.join(projectDir, "zenbu")
  const markerPath = path.join(projectDir, MARKER_FILE)

  if (fs.existsSync(markerPath)) {
    console.log("  Already dev-linked. Run 'zen dev unlink' first to change.")
    return
  }

  const isSymlink = fs.lstatSync(zenbuDir, { throwIfNoEntry: false })?.isSymbolicLink()
  if (isSymlink) {
    console.log("  zenbu/ is already a symlink. Run 'zen dev unlink' first.")
    return
  }

  let submoduleSha = ""
  if (fs.existsSync(zenbuDir)) {
    try {
      submoduleSha = execFileSync("git", ["-C", zenbuDir, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim()
    } catch {}

    console.log("  → removing zenbu/ submodule directory...")
    fs.rmSync(zenbuDir, { recursive: true, force: true })
  }

  fs.writeFileSync(markerPath, JSON.stringify({
    monorepo: monorepoPath,
    previousSha: submoduleSha,
    linkedAt: new Date().toISOString(),
  }, null, 2) + "\n")

  console.log(`  → linking zenbu/ -> ${monorepoPath}`)
  fs.symlinkSync(monorepoPath, zenbuDir)

  if (!fs.existsSync(path.join(monorepoPath, "node_modules"))) {
    console.log("  → monorepo missing node_modules, run 'pnpm install' there first")
  }

  console.log(`\n  ✓ Dev-linked to ${monorepoPath}`)
  console.log(`  Changes to the monorepo are now live in this project.`)
  console.log(`  Run 'zen dev unlink' to restore the git submodule.\n`)
}

async function unlink(_argv: string[]) {
  const projectDir = resolveProjectDir()
  const zenbuDir = path.join(projectDir, "zenbu")
  const markerPath = path.join(projectDir, MARKER_FILE)

  if (!fs.existsSync(markerPath)) {
    console.error("zen dev unlink: not dev-linked (no .zenbu-dev-link marker)")
    process.exit(1)
  }

  const isSymlink = fs.lstatSync(zenbuDir, { throwIfNoEntry: false })?.isSymbolicLink()
  if (isSymlink) {
    console.log("  → removing symlink...")
    fs.unlinkSync(zenbuDir)
  }

  console.log("  → restoring git submodule...")
  try {
    execFileSync("git", ["submodule", "update", "--init", "zenbu"], {
      cwd: projectDir,
      stdio: "inherit",
    })
  } catch (err) {
    console.error("  ⚠ submodule restore failed, you may need to run 'git submodule update --init zenbu' manually")
  }

  fs.unlinkSync(markerPath)

  console.log(`\n  ✓ Dev-link removed. zenbu/ restored to git submodule.\n`)
}

export async function runMonorepo(argv: string[]) {
  const sub = argv[0]

  if (sub === "link") {
    await link(argv.slice(1))
    return
  }

  if (sub === "unlink") {
    await unlink(argv.slice(1))
    return
  }

  console.log(`
zen monorepo — framework-internal monorepo dev tools

Usage:
  zen monorepo link [monorepo-path]   Symlink zenbu/ to a local monorepo for live editing
  zen monorepo unlink                 Restore zenbu/ to the git submodule

Environment:
  ZENBU_DEV    Default monorepo path (fallback: ~/.zenbu/plugins/zenbu)
`)
}

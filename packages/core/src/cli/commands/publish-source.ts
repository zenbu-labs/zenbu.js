// fixme: does not survive deletes from .zenbu — resync from remote.
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { loadConfig } from "../lib/load-config"
import { init as mirrorInit, push as mirrorPush, type MirrorPushResult } from "../lib/mirror-sync"

interface StagingMeta {
  sourceSha: string
  contentHash: string
  builtAt: string
}

function resolveProjectDir(): string {
  const cwd = process.cwd()
  for (const name of ["zenbu.config.ts", "zenbu.config.mts", "zenbu.config.js", "zenbu.config.mjs"]) {
    if (fs.existsSync(path.join(cwd, name))) return cwd
  }
  console.error("zen publish:source: no zenbu.config.ts found in current directory")
  process.exit(1)
}

function currentSourceSha(projectDir: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectDir,
      encoding: "utf8",
    }).trim()
  } catch {
    return "uncommitted"
  }
}

async function readStagingMeta(stagingDir: string): Promise<StagingMeta> {
  const shaPath = path.join(stagingDir, ".sha")
  if (!fs.existsSync(stagingDir) || !fs.existsSync(shaPath)) {
    throw new Error(
      `staging dir missing or incomplete: ${stagingDir}\n` +
        `  run \`zen build:source\` first.`,
    )
  }
  return JSON.parse(await fsp.readFile(shaPath, "utf8")) as StagingMeta
}

interface ParsedFlags {
  subcommand: "init" | "push"
  config?: string
  target?: string
  branch?: string
  force: boolean
}

function parseFlags(argv: string[]): ParsedFlags {
  let subcommand: "init" | "push" = "push"
  if (argv[0] === "init" || argv[0] === "push") {
    subcommand = argv[0]
    argv = argv.slice(1)
  }
  const flags: ParsedFlags = { subcommand, force: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--config" || arg === "-c") flags.config = argv[++i]
    else if (arg.startsWith("--config=")) flags.config = arg.slice("--config=".length)
    else if (arg === "--target") flags.target = argv[++i]
    else if (arg.startsWith("--target=")) flags.target = arg.slice("--target=".length)
    else if (arg === "--branch") flags.branch = argv[++i]
    else if (arg.startsWith("--branch=")) flags.branch = arg.slice("--branch=".length)
    else if (arg === "--force" || arg === "-f") flags.force = true
  }
  return flags
}

function expandMirrorUrl(target: string): string {
  if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("git@")) {
    return target
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(target)) {
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null
    return token
      ? `https://x-access-token:${token}@github.com/${target}.git`
      : `https://github.com/${target}.git`
  }
  return target
}

function resolveAuthor(projectDir: string): { name?: string; email?: string } {
  try {
    const name = execFileSync("git", ["config", "user.name"], { cwd: projectDir, encoding: "utf8" }).trim()
    const email = execFileSync("git", ["config", "user.email"], { cwd: projectDir, encoding: "utf8" }).trim()
    return { name: name || undefined, email: email || undefined }
  } catch {
    return {}
  }
}

function logResult(action: "init" | "push", result: MirrorPushResult, mirrorUrl: string): void {
  if (result.status === "noop") {
    console.log(`\n  → ${result.reason ?? "nothing to push"}\n`)
    return
  }
  const sha = result.mirrorSha ? ` (${result.mirrorSha.slice(0, 7)})` : ""
  console.log(`\n  ✓ ${action === "init" ? "initialized" : "pushed to"} ${mirrorUrl}${sha}\n`)
}

export async function runPublishSource(argv: string[]): Promise<void> {
  const projectDir = resolveProjectDir()
  const flags = parseFlags(argv)

  const { resolved } = await loadConfig(projectDir, { skipLocalManifests: true })
  const config = resolved.build

  const target = flags.target ?? config.mirror?.target
  if (!target) {
    console.error("zen publish:source: no mirror target specified (config.mirror.target or --target)")
    process.exit(1)
  }
  const branch = flags.branch ?? config.mirror?.branch ?? "main"
  const mirrorUrl = expandMirrorUrl(target)

  const stagingDir = path.resolve(projectDir, config.out)
  const meta = await readStagingMeta(stagingDir)

  const head = currentSourceSha(projectDir)
  if (head !== "uncommitted" && meta.sourceSha !== head && !flags.force) {
    console.error(
      `zen publish:source: staging is stale (built from ${meta.sourceSha.slice(0, 7)}, current HEAD ${head.slice(0, 7)}).\n` +
        `  run \`zen build:source\` again, or pass --force to publish staging anyway.`,
    )
    process.exit(1)
  }

  const author = resolveAuthor(projectDir)

  console.log(`\n  zen publish:source ${flags.subcommand}`)
  console.log(`    target:  ${target}`)
  console.log(`    branch:  ${branch}`)
  console.log(`    source:  ${meta.sourceSha === "uncommitted" ? "uncommitted" : meta.sourceSha.slice(0, 7)}`)

  try {
    const result = flags.subcommand === "init"
      ? await mirrorInit({
          staging: stagingDir,
          mirrorUrl,
          branch,
          sourceSha: meta.sourceSha,
          authorName: author.name,
          authorEmail: author.email,
          force: flags.force,
        })
      : await mirrorPush({
          staging: stagingDir,
          mirrorUrl,
          branch,
          sourceSha: meta.sourceSha,
          authorName: author.name,
          authorEmail: author.email,
        })
    logResult(flags.subcommand, result, target)
  } catch (err) {
    console.error(`zen publish:source: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}

import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { loadConfig } from "../lib/load-config"
import type {
  BuildContext,
  BuildPlugin,
  EmitContext,
  ResolvedBuildConfig,
} from "../lib/build-config"
import { hashDir } from "../lib/mirror-sync"

function resolveProjectDir(): string {
  const cwd = process.cwd()
  for (const name of ["zenbu.config.ts", "zenbu.config.mts", "zenbu.config.js", "zenbu.config.mjs"]) {
    if (fs.existsSync(path.join(cwd, name))) return cwd
  }
  console.error("zen build:source: no zenbu.config.ts found in current directory")
  process.exit(1)
}

function resolveSourceHead(projectDir: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectDir,
      encoding: "utf8",
    }).trim()
  } catch {
    return "uncommitted"
  }
}

function parseFlags(argv: string[]): { config?: string; out?: string } {
  const flags: { config?: string; out?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--config" || arg === "-c") flags.config = argv[++i]
    else if (arg.startsWith("--config=")) flags.config = arg.slice("--config=".length)
    else if (arg === "--out" || arg === "-o") flags.out = argv[++i]
    else if (arg.startsWith("--out=")) flags.out = arg.slice("--out=".length)
  }
  return flags
}

async function collectFiles(
  sourceDir: string,
  config: ResolvedBuildConfig,
): Promise<string[]> {
  const seen = new Set<string>()
  for (const pattern of config.include) {
    const iter = fsp.glob(pattern, {
      cwd: sourceDir,
      exclude: config.ignore,
    })
    for await (const entry of iter) {
      const rel = entry.split(path.sep).join("/")
      const abs = path.resolve(sourceDir, rel)
      let stat: fs.Stats
      try {
        stat = await fsp.stat(abs)
      } catch {
        continue
      }
      if (!stat.isFile()) continue
      seen.add(rel)
    }
  }
  return [...seen].sort()
}

/**
 * Run every plugin's `transform` in declaration order. A `null` return drops
 * the file and short-circuits remaining plugins. A string replaces the
 * working contents and feeds the next plugin. `void` leaves contents alone.
 */
async function runTransform(
  filePath: string,
  initialContents: string,
  plugins: BuildPlugin[],
  ctx: BuildContext,
): Promise<{ contents: string; drop: boolean }> {
  let contents = initialContents
  for (const plugin of plugins) {
    if (!plugin.transform) continue
    const result = await plugin.transform({ path: filePath, contents }, ctx)
    if (result === null) return { contents, drop: true }
    if (typeof result === "string") contents = result
  }
  return { contents, drop: false }
}

function makeEmit(outDir: string, recordWrite: (rel: string) => void): EmitContext["emit"] {
  return (relPath, contents) => {
    if (typeof relPath !== "string" || relPath.length === 0) {
      throw new Error(`emit: relPath must be a non-empty string, got ${typeof relPath}`)
    }
    if (path.isAbsolute(relPath)) {
      throw new Error(`emit: relPath must be relative, got absolute path "${relPath}"`)
    }
    const normalized = path.posix.normalize(relPath.split(path.sep).join("/"))
    if (normalized.startsWith("../") || normalized === "..") {
      throw new Error(`emit: relPath must not escape outDir, got "${relPath}"`)
    }
    const dst = path.join(outDir, normalized)
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    if (typeof contents === "string") {
      fs.writeFileSync(dst, contents)
    } else {
      fs.writeFileSync(dst, contents)
    }
    recordWrite(normalized)
  }
}

export async function runBuildSource(argv: string[]): Promise<void> {
  const projectDir = resolveProjectDir()
  const flags = parseFlags(argv)

  const { resolved } = await loadConfig(projectDir, { skipLocalManifests: true })
  const config = { ...resolved.build }
  if (flags.out) config.out = flags.out

  const sourceDir = path.resolve(projectDir, config.source)
  const outDir = path.resolve(projectDir, config.out)

  console.log(`\n  zen build:source`)
  console.log(`    config:  ${path.relative(projectDir, resolved.configPath) || resolved.configPath}`)
  console.log(`    source:  ${path.relative(projectDir, sourceDir) || "."}`)
  console.log(`    out:     ${path.relative(projectDir, outDir) || "."}`)

  await fsp.rm(outDir, { recursive: true, force: true })
  await fsp.mkdir(outDir, { recursive: true })

  const files = await collectFiles(sourceDir, config)
  if (files.length === 0) {
    console.error("zen build:source: no files matched the include/ignore globs")
    process.exit(1)
  }

  const sourceSha = resolveSourceHead(projectDir)

  const ctx: BuildContext = {
    sourceDir,
    outDir,
    sourceSha,
    configPath: resolved.configPath,
  }

  let written = 0
  let dropped = 0
  let emitted = 0
  for (const rel of files) {
    const src = path.join(sourceDir, rel)
    const dst = path.join(outDir, rel)
    const isText = isLikelyText(src)
    if (config.plugins.length === 0 || !isText) {
      await fsp.mkdir(path.dirname(dst), { recursive: true })
      await fsp.copyFile(src, dst)
      written += 1
      continue
    }

    const initial = await fsp.readFile(src, "utf8")
    const { contents, drop } = await runTransform(rel, initial, config.plugins, ctx)
    if (drop) {
      dropped += 1
      continue
    }
    await fsp.mkdir(path.dirname(dst), { recursive: true })
    await fsp.writeFile(dst, contents)
    written += 1
  }

  if (config.plugins.length > 0) {
    const emitCtx: EmitContext = {
      ...ctx,
      emit: makeEmit(outDir, () => {
        emitted += 1
      }),
    }
    for (const plugin of config.plugins) {
      if (!plugin.done) continue
      await plugin.done(emitCtx)
    }
  }

  const contentHash = await hashDir(outDir)
  const meta = {
    sourceSha,
    contentHash,
    builtAt: new Date().toISOString(),
    files: written,
    dropped,
    emitted,
  }
  await fsp.writeFile(path.join(outDir, ".sha"), JSON.stringify(meta, null, 2) + "\n")

  const emittedSuffix = emitted > 0 ? `, ${emitted} emitted by plugins` : ""
  console.log(`\n  ✓ ${written} file(s) written, ${dropped} dropped${emittedSuffix}`)
  console.log(`    source HEAD: ${sourceSha === "uncommitted" ? sourceSha : sourceSha.slice(0, 7)}\n`)
}

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".json", ".md", ".html", ".css", ".scss", ".sass", ".less",
  ".yml", ".yaml", ".toml", ".sh", ".env", ".txt",
])

function isLikelyText(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  return TEXT_EXTENSIONS.has(ext)
}

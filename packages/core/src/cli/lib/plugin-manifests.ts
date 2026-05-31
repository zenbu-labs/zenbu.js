/**
 * Plugin manifests live in JSONC files referenced from `zenbu.config.ts` via
 * the `pluginsFiles` field. Each manifest declares which plugins the app
 * loads and whether each is currently enabled.
 *
 *     // zenbu.plugins.jsonc
 *     {
 *       "plugins": [
 *         { "path": "./plugins/app/zenbu.plugin.ts", "enabled": true  },
 *         { "path": "./plugins/foo/zenbu.plugin.ts", "enabled": false }
 *       ]
 *     }
 *
 * Comments (line + block) and trailing commas are tolerated.
 *
 * Multiple manifests can be layered (typically one tracked file plus one
 * gitignored local-overlay file). Later files supersede earlier ones,
 * matched by absolute `path` — so a local file can flip `enabled` on a
 * tracked entry without duplicating it.
 *
 * Missing files are silently ignored at runtime but still pushed onto
 * `watched` so their *creation* triggers a config reload through the same
 * mechanism `localPlugins` used.
 */

import fs from "node:fs"
import path from "node:path"

export interface PluginManifestEntry {
  /** Absolute path to a `.ts`/`.js` plugin file. */
  absPath: string
  /** Whether this entry is active. Disabled entries skip the barrel. */
  enabled: boolean
  /** Optional opaque payload surfaced through `runtime.getPlugin(name).args`. */
  args?: unknown
  /** The manifest file this entry came from (absolute). */
  sourceFile: string
}

export interface LoadManifestsResult {
  /**
   * All entries from all manifests, layered by `absPath` (later entries
   * supersede earlier ones). Includes both enabled and disabled entries
   * so a UI can render a "disabled" badge without re-parsing manifests.
   */
  entries: PluginManifestEntry[]
  /**
   * Manifest files the loader should hot-watch. Always includes every
   * declared `pluginsFiles` path, even if the file is currently missing —
   * the watcher detects creation events that way.
   */
  watched: string[]
}

/**
 * Cache of the most recently *successfully parsed* version of each
 * manifest file, keyed by absolute path. When a parse fails mid-edit
 * (user saves a file with a missing comma, etc.) we fall back to the
 * last good content instead of crashing the loader. The cache lives
 * in the loader-worker process for the lifetime of dev; production
 * never re-parses manifests.
 */
const lastGoodManifest = new Map<string, string>()

const PLUGIN_FILE_RE = /\.(?:ts|mts|js|mjs|cjs)$/

/**
 * Strip `//` line comments, block comments, and trailing commas
 * from a JSONC source, then run it through `JSON.parse`.
 *
 * Same shape as the helper that lived inside the original `zenbu-loader`
 * (commit `02dc32d`) — string-literal aware so a `//` inside a JSON
 * string doesn't get clipped.
 */
export function parseJsonc(source: string): unknown {
  let out = ""
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i]
    // Strings — copy verbatim, handling escapes.
    if (ch === '"') {
      const start = i
      i++
      while (i < n) {
        const c = source[i]
        if (c === "\\") {
          i += 2
          continue
        }
        if (c === '"') {
          i++
          break
        }
        i++
      }
      out += source.slice(start, i)
      continue
    }
    // Line comment.
    if (ch === "/" && source[i + 1] === "/") {
      i += 2
      while (i < n && source[i] !== "\n") i++
      continue
    }
    // Block comment.
    if (ch === "/" && source[i + 1] === "*") {
      i += 2
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++
      i = Math.min(i + 2, n)
      continue
    }
    out += ch
    i++
  }
  // Drop trailing commas before `]` / `}`.
  const cleaned = out.replace(/,\s*(?=[\]}])/g, "")
  return JSON.parse(cleaned)
}

interface RawEntry {
  path: unknown
  enabled?: unknown
  args?: unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readManifest(
  manifestPath: string,
): { plugins: RawEntry[] } | null {
  let raw: string
  try {
    raw = fs.readFileSync(manifestPath, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
  let parsed: unknown
  try {
    parsed = parseJsonc(raw)
    lastGoodManifest.set(manifestPath, raw)
  } catch (err) {
    // Mid-edit: user saved a broken file (missing comma, dangling
    // quote, etc.). Instead of taking down the whole loader, fall
    // back to the last successfully parsed version of this file so
    // the running app keeps using the previous good plugin set.
    // The next valid save replaces the cache and the watcher
    // picks up the new contents normally.
    const fallback = lastGoodManifest.get(manifestPath)
    if (fallback !== undefined) {
      // eslint-disable-next-line no-console
      console.warn(
        `[zenbu] ${manifestPath}: parse failed (${
          err instanceof Error ? err.message : String(err)
        }); using last good contents.`,
      )
      try {
        parsed = parseJsonc(fallback)
      } catch {
        // Cache itself is somehow bad; surface the original error.
        throw new Error(
          `${manifestPath}: failed to parse JSONC — ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    } else {
      throw new Error(
        `${manifestPath}: failed to parse JSONC — ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
  if (!isPlainObject(parsed)) {
    throw new Error(
      `${manifestPath}: top-level value must be an object with a \`plugins\` array.`,
    )
  }
  const plugins = parsed.plugins
  if (!Array.isArray(plugins)) {
    throw new Error(`${manifestPath}: missing or non-array \`plugins\` field.`)
  }
  for (const [i, entry] of plugins.entries()) {
    if (!isPlainObject(entry)) {
      throw new Error(
        `${manifestPath}: plugins[${i}] must be an object with at least \`path\`.`,
      )
    }
    const rawEntry = entry as unknown as RawEntry
    if (typeof rawEntry.path !== "string" || rawEntry.path.length === 0) {
      throw new Error(
        `${manifestPath}: plugins[${i}].path must be a non-empty string.`,
      )
    }
    if (rawEntry.enabled !== undefined && typeof rawEntry.enabled !== "boolean") {
      throw new Error(
        `${manifestPath}: plugins[${i}].enabled must be a boolean if present.`,
      )
    }
  }
  return { plugins: plugins as RawEntry[] }
}

/**
 * Read every declared manifest, layer their entries by absolute `path`,
 * and return the merged list. Missing files are not errors — they're
 * still recorded in `watched` so their creation triggers a reload.
 */
export function loadPluginManifests(args: {
  configDir: string
  manifestPaths: string[]
}): LoadManifestsResult {
  const { configDir, manifestPaths } = args
  const merged = new Map<string, PluginManifestEntry>()
  const watched: string[] = []

  for (const declared of manifestPaths) {
    if (typeof declared !== "string" || declared.length === 0) {
      throw new Error(`pluginsFiles entries must be non-empty strings.`)
    }
    const manifestAbs = path.isAbsolute(declared)
      ? declared
      : path.resolve(configDir, declared)
    // Always watch, even if missing — creation must trigger a reload.
    watched.push(manifestAbs)
    const parsed = readManifest(manifestAbs)
    if (!parsed) continue

    const manifestDir = path.dirname(manifestAbs)
    for (const entry of parsed.plugins) {
      const rel = entry.path as string
      const abs = path.isAbsolute(rel) ? rel : path.resolve(manifestDir, rel)
      if (!PLUGIN_FILE_RE.test(abs)) {
        throw new Error(
          `${manifestAbs}: plugin path "${rel}" must end in .ts/.mts/.js/.mjs/.cjs.`,
        )
      }
      const enabled = entry.enabled === undefined ? true : (entry.enabled as boolean)
      merged.set(abs, {
        absPath: abs,
        enabled,
        args: entry.args,
        sourceFile: manifestAbs,
      })
    }
  }

  return { entries: [...merged.values()], watched }
}

/**
 * Pretty-print a JSONC manifest from its in-memory representation.
 * Used by the writer service to round-trip edits while preserving a
 * consistent two-space layout. The writer reads the file with `parseJsonc`,
 * mutates the POJO, and writes the result through this serializer.
 *
 * NB: comments in the original file are NOT preserved. We document this
 * in the writer's API so callers don't expect it. Hand-edited files keep
 * their comments because we only rewrite when the user actually flips a
 * plugin via the service.
 */
export function serializeManifest(manifest: {
  plugins: Array<{ path: string; enabled?: boolean; args?: unknown }>
}): string {
  const lines: string[] = []
  lines.push("{")
  lines.push(`  "plugins": [`)
  manifest.plugins.forEach((entry, idx) => {
    const parts: string[] = []
    parts.push(`"path": ${JSON.stringify(entry.path)}`)
    if (entry.enabled !== undefined) {
      parts.push(`"enabled": ${entry.enabled ? "true" : "false"}`)
    }
    if (entry.args !== undefined) {
      parts.push(`"args": ${JSON.stringify(entry.args)}`)
    }
    const comma = idx < manifest.plugins.length - 1 ? "," : ""
    lines.push(`    { ${parts.join(", ")} }${comma}`)
  })
  lines.push(`  ]`)
  lines.push("}")
  return lines.join("\n") + "\n"
}

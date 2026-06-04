import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import {
  Service,
  runtime,
  getConfig,
  getPlugins,
} from "../runtime"
import { DEFAULT_LOCAL_MANIFEST } from "../cli/lib/build-config"
import {
  loadPluginManifests,
  parseJsonc,
  serializeManifest,
  type PluginManifestEntry,
} from "../cli/lib/plugin-manifests"
import { createLogger } from "../shared/log"

const log = createLogger("plugin-manager")

/**
 * Renderer-visible shape of a manifest entry. `args` is intentionally
 * `unknown` (passed through verbatim) so plugins can carry their own
 * JSON-serializable config without core needing a schema for it.
 */
export interface PluginManifestRow {
  /** Absolute path to the plugin's `.ts`/`.js` file. */
  path: string
  /** Manifest file this row currently lives in. */
  manifestPath: string
  /**
   * The plugin's declared name. Resolved from the runtime when the
   * plugin is enabled, else read statically from the manifest source.
   * `null` only when the name can't be determined (unreadable or
   * unparseable manifest).
   */
  name: string | null
  enabled: boolean
  args?: unknown
}

/**
 * `PluginManagerService` is the RPC surface for enabling, disabling, and
 * inspecting plugin manifest entries.
 *
 * It is intentionally a thin wrapper around the JSONC manifest files:
 *
 *   - The source of truth on disk is `zenbu.plugins.jsonc` (tracked) +
 *     `zenbu.plugins.local.jsonc` (gitignored). The first file in
 *     `pluginsFiles` is the "tracked" manifest; the rest are overlays.
 *   - `enable` / `disable` mutate the overlay file (creating it if
 *     missing) so per-developer toggles never touch the tracked file.
 *     If the user only declared one manifest, we fall back to mutating
 *     that one.
 *   - All other state \u2014 `name`, registration order, `args` \u2014 flows
 *     through the runtime's `replacePlugins(...)` snapshot, which is
 *     re-fired automatically when the loader re-evaluates the barrel.
 *
 * The actual reload is driven by the zenbu loader: every JSONC manifest
 * file is registered in `context.hot.watch(...)`, so writing the file
 * triggers a barrel invalidation, which calls `replacePlugins(...)`,
 * which disposes services whose owning plugin disappeared and starts
 * services whose owning plugin reappeared. We do not have to coordinate
 * any of that here.
 */
export class PluginManagerService extends Service.create({
  key: "pluginManager",
}) {
  evaluate(): void {
    // No setup needed today \u2014 the service is purely request/response.
    // Future: emit a `pluginsChanged` event when the manifest contents
    // change so the renderer can refresh without polling.
  }

  /**
   * Return every manifest row across every declared manifest file,
   * layered so the last-declared file wins for any duplicate path.
   * Disabled rows are included \u2014 the UI needs them to render the
   * "disabled" badge.
   */
  async list(): Promise<{ rows: PluginManifestRow[]; manifestPaths: string[] }> {
    const { configDir, manifestPaths } = readProjectFromArgv()
    const { entries } = loadPluginManifests({
      configDir,
      manifestPaths,
    })
    const nameByPath = new Map<string, string>()
    for (const plugin of getPlugins()) {
      // The runtime's `dir` is the directory of the plugin file, not the
      // path itself. We match by walking entries and checking that
      // `path.dirname(entry.absPath)` equals `plugin.dir`.
      // Two entries in the same directory would collide; that's
      // structurally illegal since both would resolve to the same
      // `definePlugin({ name })`. Defensive: last-wins is fine.
      nameByPath.set(plugin.dir, plugin.name)
    }
    const rows: PluginManifestRow[] = entries.map((entry) => ({
      path: entry.absPath,
      manifestPath: entry.sourceFile,
      // A plugin's name is a static property of its manifest
      // (`definePlugin({ name })`), so it must not depend on whether
      // the plugin is currently loaded. Prefer the runtime name when
      // the plugin is enabled (cheap, authoritative); otherwise read
      // it statically from the manifest source so disabled plugins
      // keep a stable identity instead of going nameless.
      name:
        nameByPath.get(path.dirname(entry.absPath)) ??
        readManifestName(entry.absPath),
      enabled: entry.enabled,
      args: entry.args,
    }))
    return { rows, manifestPaths }
  }

  /** Flip `enabled: true` for the given plugin path. Idempotent. */
  async enable(args: { path: string }): Promise<void> {
    await this.setEnabled({ path: args.path, enabled: true })
  }

  /** Flip `enabled: false` for the given plugin path. Idempotent. */
  async disable(args: { path: string }): Promise<void> {
    await this.setEnabled({ path: args.path, enabled: false })
  }

  /**
   * Lower-level toggle. Writes the overlay manifest (or the only
   * manifest if no overlay was declared). Creates the overlay file
   * with a minimal `{ plugins: [] }` body if it doesn't exist yet.
   */
  async setEnabled(args: { path: string; enabled: boolean }): Promise<void> {
    const targetAbs = path.isAbsolute(args.path)
      ? args.path
      : path.resolve(readProjectFromArgv().configDir, args.path)
    const overlayPath = pickOverlayManifest()
    log(
      `[plugin-manager] setEnabled(${path.basename(targetAbs)}, enabled=${args.enabled}) -> ${overlayPath}`,
    )
    await mutateManifest(overlayPath, (manifest) => {
      // Find by absolute path under the overlay (we always store
      // overlay rows with their absolute path so they unambiguously
      // override a tracked entry regardless of how that tracked entry
      // was spelled).
      const existing = manifest.plugins.find((p) => {
        const abs = path.isAbsolute(p.path)
          ? p.path
          : path.resolve(path.dirname(overlayPath), p.path)
        return abs === targetAbs
      })
      if (existing) {
        existing.enabled = args.enabled
        return
      }
      manifest.plugins.push({
        path: targetAbs,
        enabled: args.enabled,
      })
    })
  }

  /**
   * Add a brand-new plugin row to the overlay manifest. Useful for the
   * marketplace install path, which currently does text surgery on
   * `zenbu.local.ts`. After this lands, callers should switch to
   * `addPlugin({ path: ... })` instead.
   */
  async addPlugin(args: { path: string; args?: unknown; enabled?: boolean }): Promise<void> {
    const overlayPath = pickOverlayManifest()
    const targetAbs = path.isAbsolute(args.path)
      ? args.path
      : path.resolve(path.dirname(overlayPath), args.path)
    const enabled = args.enabled === undefined ? true : args.enabled
    await mutateManifest(overlayPath, (manifest) => {
      const existing = manifest.plugins.find((p) => {
        const abs = path.isAbsolute(p.path)
          ? p.path
          : path.resolve(path.dirname(overlayPath), p.path)
        return abs === targetAbs
      })
      if (existing) {
        existing.enabled = enabled
        if (args.args !== undefined) existing.args = args.args
        return
      }
      manifest.plugins.push({
        path: targetAbs,
        enabled,
        args: args.args,
      })
    })
  }

  /**
   * Drop an entry from the overlay manifest. Does NOT touch the tracked
   * manifest; if the user wants to remove a tracked plugin they should
   * edit the tracked file directly (or use `disable` instead).
   */
  async removePlugin(args: { path: string }): Promise<void> {
    const overlayPath = pickOverlayManifest()
    const targetAbs = path.isAbsolute(args.path)
      ? args.path
      : path.resolve(path.dirname(overlayPath), args.path)
    await mutateManifest(overlayPath, (manifest) => {
      manifest.plugins = manifest.plugins.filter((p) => {
        const abs = path.isAbsolute(p.path)
          ? p.path
          : path.resolve(path.dirname(overlayPath), p.path)
        return abs !== targetAbs
      })
    })
  }
}

// =============================================================================
//                                  helpers
// =============================================================================

/**
 * Statically read a plugin's declared name from its manifest source
 * (`definePlugin({ name: "..." })`) without loading the module. Used
 * as a fallback for disabled plugins, which aren't in the runtime's
 * loaded-plugin registry but still have a stable name on disk.
 *
 * Cached by path + mtime since `list()` is polled by the UI and a
 * manifest's name effectively never changes between writes.
 */
const manifestNameCache = new Map<string, { mtimeMs: number; name: string | null }>()

function readManifestName(absPath: string): string | null {
  let mtimeMs: number
  try {
    mtimeMs = fs.statSync(absPath).mtimeMs
  } catch {
    return null
  }
  const cached = manifestNameCache.get(absPath)
  if (cached && cached.mtimeMs === mtimeMs) return cached.name

  let name: string | null = null
  try {
    const src = fs.readFileSync(absPath, "utf8")
    // Match the first `name: "..."` inside a `definePlugin({ ... })`
    // call. Non-greedy up to the name field; tolerant of whitespace
    // and single/double/back quotes.
    const match = src.match(
      /definePlugin\s*\(\s*\{[\s\S]*?\bname\s*:\s*["'`]([^"'`]+)["'`]/,
    )
    name = match?.[1] ?? null
  } catch {
    name = null
  }
  manifestNameCache.set(absPath, { mtimeMs, name })
  return name
}

interface ManifestState {
  plugins: Array<{ path: string; enabled?: boolean; args?: unknown }>
}

async function mutateManifest(
  manifestPath: string,
  mutate: (state: ManifestState) => void,
): Promise<void> {
  const state: ManifestState = (() => {
    if (!fs.existsSync(manifestPath)) {
      return { plugins: [] }
    }
    try {
      const raw = fs.readFileSync(manifestPath, "utf8")
      const parsed = parseJsonc(raw)
      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { plugins?: unknown }).plugins)
      ) {
        return parsed as ManifestState
      }
    } catch (err) {
      log.warn(
        `[plugin-manager] could not parse ${manifestPath}, starting fresh: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
    return { plugins: [] }
  })()
  mutate(state)
  const out = serializeManifest({ plugins: state.plugins })
  await fsp.mkdir(path.dirname(manifestPath), { recursive: true })
  await fsp.writeFile(manifestPath, out, "utf8")
}

/**
 * Resolve where to write enable/disable toggles.
 *
 * Strategy:
 *   - If the project declared two-or-more manifests, the last one wins
 *     (it's the overlay by convention).
 *   - If only one was declared (or the default tracked file is the only
 *     manifest), mutate it directly.
 *   - If `pluginsFiles` was omitted entirely, mutate
 *     `<configDir>/zenbu.plugins.local.jsonc` so we don't touch a
 *     tracked file.
 */
function pickOverlayManifest(): string {
  const config = getConfig()
  // `manifestPaths` is not on the snapshot today; pull it from the
  // resolved config the setup-gate stashed onto globalThis.
  const stash = (globalThis as unknown as {
    __zenbu_main_resolved_config__?: { payload?: unknown; manifestPaths?: string[] }
  }).__zenbu_main_resolved_config__
  const manifestPaths = readManifestPathsFromStash() ?? []
  if (manifestPaths.length >= 2) {
    return manifestPaths[manifestPaths.length - 1]!
  }
  if (manifestPaths.length === 1) {
    return manifestPaths[0]!
  }
  // Last resort: synthesize one next to the config.
  const configDir =
    config.appEntrypoint && path.dirname(path.dirname(config.appEntrypoint))
  if (configDir) {
    return path.join(configDir, DEFAULT_LOCAL_MANIFEST.replace(/^\.\//, ""))
  }
  // Truly should not happen; fall back to CWD.
  return path.resolve(process.cwd(), DEFAULT_LOCAL_MANIFEST.replace(/^\.\//, ""))
  void stash
}

interface ResolvedConfigStash {
  resolved?: {
    configPath?: string
    projectDir?: string
    manifestPaths?: string[]
  }
  payload?: unknown
  pluginSourceFiles?: string[]
}

function readManifestPathsFromStash(): string[] | null {
  const stash = (globalThis as unknown as {
    __zenbu_main_resolved_config__?: ResolvedConfigStash
  }).__zenbu_main_resolved_config__
  // `manifestPaths` was added with the JSONC switch \u2014 it lives on the
  // `LoaderData`-shaped stash, not on `resolved`. Read both shapes
  // defensively so a partial rollout still works.
  if (!stash) return null
  const directMP = (stash as unknown as { manifestPaths?: unknown }).manifestPaths
  if (Array.isArray(directMP)) return directMP.filter((x): x is string => typeof x === "string")
  if (stash.resolved && Array.isArray(stash.resolved.manifestPaths)) {
    return stash.resolved.manifestPaths.filter((x): x is string => typeof x === "string")
  }
  return null
}

function readProjectFromArgv(): { configDir: string; manifestPaths: string[] } {
  const mp = readManifestPathsFromStash() ?? []
  // If we have manifests stashed, the configDir is their common ancestor;
  // we derive it from the first manifest's directory.
  if (mp.length > 0) {
    return { configDir: path.dirname(mp[0]!), manifestPaths: mp }
  }
  return { configDir: process.cwd(), manifestPaths: [] }
}

runtime.register(PluginManagerService, import.meta)

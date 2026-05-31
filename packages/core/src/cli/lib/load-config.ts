import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"
import {
  DEFAULT_LOCAL_MANIFEST,
  DEFAULT_TRACKED_MANIFEST,
  resolveBuildConfig,
  type Config,
  type Plugin,
  type ResolvedConfig,
  type ResolvedPlugin,
  type ResolvedPluginDependency,
} from "./build-config"
import { loadPluginManifests, type PluginManifestEntry } from "./plugin-manifests"

const localRequire = createRequire(import.meta.url)

const CONFIG_NAMES = [
  "zenbu.config.ts",
  "zenbu.config.mts",
  "zenbu.config.js",
  "zenbu.config.mjs",
] as const

const PLUGIN_FILE_RE = /\.(?:ts|mts|js|mjs|cjs)$/

/**
 * Parse repeatable `--plugin=<path>` flags from an argv array.
 * Exposed for testability; in production the caller is `loadConfig`.
 */
export function collectArgvPlugins(argv: readonly string[]): string[] {
  const out: string[] = []
  for (const arg of argv) {
    if (typeof arg !== "string") continue
    if (arg.startsWith("--plugin=")) {
      const v = arg.slice("--plugin=".length)
      if (v.length > 0) out.push(v)
    }
  }
  return out
}

export function findConfigPath(projectDir: string): string {
  for (const name of CONFIG_NAMES) {
    const candidate = path.join(projectDir, name)
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error(
    `No zenbu config found at ${projectDir}. Expected one of: ${CONFIG_NAMES.join(", ")}`,
  )
}

let tsxRegistered: Promise<void> | null = null
function ensureTsxRegistered(): Promise<void> {
  if (tsxRegistered) return tsxRegistered
  tsxRegistered = (async () => {
    try {
      const tsxApi: { register?: () => unknown } = localRequire("tsx/esm/api")
      if (typeof tsxApi.register === "function") tsxApi.register()
    } catch {
      // tsx not available — caller's TS files must already be transpiled.
    }
  })()
  return tsxRegistered
}

/**
 * Dynamically import a TS module with a cache-busting query string. Each call
 * forces tsx + Node's ESM loader to re-evaluate the file. Used to rebuild
 * the resolved config + plugin set every time the loader is invoked, so a
 * change to the source TS triggers a fresh `default` export.
 */
async function importFresh<T>(absPath: string): Promise<T> {
  await ensureTsxRegistered()
  const url = pathToFileURL(absPath).href + "?t=" + Date.now()
  const mod = (await import(url)) as { default?: T }
  return ((mod.default ?? (mod as unknown)) as T)
}

function assertPluginShape(p: unknown, source: string): asserts p is Plugin {
  if (!p || typeof p !== "object") {
    throw new Error(`${source} did not export a Plugin object.`)
  }
  const obj = p as Record<string, unknown>
  if (typeof obj.name !== "string" || obj.name.length === 0) {
    throw new Error(`${source}: plugin missing required string \`name\`.`)
  }
  if (!Array.isArray(obj.services)) {
    throw new Error(`${source}: plugin \`services\` must be an array of glob strings.`)
  }
  if (obj.dependsOn !== undefined) {
    if (!Array.isArray(obj.dependsOn)) {
      throw new Error(`${source}: plugin \`dependsOn\` must be an array.`)
    }
    for (const [i, dep] of (obj.dependsOn as unknown[]).entries()) {
      if (!dep || typeof dep !== "object") {
        throw new Error(
          `${source}: dependsOn[${i}] must be an object with { name, from }.`,
        )
      }
      const d = dep as Record<string, unknown>
      if (typeof d.name !== "string" || d.name.length === 0) {
        throw new Error(`${source}: dependsOn[${i}].name must be a non-empty string.`)
      }
      if (typeof d.from !== "string" || d.from.length === 0) {
        throw new Error(`${source}: dependsOn[${i}].from must be a non-empty string.`)
      }
    }
  }
}

function resolveDependsOn(
  plugin: Plugin,
  dir: string,
): ResolvedPluginDependency[] | undefined {
  if (!plugin.dependsOn || plugin.dependsOn.length === 0) return undefined
  return plugin.dependsOn.map((d) => ({
    name: d.name,
    fromPath: path.isAbsolute(d.from) ? d.from : path.resolve(dir, d.from),
  }))
}

function resolvePluginPaths(
  plugin: Plugin,
  dir: string,
  args?: unknown,
): ResolvedPlugin {
  const abs = (rel: string): string =>
    path.isAbsolute(rel) ? rel : path.resolve(dir, rel)
  return {
    name: plugin.name,
    dir,
    services: plugin.services.map((s) => (path.isAbsolute(s) ? s : path.resolve(dir, s))),
    schemaPath: plugin.schema ? abs(plugin.schema) : undefined,
    migrationsPath: plugin.migrations ? abs(plugin.migrations) : undefined,
    preloadPath: plugin.preload ? abs(plugin.preload) : undefined,
    eventsPath: plugin.events ? abs(plugin.events) : undefined,
    icons: plugin.icons,
    args,
    dependsOn: resolveDependsOn(plugin, dir),
  }
}

/**
 * Resolve a single plugin file (already an absolute `.ts`/`.js` path) to a
 * `ResolvedPlugin`. The plugin's relative paths anchor to the directory
 * the plugin file lives in.
 */
async function resolvePluginFile(
  absPath: string,
  args?: unknown,
): Promise<ResolvedPlugin> {
  const { bootTrace } = await import("../../boot-trace")
  if (!PLUGIN_FILE_RE.test(absPath)) {
    throw new Error(
      `Plugin entry "${absPath}" must point at a .ts/.js file (got ${path.basename(absPath)}).`,
    )
  }
  if (!fs.existsSync(absPath)) {
    throw new Error(`Plugin entry does not exist at ${absPath}.`)
  }
  const plugin = await bootTrace.span(
    `import-plugin:${path.basename(absPath)}`,
    () => importFresh<Plugin>(absPath),
    { path: absPath },
  )
  assertPluginShape(plugin, absPath)
  return resolvePluginPaths(plugin, path.dirname(absPath), args)
}

export interface LoadConfigOptions {
  /**
   * Skip overlay manifests (anything declared in `pluginsFiles` past index
   * 0). Set by build/publish commands so per-developer local toggles
   * don't ship.
   */
  skipLocalManifests?: boolean
}

function resolveManifestDeclarations(
  config: Config,
  configDir: string,
): { declared: string[]; trackedAbs: string } {
  const list =
    config.pluginsFiles === undefined
      ? [DEFAULT_TRACKED_MANIFEST, DEFAULT_LOCAL_MANIFEST]
      : Array.isArray(config.pluginsFiles)
        ? config.pluginsFiles
        : [config.pluginsFiles]
  if (list.length === 0) {
    throw new Error(
      `zenbu config: \`pluginsFiles\` must declare at least one manifest path.`,
    )
  }
  const declared = list.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(
        `zenbu config: \`pluginsFiles\` entries must be non-empty strings.`,
      )
    }
    return entry
  })
  const trackedAbs = path.isAbsolute(declared[0]!)
    ? declared[0]!
    : path.resolve(configDir, declared[0]!)
  return { declared, trackedAbs }
}

/**
 * Read `<projectDir>/zenbu.config.ts`, resolve the declared JSONC plugin
 * manifests, and turn the merged + filtered plugin list into
 * `ResolvedPlugin[]`.
 *
 * Used both by the loader (to generate the plugin barrel; cache-busted on
 * every invocation) and by CLI commands (`build:source`, `build:electron`,
 * `link`, `db generate`, `publish:source`).
 */
export async function loadConfig(
  projectDir: string,
  options: LoadConfigOptions = {},
): Promise<{
  resolved: ResolvedConfig
  /** External files the caller should hot-watch. */
  pluginSourceFiles: string[]
}> {
  const configPath = findConfigPath(projectDir)
  const config = await importFresh<Config>(configPath)
  if (!config || typeof config !== "object") {
    throw new Error(`${configPath} default export is not a Config object.`)
  }
  // Reject the pre-JSONC config shape with a clear error rather than
  // silently dropping the user's plugin list.
  const legacy = config as unknown as Record<string, unknown>
  if (Array.isArray(legacy.plugins)) {
    throw new Error(
      `${configPath}: \`plugins\` array is no longer supported. ` +
        `Move plugin entries into \`zenbu.plugins.jsonc\` and declare it via \`pluginsFiles\`. ` +
        `See https://zenbulabs.mintlify.app/concepts.`,
    )
  }
  if (legacy.localPlugins !== undefined) {
    throw new Error(
      `${configPath}: \`localPlugins\` is no longer supported. ` +
        `Use a per-developer manifest file (e.g. \`zenbu.plugins.local.jsonc\`) listed in \`pluginsFiles\`.`,
    )
  }
  const dbField =
    typeof config.db === "string" && config.db.length > 0
      ? config.db
      : "./.zenbu/db"
  if (typeof config.uiEntrypoint !== "string" || config.uiEntrypoint.length === 0) {
    throw new Error(
      `${configPath}: missing required \`uiEntrypoint\` field (directory holding index.html).`,
    )
  }

  const configDir = path.dirname(configPath)
  const dbPath = path.isAbsolute(dbField)
    ? dbField
    : path.resolve(configDir, dbField)
  const uiEntrypointPath = path.isAbsolute(config.uiEntrypoint)
    ? config.uiEntrypoint
    : path.resolve(configDir, config.uiEntrypoint)
  const uiStat = (() => {
    try { return fs.statSync(uiEntrypointPath) } catch { return null }
  })()
  if (!uiStat?.isDirectory()) {
    throw new Error(
      `${configPath}: uiEntrypoint must point at a directory; got ${config.uiEntrypoint}.`,
    )
  }
  const splashCandidate = path.join(uiEntrypointPath, "splash.html")
  const splashPath = fs.existsSync(splashCandidate) ? splashCandidate : undefined
  const installingCandidate = path.join(uiEntrypointPath, "installing.html")
  const installingPath = fs.existsSync(installingCandidate)
    ? installingCandidate
    : undefined
  const updatingCandidate = path.join(uiEntrypointPath, "updating.html")
  const updatingPath = fs.existsSync(updatingCandidate)
    ? updatingCandidate
    : undefined

  const { declared, trackedAbs } = resolveManifestDeclarations(config, configDir)
  const effectiveManifestDecls = options.skipLocalManifests
    ? [declared[0]!]
    : declared
  const { entries, watched } = loadPluginManifests({
    configDir,
    manifestPaths: effectiveManifestDecls,
  })
  const pluginSourceFiles: string[] = [...watched]

  const plugins: ResolvedPlugin[] = []
  const seen = new Set<string>()
  const enabledEntries: PluginManifestEntry[] = entries.filter((e) => e.enabled)
  for (const entry of enabledEntries) {
    if (seen.has(entry.absPath)) continue
    seen.add(entry.absPath)
    const resolved = await resolvePluginFile(entry.absPath, entry.args)
    plugins.push(resolved)
    pluginSourceFiles.push(entry.absPath)
  }

  // Argv-driven plugin entries: any number of `--plugin=<path>` flags on
  // process.argv. Treated as always-enabled. Useful for one-off dev runs
  // (`zen dev --plugin=./plugins/scratchpad/zenbu.plugin.ts`) without
  // touching any manifest file. Not consulted when `skipLocalManifests`
  // is set so build/publish stay reproducible.
  if (!options.skipLocalManifests) {
    const argvPlugins = collectArgvPlugins(process.argv)
    for (const argvPath of argvPlugins) {
      const abs = path.isAbsolute(argvPath)
        ? argvPath
        : path.resolve(process.cwd(), argvPath)
      if (seen.has(abs)) continue
      if (!fs.existsSync(abs)) {
        throw new Error(
          `--plugin=${argvPath}: file does not exist (resolved to ${abs}).`,
        )
      }
      if (!PLUGIN_FILE_RE.test(abs)) {
        throw new Error(
          `--plugin=${argvPath}: must point at a .ts/.js file (got ${path.basename(abs)}).`,
        )
      }
      seen.add(abs)
      const resolved = await resolvePluginFile(abs)
      plugins.push(resolved)
      pluginSourceFiles.push(abs)
    }
  }

  const build = resolveBuildConfig(
    config.build ?? {
      source: ".",
      include: ["**/*"],
    },
  )

  // Compute absolute manifest paths in the same order the user declared them.
  const manifestPaths = declared.map((entry) =>
    path.isAbsolute(entry) ? entry : path.resolve(configDir, entry),
  )

  return {
    resolved: {
      configPath,
      projectDir: configDir,
      dbPath,
      uiEntrypointPath,
      splashPath,
      installingPath,
      updatingPath,
      plugins,
      manifestPaths,
      build,
    },
    pluginSourceFiles,
  }
}

/**
 * Resolve a `dependsOn[].fromPath` to a `ResolvedPlugin`.
 *
 * `fromPath` may be:
 *   - a `zenbu.plugin.ts` (single plugin: load and return it; `name` must
 *     match the plugin's `name`),
 *   - a `zenbu.config.ts` (multi-plugin: load JSONC manifests and pick
 *     `plugins[].name === name`).
 *
 * No recursion into the upstream's own `dependsOn` happens here — we only
 * need the upstream's **own surface** for vendoring.
 */
export async function loadPluginFromPath(args: {
  fromPath: string
  name: string
}): Promise<ResolvedPlugin> {
  const { fromPath, name } = args
  if (!fs.existsSync(fromPath)) {
    throw new Error(
      `dependsOn: file ${fromPath} does not exist (looking for plugin "${name}").`,
    )
  }
  if (!PLUGIN_FILE_RE.test(fromPath)) {
    throw new Error(
      `dependsOn: \`from\` must point at a .ts/.js file, got ${path.basename(fromPath)}.`,
    )
  }
  const base = path.basename(fromPath)
  const isConfig = base.startsWith("zenbu.config.")
  if (isConfig) {
    // Recursively load the upstream config so its JSONC manifests get
    // resolved the same way ours do, then pick the matching plugin.
    const { resolved } = await loadConfig(path.dirname(fromPath), {
      skipLocalManifests: true,
    })
    const hit = resolved.plugins.find((p) => p.name === name)
    if (!hit) {
      throw new Error(
        `dependsOn: ${fromPath} does not declare a plugin named "${name}".`,
      )
    }
    return hit
  }
  const plugin = await importFresh<Plugin>(fromPath)
  assertPluginShape(plugin, fromPath)
  if (plugin.name !== name) {
    throw new Error(
      `dependsOn: ${fromPath} exports plugin "${plugin.name}", expected "${name}".`,
    )
  }
  return resolvePluginPaths(plugin, path.dirname(fromPath))
}

/**
 * Load a standalone `zenbu.plugin.ts` (or any TS file whose default export
 * is a `Plugin`) and return its `ResolvedPlugin`. Used by `zen link
 * --plugin <dir>` to wire types for a plugin that has no host context yet.
 */
export async function loadPluginManifest(filePath: string): Promise<ResolvedPlugin> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`zen link --plugin: ${filePath} does not exist.`)
  }
  if (!PLUGIN_FILE_RE.test(filePath)) {
    throw new Error(
      `zen link --plugin: expected a .ts/.js file, got ${path.basename(filePath)}.`,
    )
  }
  const plugin = await importFresh<Plugin>(filePath)
  assertPluginShape(plugin, filePath)
  return resolvePluginPaths(plugin, path.dirname(filePath))
}

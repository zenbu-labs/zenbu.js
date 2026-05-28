import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"
import {
  resolveBuildConfig,
  type Config,
  type LocalPluginsDefault,
  type Plugin,
  type ResolvedConfig,
  type ResolvedPlugin,
  type ResolvedPluginDependency,
} from "./build-config"

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
 *
 * The returned object is whatever the module's default export is. Older
 * defineConfig-style files that exported the object directly (no `default`)
 * also work via the `mod.default ?? mod` fallback.
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

function resolvePluginPaths(plugin: Plugin, dir: string): ResolvedPlugin {
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
    dependsOn: resolveDependsOn(plugin, dir),
  }
}

async function resolvePluginEntry(
  entry: Plugin | string,
  configDir: string,
): Promise<{ resolved: ResolvedPlugin; sourceFile: string | null }> {
  // Boot-trace via dynamic import to keep this CLI module usable
  // outside the framework runtime (e.g. tests).
  const { bootTrace } = await import("../../boot-trace")
  if (typeof entry === "string") {
    const absPath = path.isAbsolute(entry) ? entry : path.resolve(configDir, entry)
    if (!PLUGIN_FILE_RE.test(absPath)) {
      throw new Error(
        `Plugin entry "${entry}" must point at a .ts/.js file (got ${path.basename(absPath)}). ` +
          `JSON plugin manifests are not supported in the new config; convert to \`zenbu.plugin.ts\`.`,
      )
    }
    if (!fs.existsSync(absPath)) {
      throw new Error(`Plugin entry "${entry}" does not exist at ${absPath}.`)
    }
    const plugin = await bootTrace.span(
      `import-plugin:${path.basename(absPath)}`,
      () => importFresh<Plugin>(absPath),
      { path: absPath },
    )
    assertPluginShape(plugin, absPath)
    return {
      resolved: resolvePluginPaths(plugin, path.dirname(absPath)),
      sourceFile: absPath,
    }
  }
  // Inline plugin: paths are anchored to the config file's directory because
  // that's the user's mental model when they write the inline form. The
  // alternative (e.g. anchoring to wherever the inline definePlugin call
  // lives) would be the same place 99% of the time anyway.
  assertPluginShape(entry, "(inline plugin)")
  return {
    resolved: resolvePluginPaths(entry, configDir),
    sourceFile: null,
  }
}

export interface LoadConfigOptions {
  /** Skip `config.localPlugins`. Set by build/publish commands so dev-only overlays don't ship. */
  skipLocalPlugins?: boolean
}

/**
 * Read `<projectDir>/zenbu.config.ts`, resolve all plugin entries (inline +
 * path), make every relative path absolute, and fill in `build` defaults.
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
  /** External plugin file paths the caller should hot-watch. */
  pluginSourceFiles: string[]
}> {
  const configPath = findConfigPath(projectDir)
  const config = await importFresh<Config>(configPath)
  if (!config || typeof config !== "object") {
    throw new Error(`${configPath} default export is not a Config object.`)
  }
  // `db` is optional; defaults to `./.zenbu/db` relative to the config so
  // apps that don't (yet) ship a schema don't need to declare anything.
  // The directory is created lazily on first write by DbService.
  const dbField =
    typeof config.db === "string" && config.db.length > 0
      ? config.db
      : "./.zenbu/db"
  if (typeof config.uiEntrypoint !== "string" || config.uiEntrypoint.length === 0) {
    throw new Error(
      `${configPath}: missing required \`uiEntrypoint\` field (directory holding index.html).`,
    )
  }
  if (!Array.isArray(config.plugins)) {
    throw new Error(`${configPath}: \`plugins\` must be an array.`)
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
  // Optional: `installing.html` next to splash. When present, the
  // production launcher loads it during clone + first install. Not
  // required — apps without it just see the dock icon during install.
  const installingCandidate = path.join(uiEntrypointPath, "installing.html")
  const installingPath = fs.existsSync(installingCandidate)
    ? installingCandidate
    : undefined
  // Optional: `updating.html` next to splash + installing. When present,
  // `zen build:electron` stages it into Resources/ so the in-app plugin
  // updater can show a window during the git fast-forward + dep refresh
  // (see `plugin-update-supervisor.ts`). Not used in dev directly here;
  // the supervisor resolves it at runtime via `getAppEntrypoint()`.
  const updatingCandidate = path.join(uiEntrypointPath, "updating.html")
  const updatingPath = fs.existsSync(updatingCandidate)
    ? updatingCandidate
    : undefined

  const plugins: ResolvedPlugin[] = []
  const pluginSourceFiles: string[] = []
  for (const entry of config.plugins) {
    const { resolved, sourceFile } = await resolvePluginEntry(entry, configDir)
    plugins.push(resolved)
    if (sourceFile) pluginSourceFiles.push(sourceFile)
  }

  // Optional gitignored overlay; see `Config.localPlugins`.
  if (!options.skipLocalPlugins && config.localPlugins !== undefined) {
    const overlayPaths = Array.isArray(config.localPlugins)
      ? config.localPlugins
      : [config.localPlugins]
    for (const overlayPath of overlayPaths) {
      if (typeof overlayPath !== "string" || overlayPath.length === 0) {
        throw new Error(
          `${configPath}: \`localPlugins\` entries must be non-empty strings.`,
        )
      }
      const overlayAbs = path.isAbsolute(overlayPath)
        ? overlayPath
        : path.resolve(configDir, overlayPath)
      // Always register the overlay path with the loader so its
      // *creation* (not just its edits) triggers a config reload.
      // dynohot's FileWatcher takes the dirname of a non-existent
      // path and watches the parent directory for any event whose
      // basename matches — i.e. a watch on `zenbu.local.ts` before
      // the file exists is functionally a watch for that file to
      // *appear*. Without this push, a plugin-installer that
      // creates `zenbu.local.ts` mid-session has no way to make
      // its new entry boot until the user manually touches
      // `zenbu.config.ts`.
      //
      // We push BEFORE the existence check so this path is also
      // hit when there's no file on disk to import.
      pluginSourceFiles.push(overlayAbs)
      // Missing file is the happy path — silently skip loading.
      if (!fs.existsSync(overlayAbs)) continue
      if (!PLUGIN_FILE_RE.test(overlayAbs)) {
        throw new Error(
          `${configPath}: localPlugins must point at a .ts/.js file, got ${path.basename(overlayAbs)}.`,
        )
      }
      const overlayDir = path.dirname(overlayAbs)
      const overlayDefault = await importFresh<LocalPluginsDefault>(overlayAbs)
      const entries = Array.isArray(overlayDefault)
        ? overlayDefault
        : [overlayDefault]
      // Relative paths inside the overlay anchor to the overlay's dir, not configDir.
      for (const entry of entries) {
        const { resolved, sourceFile } = await resolvePluginEntry(entry, overlayDir)
        plugins.push(resolved)
        if (sourceFile) pluginSourceFiles.push(sourceFile)
      }
    }
  }

  // Argv-driven plugin entries: any number of `--plugin=<path>` flags on
  // process.argv. Treated the same as a string entry in `config.plugins`
  // (resolved relative to `process.cwd()`, must exist, must be .ts/.js,
  // hot-watched via `pluginSourceFiles`).
  //
  // Intentionally simpler than `localPlugins`: there's no overlay file to
  // watch for *creation*, since the user passes the path explicitly when
  // launching the dev instance. If the path doesn't exist we fail fast
  // here instead of silently skipping — the whole point of the flag is
  // "load THIS plugin", so a missing file is a configuration error, not
  // a no-op.
  if (!options.skipLocalPlugins) {
    const argvPlugins = collectArgvPlugins(process.argv)
    for (const argvPath of argvPlugins) {
      const abs = path.isAbsolute(argvPath)
        ? argvPath
        : path.resolve(process.cwd(), argvPath)
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
      const { resolved, sourceFile } = await resolvePluginEntry(abs, configDir)
      plugins.push(resolved)
      if (sourceFile) pluginSourceFiles.push(sourceFile)
    }
  }

  const build = resolveBuildConfig(
    config.build ?? {
      source: ".",
      include: ["**/*"],
    },
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
 *   - a `zenbu.config.ts` (multi-plugin: load and pick `plugins[].name === name`).
 *
 * No recursion into the upstream's own `dependsOn` happens here — we only
 * need the upstream's **own surface** for vendoring, never its composite.
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
    const config = await importFresh<Config>(fromPath)
    if (!config || typeof config !== "object" || !Array.isArray(config.plugins)) {
      throw new Error(
        `dependsOn: ${fromPath} is not a valid zenbu config (no \`plugins\` array).`,
      )
    }
    const configDir = path.dirname(fromPath)
    for (const entry of config.plugins) {
      const { resolved } = await resolvePluginEntry(entry, configDir)
      if (resolved.name === name) return resolved
    }
    throw new Error(
      `dependsOn: ${fromPath} does not declare a plugin named "${name}".`,
    )
  }
  // Treat as a `zenbu.plugin.ts` (or any .ts file whose default export is a Plugin).
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
 *
 * Unlike `loadPluginFromPath`, no `name` filter is required — the file
 * must declare a single plugin.
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

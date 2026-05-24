// Build pipeline shape used by `zen build:source` and `zen build:electron`.
// User code authors a `build` field inside `zenbu.config.ts` via
// `defineBuildConfig(...)`, or imports just the helpers when they want to
// extract build into a separate file.

export interface BuildContext {
  /** Absolute path to the source root (`build.source` resolved). */
  sourceDir: string;
  /** Absolute path to the staging output dir (`build.out` resolved). */
  outDir: string;
  /** Git HEAD of the source repo at build time, or `"uncommitted"`. */
  sourceSha: string;
  /** Absolute path to the `zenbu.config.ts` driving this build. */
  configPath: string;
}

export interface EmitContext extends BuildContext {
  /**
   * Write an additional file into `outDir`. Relative paths only — anything
   * absolute or escaping `outDir` (via `..`) throws. Emitted files
   * participate in the build's `.sha` content hash.
   */
  emit(relPath: string, contents: string | Uint8Array): void;
}

export interface BuildPlugin {
  name: string;
  /**
   * Called once per text file after `include`/`ignore` filtering, before
   * the file is written to `outDir`. Plugins run in declaration order;
   * each plugin's return value (if any) feeds the next.
   *
   * Return:
   *   - a string  → use it as the new contents
   *   - `null`    → drop the file (short-circuits remaining plugins)
   *   - `void`    → leave contents unchanged
   *
   * Binary files (anything outside the small text-extension allow-list)
   * are not visible to `transform` — they're copied byte-for-byte.
   */
  transform?(
    file: { path: string; contents: string },
    ctx: BuildContext,
  ): string | null | void | Promise<string | null | void>;
  /**
   * Called once after every source file is written. Use `ctx.emit(...)` to
   * write additional files (build manifests, generated artifacts, etc.)
   * into `outDir`. Plugins run in declaration order.
   */
  done?(ctx: EmitContext): void | Promise<void>;
}

export interface MirrorConfig {
  target: string;
  branch?: string;
}

export interface BundleConfig {
  extraResources?: string[];
}

/**
 * Which package manager the produced .app should bundle and use to install
 * the cloned source's dependencies on first launch.
 *
 * Exactly one PM per .app. The `version` is honored verbatim across all four
 * variants: it drives the download URL at build time and is recorded in
 * `app-config.json` so the launcher knows which CI-mode codepath to take.
 *
 * `bun` is not special at the API layer — but internally the runtime bun and
 * the PM bun are collapsed into a single binary at the user's chosen
 * version (so picking bun yields one binary in the bundle, not two).
 */
export type PackageManagerSpec =
  | { type: "pnpm"; version: string }
  | { type: "npm"; version: string }
  | { type: "yarn"; version: string }
  | { type: "bun"; version: string };

/**
 * Soft default when the user omits `build.packageManager` entirely. Existing
 * apps scaffolded before this field existed pick this up. The version
 * tracks whatever pnpm we'd otherwise have hardcoded in the toolchain.
 */
export const DEFAULT_PACKAGE_MANAGER: PackageManagerSpec = {
  type: "pnpm",
  version: "10.33.0",
};

export interface BuildConfig {
  source?: string;
  out?: string;
  include: string[];
  ignore?: string[];
  plugins?: BuildPlugin[];
  mirror?: MirrorConfig;
  bundle?: BundleConfig;
  packageManager?: PackageManagerSpec;
}

export function defineBuildConfig(config: BuildConfig): BuildConfig {
  return config;
}

export type ResolvedBuildConfig = Required<
  Omit<BuildConfig, "mirror" | "bundle">
> & {
  mirror?: MirrorConfig;
  bundle?: BundleConfig;
  packageManager: PackageManagerSpec;
};

function validatePackageManager(spec: PackageManagerSpec): PackageManagerSpec {
  const allowed = ["pnpm", "npm", "yarn", "bun"] as const;
  if (!allowed.includes(spec.type as (typeof allowed)[number])) {
    throw new Error(
      `zenbu build.packageManager: unknown type "${
        (spec as { type: string }).type
      }". ` + `Expected one of: ${allowed.join(", ")}.`,
    );
  }
  if (typeof spec.version !== "string" || spec.version.trim().length === 0) {
    throw new Error(
      `zenbu build.packageManager.${spec.type}: \`version\` is required and must be a non-empty string.`,
    );
  }
  return spec;
}

export function resolveBuildConfig(config: BuildConfig): ResolvedBuildConfig {
  const packageManager = validatePackageManager(
    config.packageManager ?? DEFAULT_PACKAGE_MANAGER,
  );
  return {
    source: config.source ?? ".",
    out: config.out ?? ".zenbu/build/source",
    include: config.include,
    ignore: config.ignore ?? [],
    plugins: config.plugins ?? [],
    mirror: config.mirror,
    bundle: config.bundle,
    packageManager,
  };
}

// =============================================================================
//                                Plugin shape
// =============================================================================

/**
 * A Zenbu plugin's main-process surface. Plugins are pure main-process: they
 * register services + side-effect modules (schema, preload, events). UI is
 * handled exclusively at the outer config level via `uiEntrypoint` — there
 * is exactly one HTML entrypoint per app.
 *
 * `services` is an array of glob patterns (relative to the plugin file's
 * directory). `schema` / `preload` / `events` are optional file paths.
 */
export interface Plugin {
  name: string;
  services: string[];
  schema?: string;
  migrations?: string;
  preload?: string;
  events?: string;
  /**
   * Plugin-author-defined SVG icons keyed by view type. Read by
   * `view-registry` to decorate registered views. Optional.
   */
  icons?: Record<string, string>;
  /**
   * Other plugins whose **own type surface** this plugin needs at compile time.
   *
   * Each entry names an upstream plugin (`name`) and a relative path
   * (`from`) to the file that defines it — either a `zenbu.plugin.ts`
   * (whose default export is a `definePlugin(...)`) or a `zenbu.config.ts`
   * (in which case `name` disambiguates which entry of `plugins:` to use).
   *
   * `zen link` materializes each declared dep as a vendored, committed copy
   * inside `<plugin>/types/deps/<name>/`. The plugin's composite augmentation
   * (`<plugin>/types/zenbu-register.ts`) then wires the vendored own surface
   * into `ZenbuRegister`, so `useDb` / `useRpc` / `useEvents` selectors work
   * even when the plugin is opened in isolation (no host context required).
   *
   * Composites never depend on other composites — only on **own** surfaces —
   * so the dependency graph is a strict DAG and mutual deps are legal.
   */
  dependsOn?: PluginDependency[];
}

/**
 * A type-time dependency on another plugin. `from` is the path to the
 * upstream's manifest file; `name` selects which plugin if `from` is a
 * `zenbu.config.ts` with multiple entries. Both fields are required so
 * the resolver never has to guess between same-named plugins in different
 * trees.
 */
export interface PluginDependency {
  name: string;
  from: string;
}

export function definePlugin(plugin: Plugin): Plugin {
  return plugin;
}

/**
 * A plugin manifest after path resolution. Every relative path has been made
 * absolute against `dir` (the directory the manifest came from). Glob-form
 * service entries stay as patterns (still anchored to `dir`).
 *
 * The runtime stores these in `runtime.getPlugins()`; consumers like
 * `services/db.ts`, `services/advice-config.ts`, `vite-plugins.ts` read from
 * there instead of walking the filesystem looking for `zenbu.plugin.json`.
 */
export interface ResolvedPlugin {
  name: string;
  /** Absolute directory the plugin was loaded from. */
  dir: string;
  /** Glob patterns for service files. Anchored to `dir`. */
  services: string[];
  /** Absolute path to `schema.ts` (or undefined). */
  schemaPath?: string;
  /** Absolute path to migrations dir/file (or undefined). */
  migrationsPath?: string;
  /** Absolute path to `preload.ts` (or undefined). */
  preloadPath?: string;
  /** Absolute path to `events.ts` (or undefined). */
  eventsPath?: string;
  /** Plugin-author-defined SVG icons. */
  icons?: Record<string, string>;
  /**
   * Type-time dependencies, with `from` already absolute. The upstream
   * plugin itself is NOT loaded here — `zen link` does that lazily so the
   * runtime path (`getConfig()`, plugin barrel emission) doesn't pay the
   * cost of recursively walking other configs/manifests.
   */
  dependsOn?: ResolvedPluginDependency[];
}

export interface ResolvedPluginDependency {
  name: string;
  /** Absolute path to the upstream `zenbu.plugin.ts` or `zenbu.config.ts`. */
  fromPath: string;
}

// =============================================================================
//                                 Top-level config
// =============================================================================

/**
 * The whole-app `zenbu.config.ts` shape. Authored by user code; imported
 * (and re-imported on every change) by the loader and CLI.
 *
 * - `db`: directory the kyju database lives in (relative to the config file).
 * - `uiEntrypoint`: path to the boot-window's HTML file. Exactly one — there
 *   is no per-plugin UI (today's per-plugin `uiEntrypoint` was effectively a
 *   bug that the new shape disallows at the type level).
 * - `plugins`: flat list. Each entry is either an inline `definePlugin({...})`
 *   or a path to a `zenbu.plugin.ts` whose default export is a plugin. The
 *   "host plugin" is just `plugins[0]` by convention; nothing structurally
 *   distinguishes it.
 * - `build`: shipped as `defineBuildConfig({...})`. Drives `zen build:source`
 *   and `zen build:electron`.
 */
export interface Config {
  /** Defaults to `./.zenbu/db` relative to the config file. */
  db?: string;
  uiEntrypoint: string;
  plugins: Array<Plugin | string>;
  /**
   * Path(s) to gitignored overlay file(s) whose default export is a
   * plugin entry or array of entries (same shape as `plugins`). Missing
   * files are silently ignored. Edits hot-reload like `zenbu.config.ts`.
   * Skipped by `build:source` / `build:electron` / `publish:source`.
   */
  localPlugins?: string | string[];
  build?: BuildConfig;
}

/** Default export shape for a `localPlugins` file. */
export type LocalPluginsDefault = Plugin | string | Array<Plugin | string>;

export function defineConfig(config: Config): Config {
  return config;
}

export interface ResolvedConfig {
  /** Absolute path to the `zenbu.config.ts` this came from. */
  configPath: string;
  /** Directory containing `zenbu.config.ts`. */
  projectDir: string;
  /** Absolute path to the database directory. */
  dbPath: string;
  /**
   * Absolute path to the renderer's entrypoint directory. Vite's `root`
   * resolves here; `index.html` inside it is served through Vite.
   */
  uiEntrypointPath: string;
  /**
   * Absolute path to `splash.html` inside the entrypoint directory. Loaded
   * raw (no Vite) into a transient BrowserView during the brief window
   * between Electron `whenReady` and the renderer's first paint.
   */
  splashPath: string;
  /**
   * Absolute path to `installing.html` inside the entrypoint directory, if
   * the user provided one. Optional. Production launcher loads this raw
   * during clone + first install (before the user's source even exists in
   * the apps-dir). Receives IPC progress events via the framework's
   * built-in `installing-preload.cjs`. Not used in dev mode — `pnpm dev`
   * doesn't clone or install.
   */
  installingPath?: string;
  plugins: ResolvedPlugin[];
  /** Resolved build config; defaults filled in even when user omits. */
  build: ResolvedBuildConfig;
}

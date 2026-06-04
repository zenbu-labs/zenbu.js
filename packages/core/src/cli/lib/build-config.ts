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

// Plugin shape

/**
 * A Zenbu plugin's main-process surface (services + optional schema/preload/
 * events). `services` is glob patterns relative to the plugin file's dir; the
 * other paths are optional. UI lives at the config level (`uiEntrypoint`).
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
   * Other plugins whose type surface this plugin needs at compile time.
   * `zen link` vendors each declared dep so `useDb`/`useRpc`/`useEvents`
   * resolve even when the plugin is opened in isolation.
   */
  dependsOn?: PluginDependency[];
}

/**
 * A type-time dependency on another plugin. `from` is the upstream manifest
 * path; `name` selects the plugin when `from` is a multi-entry config.
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
   * Opaque payload passed through from the manifest entry's `args` field.
   * Surfaced on the runtime `PluginRecord` so services that want
   * per-plugin configuration can read it without re-parsing the manifest.
   */
  args?: unknown;
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

// Top-level config

/** The whole-app `zenbu.config.ts` shape, authored by user code. */
export interface Config {
  /** Defaults to `./.zenbu/db` relative to the config file. */
  db?: string;
  uiEntrypoint: string;
  /**
   * Path(s) to JSONC manifests declaring loaded plugins. Defaults to
   * `./zenbu.plugins.jsonc` (tracked) + `./zenbu.plugins.local.jsonc`
   * (gitignored). Later files override earlier; build/publish use only the
   * first (tracked) file so per-developer overlays don't ship.
   */
  pluginsFiles?: string | string[];
  build?: BuildConfig;
}

/**
 * Back-compat alias kept so existing user code that imports the type
 * from `@zenbujs/core/config` still typechecks after the switch to
 * JSONC manifests. Not used by anything in core.
 *
 * @deprecated Plugins now live in `zenbu.plugins.jsonc`; this type is
 *             a stub so old `zenbu.local.ts` files keep typechecking
 *             until they're deleted.
 */
export type LocalPluginsDefault = Plugin | string | Array<Plugin | string>;

export const DEFAULT_TRACKED_MANIFEST = "./zenbu.plugins.jsonc";
export const DEFAULT_LOCAL_MANIFEST = "./zenbu.plugins.local.jsonc";

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
   * Absolute path to optional `splash.html` inside the entrypoint directory.
   * When absent, Zenbu skips the transient splash view and waits for the
   * real entrypoint renderer to paint.
   */
  splashPath?: string;
  /**
   * Absolute path to optional `installing.html`. Production launcher loads it
   * raw during clone + first install; receives progress via
   * `installing-preload.cjs`. Not used in dev.
   */
  installingPath?: string;
  /**
   * Absolute path to optional `updating.html`. Shown by the plugin-update
   * supervisor during an in-app update. Shares the `installing-preload.cjs`
   * API surface with `installing.html`.
   */
  updatingPath?: string;
  plugins: ResolvedPlugin[];
  /**
   * Absolute paths of every JSONC manifest the loader consulted. Includes
   * paths whose file is currently missing (those still hot-watch for
   * creation events). Index 0 is the tracked manifest.
   */
  manifestPaths: string[];
  /** Resolved build config; defaults filled in even when user omits. */
  build: ResolvedBuildConfig;
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";

type LoaderContext = {
  hot?: {
    watch?: (url: URL) => void;
    invalidate?: () => void;
  };
};

type LoaderResult = {
  format: "module";
  source: string;
  shortCircuit: true;
};

type NextResolve = (specifier: string, context: LoaderContext) => unknown;

type NextLoad = (url: string, context: LoaderContext) => unknown;

type TracePort = {
  on: (event: "message", handler: (message: unknown) => void) => void;
  postMessage: (message: unknown) => void;
  unref?: () => void;
};

type InitializeData = {
  tracePort?: TracePort;
  payload?: RegistryPayload;
  pluginSourceFiles?: string[];
};

const verbose = process.env.ZENBU_VERBOSE === "1";
const nativeTsLoader = process.env.ZENBU_NATIVE_TS_LOADER !== "0";

const loaderName = "zenbu-loader";
let tracePort: TracePort | null = null;
const stats = {
  resolveCount: 0,
  resolveMs: 0,
  loadCount: 0,
  loadMs: 0,
};

let resolvedPayload: RegistryPayload | null = null;
let resolvedPluginSourceFiles: string[] = [];
/**
 * Set of absolute service file paths derived from the resolved payload.
 * Used by the `file://` branch in `load()` to decide which user files
 * should have `runtime.register(...)` auto-injected. Refreshed alongside
 * `resolvedPayload` whenever the loader picks up a new config snapshot.
 */
let serviceFileSet: Set<string> = new Set();
let pluginDirSet: Set<string> = new Set();
/**
 * Number of times we've materialized the plugin root since boot.
 */
let pluginsRootInvocations = 0;

export function initialize(data?: InitializeData): void {
  if (data?.payload) {
    resolvedPayload = data.payload;
    resolvedPluginSourceFiles = data.pluginSourceFiles ?? [];
    serviceFileSet = collectServiceFiles(data.payload);
    pluginDirSet = new Set(data.payload.plugins.map((p) => p.dir));
  }
  if (data?.tracePort) {
    tracePort = data.tracePort;
    tracePort.on("message", (msg) => {
      if (msg !== "flush") return;
      try {
        tracePort?.postMessage({ name: loaderName, ...stats });
      } catch {}
      stats.resolveCount = 0;
      stats.resolveMs = 0;
      stats.loadCount = 0;
      stats.loadMs = 0;
    });
    tracePort.unref?.();
  }
}

// =============================================================================
//                              shared utilities
// =============================================================================

function globRegex(filePattern: string): RegExp {
  return new RegExp(
    `^${filePattern.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`,
  );
}

function expandGlob(pattern: string): string[] {
  const dir = path.dirname(pattern);
  const regex = globRegex(path.basename(pattern));
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => regex.test(file))
    .map((file) => path.resolve(dir, file));
}

function buildSource(imports: string[]): string {
  return imports
    .map((specifier) => `import ${JSON.stringify(specifier)}\n`)
    .join("");
}

/**
 * Matches the canonical service declaration shape after the upstream HMR
 * loader (dynohot) has transformed the module. Dynohot strips the
 * `export` keyword and minifies the source, so the regex must not
 * require `export` and must tolerate a non-whitespace separator (e.g.
 * `;class Foo extends Service.create(...)`). The `\b` boundary still
 * rejects `subclass Foo` matches inside identifiers/comments.
 *
 *     export class FooService extends Service.create({ ... }) { ... }
 *     ;class FooService extends Service.create({...}) {...}        // post-dynohot
 *
 * `zen link` runs on the original on-disk source (pre-dynohot), so it
 * keeps the `export` requirement in `discoverServices` to avoid matching
 * non-exported helper classes.
 */
const SERVICE_CLASS_RE = /\bclass\s+(\w+)\s+extends\s+Service\.create\s*\(/g;

/**
 * Decode the loader's `source` payload (which Node permits as string,
 * Buffer, ArrayBuffer, or any TypedArray) into a plain UTF-8 string.
 */
function decodeSource(source: unknown): string {
  if (typeof source === "string") return source;
  if (source instanceof Uint8Array) return Buffer.from(source).toString("utf8");
  if (source instanceof ArrayBuffer)
    return Buffer.from(source).toString("utf8");
  return String(source);
}

/**
 * Tail-append a `runtime.register(<Class>, import.meta)` call to the
 * loader result so user service files don't have to carry the boilerplate.
 *
 * - Idempotent: if the source already contains `runtime.register(`
 *   (manual migration leftover, or a user choosing to register
 *   explicitly), we leave it untouched.
 * - Errors loudly when zero or multiple service classes are found, since
 *   the runtime's HMR model is "one slot per import.meta".
 * - The runtime singleton imported here resolves through the loader's
 *   own `@zenbujs/core` short-circuit in `resolve()`, so the registered
 *   class lands in the same registry the rest of the framework reads.
 */
function appendAutoRegister(downstream: unknown, filePath: string): unknown {
  if (!downstream || typeof downstream !== "object") return downstream;
  const result = downstream as {
    format?: string;
    source?: unknown;
    shortCircuit?: boolean;
  };
  if (result.format !== "module") return downstream;
  if (result.source == null) return downstream;

  const source = decodeSource(result.source);

  if (/\bruntime\s*\.\s*register\s*\(/.test(source)) {
    return { ...result, source };
  }

  SERVICE_CLASS_RE.lastIndex = 0;
  const matches = [...source.matchAll(SERVICE_CLASS_RE)];
  if (matches.length === 0) {
    // Files are allowed to be in an invalid state, throwing would crash dynohots loader chain
    return { ...result, source };
  }
  if (matches.length > 1) {
    const names = matches.map((m) => m[1]).join(", ");
    throw new Error(
      `[zenbu-loader] auto-register: ${matches.length} service classes (${names}) in ${filePath}.\n` +
        `         The HMR model is one service per file; split into separate files.`,
    );
  }

  const className = matches[0]![1]!;
  const tail =
    `\n;import { runtime as __zenbu_runtime__ } from "@zenbujs/core/runtime";` +
    `\n__zenbu_runtime__.register(${className}, import.meta);\n`;

  return { ...result, source: source + tail };
}

/**
 * Expand each plugin's `services` glob list into a flat set of absolute
 * file paths. Consulted by the `file://` branch in `load()` to decide
 * whether to auto-inject `runtime.register(...)` for the loaded module.
 *
 * Glob expansion uses the same `expandGlob` (and therefore the same
 * `fs.readdirSync` snapshot) that `buildPluginBarrel` uses, so the set
 * stays in lockstep with what the barrel actually imports.
 */
function collectServiceFiles(payload: RegistryPayload): Set<string> {
  const set = new Set<string>();
  for (const plugin of payload.plugins) {
    for (const entry of plugin.services) {
      const resolved = path.isAbsolute(entry)
        ? entry
        : path.resolve(plugin.dir, entry);
      if (resolved.includes("*")) {
        for (const f of expandGlob(resolved)) set.add(f);
      } else {
        set.add(resolved);
      }
    }
  }
  return set;
}

function isInsidePluginDir(filePath: string): boolean {
  const normalized = path.resolve(filePath);
  for (const dir of pluginDirSet) {
    const root = path.resolve(dir);
    if (normalized === root || normalized.startsWith(root + path.sep)) {
      return true;
    }
  }
  return false;
}

function loadNativeStrippedTs(filePath: string): LoaderResult {
  const source = fs.readFileSync(filePath, "utf8");
  const code = stripTypeScriptTypes(source, {
    mode: "transform",
    sourceMap: false,
  } as any);
  return {
    format: "module",
    source: code,
    shortCircuit: true,
  };
}

// =============================================================================
//                         config-driven barrel generation
// =============================================================================

interface ResolvedPluginRecord {
  name: string;
  dir: string;
  services: string[];
  schemaPath?: string;
  migrationsPath?: string;
  preloadPath?: string;
  eventsPath?: string;
  icons?: Record<string, string>;
  args?: unknown;
}

interface RegistryPayload {
  plugins: ResolvedPluginRecord[];
  appEntrypoint: string;
  splashPath?: string;
}

/**
 * Read the resolved config from the process global. setup-gate populates
 * this before registering our loader, so by the time `load()` is invoked
 * the snapshot is always present.
 *
 * We can't `await import("zenbu.config.ts")` from inside `load()` because
 * Node's ESM loader serializes load hooks — a dynamic import re-enters the
 * loader chain and deadlocks. Pre-resolving in setup-gate sidesteps that.
 */
function resolveConfigViaSubprocess(projectDir: string): {
  payload: RegistryPayload;
  pluginSourceFiles: string[];
} {
  // Locate the bundled resolver script. It sits next to this file in
  // `dist/cli/resolve-config.mjs` (peer of `dist/loaders/zenbu.mjs`).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "cli", "resolve-config.mjs"),
    path.resolve(here, "..", "..", "dist", "cli", "resolve-config.mjs"),
  ];
  const resolverScript = candidates.find((c) => fs.existsSync(c));
  if (!resolverScript) {
    throw new Error(
      `[zenbu-loader] resolve-config.mjs not found (looked in: ${candidates.join(
        ", ",
      )})`,
    );
  }
  /**
   * this takes ~100ms and can be heavily optimized, but its a fine solution for now
   */
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  const out = execFileSync(process.execPath, [resolverScript, projectDir], {
    encoding: "utf8",
    timeout: 1000,
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(out) as {
    payload: RegistryPayload;
    pluginSourceFiles: string[];
  };
}

function getResolvedConfig(configPath: string): {
  payload: RegistryPayload;
  pluginSourceFiles: string[];
} {
  // First call: use the payload sent through `register()`'s `data` channel
  // by setup-gate. Cheap, no subprocess.
  if (pluginsRootInvocations === 0) {
    pluginsRootInvocations += 1;
    if (!resolvedPayload) {
      throw new Error(
        "[zenbu-loader] zenbu config not resolved before loader registration. " +
          "setup-gate must pass it via register(specifier, { data: { payload, pluginSourceFiles } }).",
      );
    }
    return {
      payload: resolvedPayload,
      pluginSourceFiles: resolvedPluginSourceFiles,
    };
  }
  // Subsequent calls (dynohot invalidation): re-evaluate the user's
  // zenbu.config.ts from disk by shelling out to `resolve-config.mjs`. This
  // is what makes adding/removing plugins or changing service globs in
  // zenbu.config.ts hot-reload — without re-reading the file, the loader
  // would just keep emitting the same stale barrel forever.
  pluginsRootInvocations += 1;
  const projectDir = path.dirname(configPath);
  const fresh = resolveConfigViaSubprocess(projectDir);
  resolvedPayload = fresh.payload;
  resolvedPluginSourceFiles = fresh.pluginSourceFiles;
  serviceFileSet = collectServiceFiles(fresh.payload);
  pluginDirSet = new Set(fresh.payload.plugins.map((p) => p.dir));
  return fresh;
}

/**
 * Generate the top-level plugins barrel. The first import is the registry
 * setup module; ESM evaluates left-to-right in import order, so by the time
 * the plugin barrels start importing service files, `replacePlugins(...)` and
 * `registerAppEntrypoint(...)` have already populated the runtime registry.
 */
function buildPluginsRoot(payload: RegistryPayload): {
  source: string;
  barrelUrls: string[];
} {
  const registryUrl = `zenbu:registry?data=${encodeURIComponent(
    JSON.stringify(payload),
  )}`;
  const barrelUrls = payload.plugins.map(
    (p) => `zenbu:barrel?plugin=${encodeURIComponent(JSON.stringify(p))}`,
  );
  const imports = [registryUrl, ...barrelUrls];
  return {
    source: `${buildSource(imports)}import.meta.hot?.accept()\n`,
    barrelUrls,
  };
}

/**
 * Generate the registry-setup module body. Side-effect only — no exports.
 * Imported FIRST by the plugins root so its `replacePlugins` /
 * `registerAppEntrypoint` calls run before any plugin's service files
 * evaluate.
 */
function buildRegistryModule(payload: RegistryPayload): string {
  const lines = [
    'import { replacePlugins, registerAppEntrypoint } from "@zenbujs/core/runtime"',
    `replacePlugins(${JSON.stringify(payload.plugins)})`,
    `registerAppEntrypoint(${JSON.stringify(
      payload.appEntrypoint,
    )}, ${JSON.stringify(payload.splashPath)})`,
    "import.meta.hot?.accept()",
  ];
  return lines.join("\n") + "\n";
}

/**
 * Generate a per-plugin barrel: just service-file imports anchored at the
 * plugin's `dir`. Glob-form entries get expanded via `fs.readdirSync` and
 * glob directories are registered with `context.hot.watch()` so dynohot
 * reloads the generated barrel when service files are added/removed.
 */
function buildPluginBarrel(plugin: ResolvedPluginRecord): {
  source: string;
  watchPaths: Set<string>;
} {
  const imports: string[] = [];
  const watchPaths = new Set<string>([plugin.dir]);

  for (const entry of plugin.services) {
    const resolved = path.isAbsolute(entry)
      ? entry
      : path.resolve(plugin.dir, entry);
    if (resolved.includes("*")) {
      const dir = path.dirname(resolved);
      watchPaths.add(dir);
      for (const file of expandGlob(resolved)) {
        imports.push(pathToFileURL(file).href);
        serviceFileSet.add(file);
      }
    } else {
      imports.push(pathToFileURL(resolved).href);
      serviceFileSet.add(resolved);
    }
  }

  return {
    source: `${buildSource(imports)}import.meta.hot?.accept()\n`,
    watchPaths,
  };
}

// =============================================================================
//                        @zenbujs/core resolution helper
// =============================================================================

/**
 * Canonical path for `@zenbujs/core` and its subpaths, computed from the
 * loader's own URL. The loader file itself lives inside `@zenbujs/core/dist/`,
 * so the package root is two directories up. We resolve subpaths through
 * that package's `exports` field manually, instead of going through Node's
 * usual node_modules walk-up — that walk would pick up a plugin-local
 * `@zenbujs/core` (devDep) before reaching the real one. Rewriting in the
 * loader keeps `runtime.register` and the `Service` class identity unique
 * across every plugin's main-process code.
 */
type ExportEntry =
  | string
  | { import?: string; default?: string; types?: string };
type ExportsField = Record<string, ExportEntry>;

const CORE_PACKAGE_ROOT_FOR_LOADER = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = path.resolve(here, "..", "..");
  while (dir !== path.dirname(dir)) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkg, "utf8"));
        if (parsed.name === "@zenbujs/core") return dir;
      } catch {}
    }
    dir = path.dirname(dir);
  }
  return path.resolve(here, "..", "..");
})();

let coreExportsCache: ExportsField | null = null;
function getCoreExports(): ExportsField | null {
  if (coreExportsCache) return coreExportsCache;
  try {
    const pkgPath = path.join(CORE_PACKAGE_ROOT_FOR_LOADER, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      name?: string;
      exports?: ExportsField;
    };
    if (pkg.name === "@zenbujs/core" && pkg.exports) {
      coreExportsCache = pkg.exports;
      return coreExportsCache;
    }
  } catch {}
  return null;
}

function resolveCoreSubpath(specifier: string): string | null {
  const exports = getCoreExports();
  if (!exports) return null;
  const sub =
    specifier === "@zenbujs/core"
      ? "."
      : "./" + specifier.slice("@zenbujs/core/".length);
  const entry = exports[sub];
  if (!entry) return null;
  const file =
    typeof entry === "string" ? entry : entry.import ?? entry.default ?? null;
  if (!file) return null;
  return path.resolve(CORE_PACKAGE_ROOT_FOR_LOADER, file);
}

// =============================================================================
//                                   hooks
// =============================================================================

export function resolve(
  specifier: string,
  context: LoaderContext,
  nextResolve: NextResolve,
): unknown {
  const start = Date.now();
  try {
    if (specifier === "@zenbu/advice/runtime") {
      return {
        url: new URL("../advice-runtime.mjs", import.meta.url).href,
        shortCircuit: true,
      };
    }
    if (
      specifier === "@zenbujs/core" ||
      specifier.startsWith("@zenbujs/core/")
    ) {
      const resolved = resolveCoreSubpath(specifier);
      if (resolved) {
        return {
          url: pathToFileURL(resolved).href,
          shortCircuit: true,
        };
      }
    }
    if (specifier.startsWith("zenbu:")) {
      return { url: specifier, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  } finally {
    stats.resolveCount++;
    stats.resolveMs += Date.now() - start;
  }
}

function loadImpl(
  url: string,
  context: LoaderContext,
  nextLoad: NextLoad,
): unknown {
  // ─── Top-level plugins root ───
  // Triggered once at boot from setup-gate. The resolved config has been
  // pre-loaded onto `globalThis` by setup-gate (we cannot `await import` here
  // — Node serializes load hooks and a dynamic import re-enters this same
  // hook, deadlocking).
  if (url.startsWith("zenbu:plugins?")) {
    const params = new URL(url).searchParams;
    const configPath = decodeURIComponent(params.get("config") ?? "");
    const { payload, pluginSourceFiles } = getResolvedConfig(configPath);
    const { source, barrelUrls } = buildPluginsRoot(payload);
    if (context.hot?.watch) {
      context.hot.watch(pathToFileURL(configPath));
      for (const file of pluginSourceFiles) {
        context.hot.watch(pathToFileURL(file));
      }
    }
    if (verbose) {
      console.log(
        `[zenbu-loader] generated plugin root for ${path.basename(
          configPath,
        )} (${payload.plugins.length} plugins, ${barrelUrls.length} barrels)`,
      );
    }
    return {
      format: "module",
      source,
      shortCircuit: true,
    } satisfies LoaderResult;
  }

  // ─── Registry-setup module (always imported first by the plugins root) ───
  if (url.startsWith("zenbu:registry?")) {
    const params = new URL(url).searchParams;
    const data = decodeURIComponent(params.get("data") ?? "");
    let payload: RegistryPayload;
    try {
      payload = JSON.parse(data);
    } catch (err) {
      throw new Error(
        `[zenbu-loader] bad registry payload: ${(err as Error).message}`,
      );
    }
    const source = buildRegistryModule(payload);
    if (verbose) {
      console.log(
        `[zenbu-loader] emitted registry module (${
          payload.plugins.length
        } plugins, entrypoint=${path.basename(payload.appEntrypoint)})`,
      );
    }
    return {
      format: "module",
      source,
      shortCircuit: true,
    } satisfies LoaderResult;
  }

  // ─── Auto-inject `runtime.register(<Class>, import.meta)` ───
  // For any user file the resolved config classified as a service, we
  // tail-append the registration call so the user's class declaration
  // alone is enough — no `runtime.register` import or `import.meta` leak
  // in the user-facing surface. We run AFTER `nextLoad` (tsx) so we
  // append to the already-stripped JS source, not the original TS.
  if (url.startsWith("file://")) {
    let filePath: string;
    try {
      filePath = fileURLToPath(url);
    } catch {
      filePath = "";
    }
    if (filePath) {
      const isServiceFile = serviceFileSet.has(filePath);
      // Deleted service file: dynohot may try to reload its previous URL before the barrel re-eval drops it. Short-circuit with an empty module so the read doesn't ENOENT.
      if (isServiceFile && !fs.existsSync(filePath)) {
        serviceFileSet.delete(filePath);
        return {
          format: "module",
          source: "export {}\n",
          shortCircuit: true,
        } satisfies LoaderResult;
      }

      // Fast path: most main-process app/plugin files are plain `.ts` with no
      // JSX and no tsconfig path aliases. Node 22's native TS stripper is much
      // cheaper than the full tsx loader. Set ZENBU_NATIVE_TS_LOADER=0 to
      // disable this path while debugging loader/source-map issues.
      if (
        nativeTsLoader &&
        filePath.endsWith(".ts") &&
        isInsidePluginDir(filePath) &&
        fs.existsSync(filePath)
      ) {
        const stripped = loadNativeStrippedTs(filePath);
        return isServiceFile ? appendAutoRegister(stripped, filePath) : stripped;
      }

      if (isServiceFile) {
        const downstream = nextLoad(url, context);
        if (
          downstream &&
          typeof (downstream as PromiseLike<unknown>).then === "function"
        ) {
          return Promise.resolve(downstream).then((r) =>
            appendAutoRegister(r, filePath),
          );
        }
        return appendAutoRegister(downstream, filePath);
      }
    }
  }

  // ─── Per-plugin barrel: imports the plugin's service files ───
  if (url.startsWith("zenbu:barrel?")) {
    const params = new URL(url).searchParams;
    const pluginRaw = decodeURIComponent(params.get("plugin") ?? "");
    let plugin: ResolvedPluginRecord;
    try {
      plugin = JSON.parse(pluginRaw);
    } catch (err) {
      throw new Error(
        `[zenbu-loader] bad plugin payload: ${(err as Error).message}`,
      );
    }
    const { source, watchPaths } = buildPluginBarrel(plugin);
    if (context.hot?.watch) {
      for (const watchPath of watchPaths) {
        context.hot.watch(pathToFileURL(watchPath));
      }
    }
    if (verbose) {
      console.log(
        `[zenbu-loader] generated barrel for plugin ${plugin.name} (${
          source.split("\n").filter(Boolean).length
        } imports, ${watchPaths.size} watches)`,
      );
    }

    return {
      format: "module",
      source,
      shortCircuit: true,
    } satisfies LoaderResult;
  }

  return nextLoad(url, context);
}

export function load(
  url: string,
  context: LoaderContext,
  nextLoad: NextLoad,
): unknown {
  const start = Date.now();
  try {
    return loadImpl(url, context, nextLoad);
  } finally {
    stats.loadCount++;
    stats.loadMs += Date.now() - start;
  }
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { zenbuAdvicePlugin } from "@zenbu/advice/vite";
import { getConfig, subscribeConfig } from "./runtime";
import {
  getAdvice,
  getAllTypes,
  getContentScripts,
  getAllContentScriptPaths,
  getComponentViews,
  getAllComponentViewPaths,
  getFunctionSources,
  getAllFunctionSourcePaths,
  type ViewAdviceEntry,
  type ComponentViewEntry,
  type FunctionSourceEntry,
} from "./services/advice-config";

/**
 * Per-renderer Vite plugins, auto-injected by `ReloaderService`. Wires
 * three things into every Zenbu view's `<head>`:
 *
 *   1. Inline theme tokens (first paint matches host theme).
 *   2. Inline static preludes (boot-trace, view-args, theme, shortcuts).
 *   3. Per-view advice prelude at `/@advice-prelude/<type>` — a virtual
 *      module generated from the maps in `advice-config.ts` (advice,
 *      content scripts, component views, function sources). Loaded as
 *      a normal `<script type="module">` so everything lands in the
 *      iframe's initial dependency graph and evaluates before
 *      `main.tsx`.
 */

const PRELUDE_PREFIX = "/@advice-prelude/";
const RESOLVED_PREFIX = "\0@advice-prelude/";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADVICE_RUNTIME_ENTRY = path.resolve(HERE, "advice-runtime.mjs");
const THEME_LISTENER_ENTRY = path.resolve(HERE, "prelude/theme-listener.mjs");
const SHORTCUT_BRIDGE_ENTRY = path.resolve(
  HERE,
  "prelude/shortcut-bridge.mjs",
);
const BOOT_TRACE_ENTRY = path.resolve(HERE, "prelude/boot-trace.mjs");
const VIEW_ARGS_ENTRY = path.resolve(HERE, "prelude/view-args.mjs");

const THEME_LISTENER_SPECIFIER = "@zenbu/core/prelude/theme-listener";
const SHORTCUT_BRIDGE_SPECIFIER = "@zenbu/core/prelude/shortcut-bridge";
const BOOT_TRACE_SPECIFIER = "@zenbu/core/prelude/boot-trace";

const CORE_PACKAGE_ROOT = path.resolve(HERE, "..");

export function zenbuFrameworkResolve(): Plugin {
  return {
    name: "zenbu-framework-resolve",
    enforce: "pre",
    config() {
      return {
        resolve: {
          dedupe: ["react", "react-dom", "@zenbujs/core"],
        },
        server: {
          fs: { allow: [CORE_PACKAGE_ROOT] },
        },
      };
    },
  };
}

function getTypeFromPath(urlPath: string): string | null {
  const m = urlPath.match(/^\/views\/([^/]+)\//);
  return m ? m[1]! : null;
}

/** Resolve view type from `/views/<type>/...` path or `?type=<name>` query. */
function resolveType(
  urlPath: string,
  originalUrl: string | undefined,
): string | null {
  const fromPath = getTypeFromPath(urlPath);
  if (fromPath) return fromPath;
  if (!originalUrl) return null;
  const queryIdx = originalUrl.indexOf("?");
  if (queryIdx < 0) return null;
  const params = new URLSearchParams(originalUrl.slice(queryIdx + 1));
  return params.get("type");
}

function parsePreludeId(id: string): { type: string } {
  const rest = id.slice(RESOLVED_PREFIX.length);
  const queryIdx = rest.indexOf("?");
  if (queryIdx < 0) return { type: rest };
  return { type: rest.slice(0, queryIdx) };
}

/* ---------- Static framework preludes (inlined into HTML) ---------- */

let cachedStaticPreludeBody: string | null = null;
function getStaticPreludeBody(): string {
  if (cachedStaticPreludeBody !== null) return cachedStaticPreludeBody;
  const entries = [
    { path: BOOT_TRACE_ENTRY, exportNames: ["installBootTraceRenderer"] },
    // View-args listener runs as early as possible so the parent's
    // first `zenbu:view-args` message (sent in response to our
    // `zenbu:view-ready` ping) is never dropped.
    { path: VIEW_ARGS_ENTRY, exportNames: ["installViewArgsListener"] },
    { path: THEME_LISTENER_ENTRY, exportNames: ["installThemeListener"] },
    { path: SHORTCUT_BRIDGE_ENTRY, exportNames: ["installShortcutBridge"] },
  ];
  const parts: string[] = [];
  for (const entry of entries) {
    let code: string;
    try {
      code = fs.readFileSync(entry.path, "utf8");
    } catch {
      return (cachedStaticPreludeBody = "");
    }
    code = code.replace(/\n\s*export\s*\{[^}]*\}\s*;?\s*$/m, "\n");
    parts.push(code);
  }
  cachedStaticPreludeBody = parts.join("\n");
  return cachedStaticPreludeBody;
}

function buildInlinePreludeScript(viewType: string): string | null {
  const body = getStaticPreludeBody();
  if (!body) return null;
  const safeType = JSON.stringify(viewType);
  return `${body}\ninstallBootTraceRenderer(${safeType});\ninstallViewArgsListener();\ninstallThemeListener();\ninstallShortcutBridge(${safeType});`;
}

/* ---------- Per-view advice prelude codegen ---------- */

/** `replace` / `advise` imports for every entry that applies to this view. */
function generateAdvicePreludeCode(
  entries: ViewAdviceEntry[],
  _viewType: string,
): string {
  const imports: string[] = [];
  const calls: string[] = [];
  if (entries.length > 0) {
    imports.push('import { replace, advise } from "@zenbu/advice/runtime"');
    entries.forEach((entry, i) => {
      const alias = `__r${i}`;
      imports.push(
        `import { ${entry.exportName} as ${alias} } from ${JSON.stringify(
          entry.modulePath,
        )}`,
      );
      if (entry.type === "replace") {
        calls.push(
          `replace(${JSON.stringify(entry.moduleId)}, ${JSON.stringify(
            entry.name,
          )}, ${alias})`,
        );
      } else {
        calls.push(
          `advise(${JSON.stringify(entry.moduleId)}, ${JSON.stringify(
            entry.name,
          )}, ${JSON.stringify(entry.type)}, ${alias})`,
        );
      }
    });
  }
  if (imports.length === 0 && calls.length === 0) return "";
  return imports.join("\n") + "\n" + calls.join("\n") + "\n";
}

/**
 * Imports every component-view source and pushes it into the renderer's
 * client registry. Emitted into every iframe (any iframe might render
 * a `<View type="x" rendering="component">`). Relies on
 * `dedupe: ["@zenbujs/core"]` so the registry mutated here is the same
 * module instance `<View>` reads from.
 */
function generateComponentViewPreludeCode(
  entries: ComponentViewEntry[],
): string {
  if (entries.length === 0) return "";
  const imports: string[] = [
    'import { registerViewComponent as __zb_registerViewComponent } from "@zenbujs/core/react"',
  ];
  const calls: string[] = [];
  entries.forEach((entry, i) => {
    const alias = `__cv${i}`;
    if (entry.exportName === "default") {
      imports.push(
        `import ${alias} from ${JSON.stringify(entry.modulePath)}`,
      );
    } else {
      imports.push(
        `import { ${entry.exportName} as ${alias} } from ${JSON.stringify(
          entry.modulePath,
        )}`,
      );
    }
    calls.push(
      `__zb_registerViewComponent(${JSON.stringify(entry.type)}, ${alias})`,
    );
  });
  return imports.join("\n") + "\n" + calls.join("\n") + "\n";
}

/** Same as component-view codegen but for the function registry. */
function generateFunctionSourcePreludeCode(
  entries: FunctionSourceEntry[],
): string {
  if (entries.length === 0) return "";
  const imports: string[] = [
    'import { registerFunction as __zb_registerFunction } from "@zenbujs/core/react"',
  ];
  const calls: string[] = [];
  entries.forEach((entry, i) => {
    const alias = `__fn${i}`;
    if (entry.exportName === "default") {
      imports.push(
        `import ${alias} from ${JSON.stringify(entry.modulePath)}`,
      );
    } else {
      imports.push(
        `import { ${entry.exportName} as ${alias} } from ${JSON.stringify(
          entry.modulePath,
        )}`,
      );
    }
    // `meta` is opaque JSON; JSON.stringify both validates serializability
    // and produces a literal we can inline directly.
    const metaLiteral =
      entry.meta === undefined ? "undefined" : JSON.stringify(entry.meta);
    calls.push(
      `__zb_registerFunction(${JSON.stringify(entry.name)}, ${alias}, ${metaLiteral})`,
    );
  });
  return imports.join("\n") + "\n" + calls.join("\n") + "\n";
}

/* ---------- Inline theme tokens ---------- */

const CSS_CUSTOM_PROPERTY_RE = /^--[a-zA-Z0-9_-]+$/;
const VIEW_BACKGROUND_TOKEN = "--zenbu-view-background";
const VIEW_FOREGROUND_TOKEN = "--zenbu-view-foreground";
const VIEW_COLOR_SCHEME_TOKEN = "--zenbu-view-color-scheme";

function isSafeCssValue(value: string): boolean {
  return !/[;{}<>]/.test(value);
}

function decodeThemeTokens(themeParam: string): Record<string, string> | null {
  try {
    const json = decodeURIComponent(escape(atob(themeParam)));
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return null;
    const tokens: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!CSS_CUSTOM_PROPERTY_RE.test(key)) continue;
      if (typeof value !== "string") continue;
      if (!isSafeCssValue(value)) continue;
      tokens[key] = value;
    }
    return tokens;
  } catch {
    return null;
  }
}

function buildThemeCss(tokens: Record<string, string>): string | null {
  const keys = Object.keys(tokens);
  if (keys.length === 0) return null;
  const root =
    ":root:root{" + keys.map((k) => `${k}:${tokens[k]}`).join(";") + "}";
  const background = `var(${VIEW_BACKGROUND_TOKEN}, var(--background, Canvas))`;
  const foreground = `var(${VIEW_FOREGROUND_TOKEN}, var(--foreground, CanvasText))`;
  const colorScheme = `var(${VIEW_COLOR_SCHEME_TOKEN}, normal)`;
  const page =
    `html,body{background:${background};color:${foreground};color-scheme:${colorScheme}}` +
    `body{margin:0}` +
    `#root{background:${background};color:${foreground}}`;
  return root + page;
}

function buildInlineThemeCss(themeParam: string | null): string | null {
  if (!themeParam) return null;
  const tokens = decodeThemeTokens(themeParam);
  return tokens ? buildThemeCss(tokens) : null;
}

function extractThemeParam(originalUrl: string | undefined): string | null {
  if (!originalUrl) return null;
  const queryIdx = originalUrl.indexOf("?");
  if (queryIdx < 0) return null;
  const params = new URLSearchParams(originalUrl.slice(queryIdx + 1));
  return params.get("theme");
}

export function resolveAdviceRuntime(): Plugin {
  return {
    name: "zenbu-resolve-advice-runtime",
    enforce: "pre",
    resolveId(source) {
      if (source === "@zenbu/advice/runtime") return ADVICE_RUNTIME_ENTRY;
      if (source === THEME_LISTENER_SPECIFIER) return THEME_LISTENER_ENTRY;
      if (source === SHORTCUT_BRIDGE_SPECIFIER) return SHORTCUT_BRIDGE_ENTRY;
      if (source === BOOT_TRACE_SPECIFIER) return BOOT_TRACE_ENTRY;
      return null;
    },
  };
}

/* ---------- Per-iframe prelude plugin ---------- */

/**
 * Virtual prelude module at `/@advice-prelude/<type>`. Body is generated
 * on demand from the maps in `advice-config.ts`. Registration changes
 * call `emitReload(view)` → invalidate the module + ping the iframe via
 * `core.advice.reload` so it `location.reload()`s with a fresh prelude.
 */
export function advicePreludePlugin(): Plugin {
  return {
    name: "zenbu-advice-prelude",
    enforce: "pre",

    resolveId(source) {
      if (source.startsWith(PRELUDE_PREFIX)) {
        return RESOLVED_PREFIX + source.slice(PRELUDE_PREFIX.length);
      }
      return null;
    },

    load(id) {
      if (!id.startsWith(RESOLVED_PREFIX)) return null;
      const { type } = parsePreludeId(id);
      let code = generateAdvicePreludeCode(getAdvice(type), type);
      for (const scriptPath of getContentScripts(type)) {
        code += `import ${JSON.stringify(scriptPath)}\n`;
      }
      // Component views + functions are global — every iframe gets both.
      code += generateComponentViewPreludeCode(getComponentViews());
      code += generateFunctionSourcePreludeCode(getFunctionSources());
      return code || "// empty: static preludes are inlined in HTML\n";
    },

    handleHotUpdate({ file, server }) {
      let matched = false;
      for (const type of getAllTypes()) {
        for (const entry of getAdvice(type)) {
          if (file === entry.modulePath) {
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
      // Editing any of these source files needs a full reload — the
      // registration is a side effect of the prelude script, which
      // only runs at iframe boot.
      if (!matched) matched = getAllContentScriptPaths().includes(file);
      if (!matched) matched = getAllComponentViewPaths().includes(file);
      if (!matched) matched = getAllFunctionSourcePaths().includes(file);
      if (matched) {
        server.ws.send({ type: "full-reload" });
        return [];
      }
      return undefined;
    },

    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith(PRELUDE_PREFIX)) return next();
        try {
          const result = await server.transformRequest(url);
          if (result) {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/javascript");
            res.setHeader("Cache-Control", "no-cache");
            res.end(result.code);
            return;
          }
        } catch (e) {
          console.error("[advice-prelude] transform error:", e);
        }
        next();
      });
    },

    transformIndexHtml(html, ctx) {
      const type = resolveType(ctx.path ?? "", ctx.originalUrl);
      if (!type) return html;

      const tags: Array<{
        tag: string;
        attrs?: Record<string, string>;
        children?: string;
        injectTo: "head" | "head-prepend" | "body" | "body-prepend";
      }> = [];

      // 1. Inline theme tokens — first paint matches host theme.
      const themeCss = buildInlineThemeCss(extractThemeParam(ctx.originalUrl));
      if (themeCss) {
        tags.push({
          tag: "style",
          attrs: { id: "zenbu-view-theme" },
          children: themeCss,
          injectTo: "head-prepend",
        });
      }

      // 2. Static framework preludes (boot-trace, view-args, theme,
      //    shortcuts) inlined as one sync `<script>` block.
      const inlinePrelude = buildInlinePreludeScript(type);
      if (inlinePrelude) {
        tags.push({
          tag: "script",
          children: inlinePrelude,
          injectTo: "head",
        });
      } else {
        // Fallback: dist files missing (shouldn't happen in dev once
        // `pnpm build` has run once). Fall back to the legacy module-
        // script path so the listeners still install, just slower.
        tags.push({
          tag: "script",
          attrs: { type: "module", src: `${PRELUDE_PREFIX}${type}` },
          injectTo: "head",
        });
      }

      // 3. Per-view advice prelude. Always injected so future
      //    registrations can invalidate + reload via the same URL.
      tags.push({
        tag: "script",
        attrs: { type: "module", src: `${PRELUDE_PREFIX}${type}` },
        injectTo: "head",
      });

      return { html, tags };
    },
  };
}

/** Scoped wrapper around `@zenbu/advice/vite`'s babel transform. */
export function zenbuAdviceTransform(): Plugin {
  let inner: any = null;
  return {
    name: "zenbu-advice-scoped",
    enforce: "pre",
    configResolved(config) {
      const escaped = config.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      inner = zenbuAdvicePlugin({
        root: config.root,
        include: new RegExp(`^${escaped}.*\\.[jt]sx?$`),
      });
      const hook = (inner as any)?.configResolved;
      if (typeof hook === "function") {
        hook.call(this, config);
      }
    },
    transform(code, id) {
      const hook = (inner as any)?.transform;
      if (typeof hook !== "function") return null;
      return hook.call(this, code, id);
    },
  };
}

export function zenbuVitePlugins(): Plugin[] {
  return [
    zenbuFrameworkResolve(),
    advicePreludePlugin(),
    resolveAdviceRuntime(),
    zenbuAdviceTransform(),
    pluginSourcesCssPlugin(),
    bootReloadGuardPlugin(),
  ];
}

/**
 * Drop Vite's cold-boot `full-reload` ws message when no HMR client is
 * connected yet. The optimizer's first commit races Electron's
 * `loadURL`; the ws message is only useful to clients with already-
 * fetched bundle URLs, and `moduleGraph.invalidateAll()` already ran
 * server-side. Gating on `clients.size === 0` keeps later edits
 * working normally.
 */
function bootReloadGuardPlugin(): Plugin {
  return {
    name: "zenbu-boot-reload-guard",
    configureServer(server) {
      const ws = server.ws as unknown as {
        send: (...args: unknown[]) => void;
        clients?: { size: number };
        __zenbuBootReloadGuard?: boolean;
      };
      if (ws.__zenbuBootReloadGuard) return; // idempotent across HMR
      ws.__zenbuBootReloadGuard = true;
      const orig = ws.send.bind(ws);
      ws.send = ((...args: unknown[]) => {
        const p = args[0];
        const isFullReload =
          p &&
          typeof p === "object" &&
          (p as { type?: string }).type === "full-reload";
        if (isFullReload && (ws.clients?.size ?? 0) === 0) {
          // No client connected → no stale URLs to invalidate.
          return undefined as unknown as void;
        }
        return orig(...args);
      }) as typeof ws.send;
    },
  };
}

/* ---------- Tailwind @source registry for component-mode plugins ----
 *
 * Backs `@import "@zenbujs/core/plugin-sources.css"`. Writes a list of
 * Tailwind v4 `@source` directives — one per registered plugin's
 * `src/**` tree — to a per-host sidecar file under `node_modules/.zenbu/`.
 * Aliased via vite `resolve.alias` so each worktree gets its own file
 * (sharing one in core's dist caused cross-worktree HMR reloads).
 */

const PLUGIN_SOURCES_EXTS = "{ts,tsx,js,jsx,mts,mjs,cjs}";

const PLUGIN_SOURCES_SPECIFIER = "@zenbujs/core/plugin-sources.css";

function pluginSourcesPathFor(root: string): string {
  return path.resolve(root, "node_modules/.zenbu/plugin-sources.css");
}

function buildPluginSourcesCss(): string {
  const { plugins } = getConfig();
  const lines: string[] = [
    "/* @zenbujs/core: auto-generated @source list for plugin views.",
    " * Do not edit — rewritten by `pluginSourcesCssPlugin` whenever",
    " * the plugin registry changes. */",
  ];
  for (const plugin of plugins) {
    const dir = plugin.dir.replace(/\\/g, "/");
    lines.push(`@source "${dir}/src/**/*.${PLUGIN_SOURCES_EXTS}";`);
  }
  return lines.join("\n") + "\n";
}

function writePluginSourcesFile(file: string): boolean {
  const next = buildPluginSourcesCss();
  let prev: string | null = null;
  try {
    prev = fs.readFileSync(file, "utf8");
  } catch {
    // File doesn't exist yet — first write of the process.
  }
  if (prev === next) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next, "utf8");
    return true;
  } catch (err) {
    console.warn(
      "[zenbu] failed to write plugin-sources.css:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

export function pluginSourcesCssPlugin(): Plugin {
  let unsubscribe: (() => void) | null = null;
  let sourcesFile: string = pluginSourcesPathFor(process.cwd());

  return {
    name: "zenbu-plugin-sources-css",
    enforce: "pre",

    config(userConfig) {
      const root = path.resolve(userConfig.root ?? process.cwd());
      sourcesFile = pluginSourcesPathFor(root);
      writePluginSourcesFile(sourcesFile);
      return {
        resolve: {
          alias: [
            { find: PLUGIN_SOURCES_SPECIFIER, replacement: sourcesFile },
          ],
        },
      };
    },

    configResolved(resolved) {
      const canonical = pluginSourcesPathFor(resolved.root);
      if (canonical !== sourcesFile) {
        sourcesFile = canonical;
        writePluginSourcesFile(sourcesFile);
      }
    },

    configureServer(server) {
      unsubscribe?.();
      let primed = false;
      unsubscribe = subscribeConfig(() => {
        const changed = writePluginSourcesFile(sourcesFile);
        if (!primed) {
          primed = true;
          return;
        }
        if (changed) server.ws.send({ type: "full-reload" });
      });
    },

    buildStart() {
      writePluginSourcesFile(sourcesFile);
    },

    closeBundle() {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

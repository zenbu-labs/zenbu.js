import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { zenbuAdvicePlugin } from "@zenbu/advice/vite";
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
 * Renderer-side Vite plugins that wire advice + content scripts into every
 * Zenbu view. The framework auto-injects these from `ReloaderService`; users
 * should not need to import them in their own `vite.config.ts`.
 */

const PRELUDE_PREFIX = "/@advice-prelude/";
const RESOLVED_PREFIX = "\0@advice-prelude/";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADVICE_RUNTIME_ENTRY = path.resolve(HERE, "advice-runtime.mjs");
const THEME_LISTENER_ENTRY = path.resolve(
  HERE,
  "prelude/theme-listener.mjs",
);
const SHORTCUT_BRIDGE_ENTRY = path.resolve(
  HERE,
  "prelude/shortcut-bridge.mjs",
);
const BOOT_TRACE_ENTRY = path.resolve(HERE, "prelude/boot-trace.mjs");
const VIEW_ARGS_ENTRY = path.resolve(HERE, "prelude/view-args.mjs");

/**
 * Virtual import specifiers used by the generated prelude module to pull
 * in the framework's per-iframe runtime helpers. Resolved by
 * `resolveAdviceRuntime` (and the analogous resolver below) to absolute
 * paths in core's `dist/`.
 */
const THEME_LISTENER_SPECIFIER = "@zenbu/core/prelude/theme-listener";
const SHORTCUT_BRIDGE_SPECIFIER = "@zenbu/core/prelude/shortcut-bridge";
const BOOT_TRACE_SPECIFIER = "@zenbu/core/prelude/boot-trace";

/**
 * The package directory of `@zenbujs/core` itself. We expose it on the dev
 * server's `server.fs.allow` so requests for files inside core (the bundled
 * advice runtime, vite plugin, etc.) aren't blocked by Vite's workspace
 * restriction when the host happens to live in a different workspace.
 */
const CORE_PACKAGE_ROOT = path.resolve(HERE, "..");

/**
 * Vite plugin that enforces the framework's "single React, single core"
 * invariant for every renderer iframe.
 *
 * Mechanism: `resolve.dedupe`. Vite's dedupe re-roots resolution for the
 * listed packages at the project's root `node_modules`, so a plugin's
 * `import "react"` in `plugins/<name>/src/...` doesn't walk up into its own
 * `node_modules/react` (where a peer-dep / dev-dep install would otherwise
 * land). All importers — host renderer source, plugin content scripts,
 * advice modules — collapse onto the host's single React instance.
 *
 * `@zenbujs/core` is also deduped, but in practice the symlinks created by
 * `pnpm link:` already collapse it: the host's
 * `node_modules/@zenbujs/core` and each plugin's
 * `node_modules/@zenbujs/core` resolve to the same real path on disk.
 * Adding it to `dedupe` is a belt-and-suspenders guarantee for non-pnpm
 * installs.
 *
 * Why dedupe and not absolute-path rewriting: the host's
 * `node_modules/<package>` is *inside* Vite's workspace, so files served
 * from there go through Vite's normal `/node_modules/.vite/deps/` pipeline.
 * Rewriting to a path outside the workspace forces `/@fs/...` URLs that
 * trip the workspace fs guard even with `fs.strict: false`.
 *
 * `fs.allow: [CORE_PACKAGE_ROOT]` is still added because the framework
 * itself ships a few files (e.g. `@zenbu/advice/runtime` re-exported from
 * core's dist) that the prelude pulls in directly via `/@fs/...`.
 */
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

/**
 * Resolve the view type for a request. The kernel passes `?type=<name>`
 * in the iframe URL when opening a view (see `WindowService.openView`); we
 * also support `/views/<type>/...` paths for plugins that register their
 * own multi-page Vite layouts.
 */
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

/**
 * Read + concat the static framework preludes (boot-trace, theme-listener,
 * shortcut-bridge) so they can be inlined into the iframe's `<head>` as a
 * single sync `<script>` block. Cached on first read.
 *
 * Inlining saves 3-4 separate Vite requests per iframe boot. On cold dev
 * runs those requests cost ~200-500ms each because Vite has to walk the
 * file through advice / react / tailwind transforms before serving —
 * shifting them out of the iframe's critical path reclaims most of the
 * 700-900ms gap we measured between `did-start-loading` and
 * `renderer:prelude-start`.
 */
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
      // Built dist files missing — the inline path is best-effort; fall
      // back by signaling "empty" and let the upstream code add normal
      // <script src> tags as a fallback (see callers).
      return (cachedStaticPreludeBody = "");
    }
    // Strip the trailing `export { ... }` line. The bundled file is the
    // tsdown ESM output — always one line of named exports at the end.
    code = code.replace(/\n\s*export\s*\{[^}]*\}\s*;?\s*$/m, "\n");
    parts.push(code);
  }
  cachedStaticPreludeBody = parts.join("\n");
  return cachedStaticPreludeBody;
}

/** Builds the inline `<script>` body that runs the static preludes for a view. */
function buildInlinePreludeScript(viewType: string): string | null {
  const body = getStaticPreludeBody();
  if (!body) return null;
  const safeType = JSON.stringify(viewType);
  return `${body}\ninstallBootTraceRenderer(${safeType});\ninstallViewArgsListener();\ninstallThemeListener();\ninstallShortcutBridge(${safeType});`;
}

/**
 * Generates the per-iframe prelude module. Always pulls in the host-theme
 * postMessage listener and the shortcut/focus bridge so plugin views
 * automatically follow the host's theme picker and participate in the
 * global keybinding system; advice / content-script imports come after.
 *
 * The bridge and listener live as real source modules under
 * `packages/core/src/prelude/`. They're bundled into core's `dist/` by
 * tsdown and resolved here through the virtual specifiers above.
 */
/**
 * The dynamic prelude module (advice + content scripts) for a view.
 * The static framework preludes are inlined separately via
 * `transformIndexHtml` so this generator only emits the per-view
 * dynamic bits. When a view has no advice and no content scripts the
 * caller skips this module entirely.
 */
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
 * Generate the prelude block that imports every registered component
 * view's source module and pushes the resulting component into the
 * iframe's `@zenbujs/core/react` client registry under the view's
 * `type`. This block is emitted into *every* iframe's prelude (not
 * scoped by `_viewType`) because any iframe might render a `<View
 * type="x">` whose `rendering` is `"component"`. Each iframe is a
 * separate JS realm, so it gets its own copy of the registry.
 *
 * `dedupe: ["@zenbujs/core"]` (set in `zenbuFrameworkResolve`) ensures
 * the registry mutated here is the *same module instance* the app's
 * `<View>` reads from — if dedupe ever drifts, registrations would
 * silently land on a different module copy than `<View>` queries.
 */
/**
 * Generate the prelude block that imports every registered function
 * source and pushes the resulting value into the iframe's
 * `@zenbujs/core/react` client function registry under the function's
 * `name`. Mirrors `generateComponentViewPreludeCode` exactly — same
 * global scope (emitted into every iframe), same dedupe assumption.
 */
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

/**
 * Decodes a `?theme=<base64>` query param into a CSS string that defines
 * the host's design tokens on `:root`. Returned as-is for inlining into
 * the iframe's `<head>` so the very first paint already has the host's
 * theme — no flash, no JS round-trip.
 */
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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
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
  const root = ":root:root{" + keys.map((k) => `${k}:${tokens[k]}`).join(";") + "}";
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

/**
 * Resolves the framework's virtual runtime specifiers to absolute paths
 * inside core's bundled `dist/`:
 *
 *  - `@zenbu/advice/runtime` — the advice runtime that plugins import to
 *    call `replace` / `advise`.
 *  - `@zenbu/core/prelude/theme-listener` — host-theme postMessage
 *    listener installed into every iframe.
 *  - `@zenbu/core/prelude/shortcut-bridge` — keydown / focus / bindings
 *    bridge installed into every iframe.
 *
 * Resolving them here means the generated prelude module can use clean
 * bare-specifier imports instead of inlining their source as strings.
 */
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

/**
 * Per-iframe prelude that registers all advice + content scripts for the
 * iframe's view type. The prelude is loaded via a `<script type="module">`
 * tag injected into the iframe's HTML; loading it before the app's own
 * entry lets advice register before the modules it patches evaluate.
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
      // Component-view registrations are global — every iframe's
      // prelude registers every component view so `<View type="x">`
      // (component mode) can be rendered from any iframe. The static
      // preludes are still inlined separately into the HTML.
      code += generateComponentViewPreludeCode(getComponentViews());
      // Same treatment for function-source registrations — every
      // iframe gets every registered function in its client registry.
      code += generateFunctionSourcePreludeCode(getFunctionSources());
      // When nothing applies to this view, emit an empty module.
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
      if (!matched) {
        matched = getAllContentScriptPaths().includes(file);
      }
      if (!matched) {
        // Component-view source files: editing the .tsx must reload
        // the iframe so the prelude re-imports the fresh module and
        // re-registers under the same `type`. Going through HMR
        // (instead of normal Vite HMR) is correct because the
        // registration is a side effect of the prelude script, which
        // only runs at iframe boot.
        matched = getAllComponentViewPaths().includes(file);
      }
      if (!matched) {
        // Same story for function-source registrations.
        matched = getAllFunctionSourcePaths().includes(file);
      }
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

      // 1. Synchronously inline the host's design tokens on `:root` so
      //    the iframe's first paint already matches the host theme.
      //    `head-prepend` puts the tag at the very start of <head>, so
      //    subsequent stylesheets / @theme blocks can reference these
      //    vars without depending on style-order timing.
      const themeCss = buildInlineThemeCss(extractThemeParam(ctx.originalUrl));
      if (themeCss) {
        tags.push({
          tag: "style",
          attrs: { id: "zenbu-view-theme" },
          children: themeCss,
          injectTo: "head-prepend",
        });
      }

      // 2. Inline the static framework preludes (boot-trace + theme
      //    listener + shortcut bridge) as a sync <script> block. This
      //    avoids 3 separate Vite requests — each of which carried
      //    200-500ms of cold-transform latency on first-paint — and
      //    means the renderer's first `boot-trace` mark lands in the
      //    earliest possible position on the timeline.
      const inlinePrelude = buildInlinePreludeScript(type);
      if (inlinePrelude) {
        tags.push({
          tag: "script",
          children: inlinePrelude,
          injectTo: "head",
        });
      } else {
        // Fallback: dist files missing (shouldn't happen in dev once
        // `pnpm build` has run once). Use the legacy module-script
        // path so the listeners still install, just slower.
        tags.push({
          tag: "script",
          attrs: { type: "module", src: `${PRELUDE_PREFIX}${type}` },
          injectTo: "head",
        });
      }

      // 3. The dynamic per-view prelude (advice + content scripts). The
      //    load() hook above returns an empty module for views with
      //    neither, but we still inject the tag so HMR can pick up newly
      //    registered advice without a navigation.
      tags.push({
        tag: "script",
        attrs: { type: "module", src: `${PRELUDE_PREFIX}${type}` },
        injectTo: "head",
      });

      return { html, tags };
    },
  };
}

/**
 * Wraps `@zenbu/advice/vite`'s babel transform so the include filter is
 * scoped to the renderer's resolved root. This keeps advice moduleIds
 * canonical (each renderer transforms its own files; cross-package imports
 * stay owned by whichever renderer originally loaded them).
 */
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

/**
 *   1. `zenbuFrameworkResolve` — `enforce: "pre"`, runs first so it gets
 *      `react` / `@zenbujs/core/*` *before* Vite's default resolver walks
 *      up and finds plugin-local copies.
 *   2. `advicePreludePlugin` — generates the per-iframe prelude module.
 *   3. `resolveAdviceRuntime` — points `@zenbu/advice/runtime` at core.
 *   4. `zenbuAdviceTransform` — babel transform wrapping top-level fns.
 */
export function zenbuVitePlugins(): Plugin[] {
  return [
    zenbuFrameworkResolve(),
    advicePreludePlugin(),
    resolveAdviceRuntime(),
    zenbuAdviceTransform(),
  ];
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _unused_crawlPreloadPluginDoc(): void {}
/**
 * (Disabled.) Walk the iframe entry's transitive import graph at
 * server start, then splice `<link rel="modulepreload">` tags into
 * every served index.html.
 *
 * Two reasons this didn't work as written:
 *   1. `transformRequest` on a .ts file returns a transform whose
 *      `importedModules` set in Vite's module graph includes the .html
 *      shells of sibling views and other non-module URLs that vite's
 *      import-analysis pass rejects. Walking the graph caused the
 *      crawl to call `transformRequest` on .html files which then
 *      throws "invalid JS syntax" from `vite:import-analysis`.
 *   2. Even with preload hints emitted, browser-side import
 *      evaluation is still serial — a child module's evaluator can't
 *      run until the parent's evaluator finishes. Preload populates
 *      the *fetch cache* but doesn't shorten the evaluation chain.
 *      On our app, evaluation — not fetching — is the dominant cost
 *      because of CSS and large optimizeDeps chunks.
 *
 * Keeping the comment here so the next person doesn't try the same
 * thing without filtering for module-graph URLs that are actually
 * JS/CSS, and without confirming that browser-side evaluation order
 * is the bottleneck (vs. fetch order).
 */

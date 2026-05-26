import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { zenbuAdvicePlugin } from "@zenbu/advice/vite";
import { runtime, getConfig, subscribeConfig } from "./runtime";
import {
  readBootstrapManifest,
  enqueueRegistrationsWrite,
} from "./services/advice-config";

/**
 * Renderer-side Vite plugins that wire the framework's per-renderer
 * extras into every Zenbu view. Auto-injected by `ReloaderService` —
 * users don't need to import these in their own `vite.config.ts`.
 *
 * What this wires up, per renderer:
 *
 *   1. Theme tokens inlined into `<head>` as a synchronous `<style>`
 *      so first paint matches the host theme.
 *   2. Static framework preludes (boot-trace, view-args listener,
 *      theme listener, shortcut bridge) inlined as a single sync
 *      `<script>` block.
 *   3. The reconciler bootstrap: an inline JSON manifest with this
 *      view type's advice + content-script registrations, plus a
 *      fixed `<script type="module" src="/@zenbu/bootstrap">` that
 *      reads the manifest, dynamic-imports each entry, applies it,
 *      and `await`s — blocking the app's own entry script until
 *      advice + content scripts are in place. Functions and
 *      component views are resolved post-mount by the live
 *      reconciler subscribed to `db.core.registrations`.
 *
 * The old per-view prelude codegen (`/@advice-prelude/<type>`) is
 * gone. All four kinds of plugin registration live in
 * `db.core.registrations` and flow through the reconciler.
 */

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

/**
 * Virtual module URL for the reconciler bootstrap. Resolved + loaded
 * by `reconcilerBootstrapPlugin` below. Always points at the same
 * fixed JS body; only the inline JSON manifest in the HTML changes.
 */
const BOOTSTRAP_URL = "/@zenbu/bootstrap";
const BOOTSTRAP_RESOLVED = "\0@zenbu/bootstrap";
const BOOTSTRAP_MANIFEST_ID = "zenbu-bootstrap-manifest";

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

/* ---------- Static framework preludes (inlined into HTML) ---------- */

let cachedStaticPreludeBody: string | null = null;
function getStaticPreludeBody(): string {
  if (cachedStaticPreludeBody !== null) return cachedStaticPreludeBody;
  const entries = [
    { path: BOOT_TRACE_ENTRY, exportNames: ["installBootTraceRenderer"] },
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

/* ---------- Reconciler bootstrap ---------- */

/**
 * The fixed bootstrap script the iframe loads via
 * `<script type="module" src="/@zenbu/bootstrap">`. It reads the
 * inline JSON manifest from `<script type="application/json"
 * id="zenbu-bootstrap-manifest">`, then for each entry:
 *
 *   - dynamic-imports `${modulePath}?rev=${rev}` (cache-busted),
 *   - applies it via the kind-specific applier in
 *     `@zenbujs/core/react`'s `__applyBootstrapRegistrations`,
 *   - stores the resulting cleanup so a later removal can undo it.
 *
 * Because this is a `<script type="module">` with a top-level
 * `await`, subsequent module scripts in the same document — notably
 * the app's main entry — wait for our `await` to settle. By the time
 * `main.tsx` runs, advice and content scripts that were in the
 * manifest at HTML-serve time are already in place.
 *
 * Functions and component views are NOT in the manifest. They're
 * picked up by the live reconciler after `ZenbuProvider` connects.
 */
const BOOTSTRAP_CODE = `import { __applyBootstrapRegistrations } from "@zenbujs/core/react"

const manifestEl = document.getElementById(${JSON.stringify(
  BOOTSTRAP_MANIFEST_ID,
)})
if (manifestEl && manifestEl.textContent) {
  try {
    const manifest = JSON.parse(manifestEl.textContent)
    await __applyBootstrapRegistrations(manifest)
  } catch (err) {
    console.error("[zenbu/bootstrap] failed:", err)
  }
}
`;

export function reconcilerBootstrapPlugin(): Plugin {
  return {
    name: "zenbu-reconciler-bootstrap",
    enforce: "pre",

    resolveId(source) {
      if (source === BOOTSTRAP_URL) return BOOTSTRAP_RESOLVED;
      return null;
    },

    load(id) {
      if (id === BOOTSTRAP_RESOLVED) return BOOTSTRAP_CODE;
      return null;
    },

    /**
     * Source-file change \u2192 bump `rev` on every matching row in
     * `db.core.registrations`. The reconciler treats a `rev` change
     * as "replace": cleanup the previous applied state, dynamic-
     * import the new `?rev=N` URL, run the applier again. No page
     * reload for any of the four kinds.
     */
    handleHotUpdate({ file, server }) {
      const dbSlot = runtime.getSlot("db")?.instance as
        | { client: { readRoot: () => any } }
        | undefined;
      if (!dbSlot) return undefined;
      const root = dbSlot.client.readRoot();
      const matches = root.core.registrations.some(
        (r: { modulePath: string }) => r.modulePath === file,
      );
      if (!matches) return undefined;

      void enqueueRegistrationsWrite((root: any) => {
        for (const reg of root.core.registrations) {
          if (reg.modulePath === file) {
            reg.rev = (reg.rev ?? 0) + 1;
          }
        }
      });
      try {
        const mod = server.moduleGraph.getModuleById(file);
        if (mod) server.moduleGraph.invalidateModule(mod);
      } catch {}
      return [];
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

      // 1. Inline theme tokens \u2014 first paint matches host theme.
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
      }

      // 3. The reconciler bootstrap. Inline manifest (advice + content
      //    scripts for this view type at HTML-serve time) plus the
      //    fixed bootstrap module that reads it and applies.
      const manifest = readBootstrapManifest(type);
      tags.push({
        tag: "script",
        attrs: { type: "application/json", id: BOOTSTRAP_MANIFEST_ID },
        children: JSON.stringify(manifest),
        injectTo: "head",
      });
      tags.push({
        tag: "script",
        attrs: { type: "module", src: BOOTSTRAP_URL },
        injectTo: "head",
      });

      return { html, tags };
    },
  };
}

/**
 * Wraps `@zenbu/advice/vite`'s babel transform so the include filter
 * is scoped to the renderer's resolved root. Keeps advice moduleIds
 * canonical (each renderer transforms its own files).
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

export function zenbuVitePlugins(): Plugin[] {
  return [
    zenbuFrameworkResolve(),
    reconcilerBootstrapPlugin(),
    resolveAdviceRuntime(),
    zenbuAdviceTransform(),
    pluginSourcesCssPlugin(),
  ];
}

/* ---------- Tailwind @source registry for component-mode plugins ---------- */

/**
 * Backs the host-side import:
 *
 *     @import "@zenbujs/core/plugin-sources.css";
 *
 * Resolves through `@zenbujs/core`'s `package.json#exports` to a real
 * file at `dist/plugin-sources.css`. The file's body is a list of
 * Tailwind v4 `@source` directives, one per registered plugin,
 * pointing at that plugin's `src/**` tree. The host's single Tailwind
 * compilation then scans every component-mode plugin's source tree
 * automatically, so utility classes used inside a plugin view land in
 * the host's stylesheet without any host-side bookkeeping.
 *
 * Why a real file instead of a virtual module or a transform-time
 * rewrite? Tailwind v4's vite integration resolves CSS `@import`s
 * through `vite.createIdResolver()`, a stripped-down node resolver
 * that does **not** run user plugin `resolveId` hooks and does **not**
 * see other plugins' `transform` results before its own compiler
 * walks the imports. So neither a virtual specifier nor a string
 * rewrite reliably wins the race — the resolver fires first and
 * errors on undeclared subpaths. An actual file with an actual
 * `exports` entry sidesteps the whole question.
 *
 * This plugin keeps that file's body in sync with the live plugin
 * registry. It writes once during `config()` (before vite serves the
 * first request), and again on every `subscribeConfig` callback.
 *
 * Without this, Tailwind v4 only auto-detects sources under the
 * closest ancestor `package.json` to the host CSS (typically
 * `plugins/app/`), which means any class used exclusively by a
 * sibling plugin silently no-ops unless the host happens to use it
 * too.
 */

/** File extensions a Tailwind scan should consider when walking a
 * plugin's source tree. JS/MJS/CJS are included for compiled
 * plugins loaded from `node_modules`. */
const PLUGIN_SOURCES_EXTS = "{ts,tsx,js,jsx,mts,mjs,cjs}";

/** Bare specifier used by the host stylesheet:
 *
 *     @import "@zenbujs/core/plugin-sources.css";
 *
 * We intercept it per-host via `resolve.alias` and redirect each
 * dev server's resolution to a file under that host's own
 * `node_modules/.zenbu/`. Previously this resolved through
 * `package.json#exports` to a single shared file in this package's
 * `dist/`, which meant every worktree pointing at the same
 * `@zenbujs/core` install wrote to (and watched) the same mutable
 * sidecar — touching the file in worktree A triggered an HMR full
 * reload in worktree B because B's vite/Tailwind had that exact
 * path in its CSS module graph. Per-host paths fully isolate
 * worktrees. */
const PLUGIN_SOURCES_SPECIFIER = "@zenbujs/core/plugin-sources.css";

/** Where to write the per-host sidecar. Lives under the consuming
 * project's `node_modules/.zenbu/` so it is gitignored, ephemeral,
 * and outside vite's default file watcher (we trigger reloads
 * explicitly via `server.ws.send`). */
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
    // Tailwind accepts absolute paths in `@source`; forward slashes
    // are the portable form on Windows.
    const dir = plugin.dir.replace(/\\/g, "/");
    lines.push(`@source "${dir}/src/**/*.${PLUGIN_SOURCES_EXTS}";`);
  }
  return lines.join("\n") + "\n";
}

/** Writes the current registry's `@source` list to the given
 * per-host path. Returns `true` when the file's content actually
 * changed (so callers can decide whether to bother triggering an
 * HMR full-reload). */
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
  // Resolved lazily from the host's vite root. Populated in
  // `config()` (early enough to be returned in the alias entry)
  // and refined in `configResolved()` if vite normalizes the root
  // differently than we guessed.
  let sourcesFile: string = pluginSourcesPathFor(process.cwd());

  return {
    name: "zenbu-plugin-sources-css",
    enforce: "pre",

    /**
     * Sync hook that runs before vite finishes resolving its config,
     * which itself runs before the first request is served. We:
     *
     *   1. Compute the per-host sidecar path from the user's vite
     *      root (falling back to `cwd`). One host → one file.
     *   2. Write it to disk so it exists by the time
     *      `@tailwindcss/vite` opens it.
     *   3. Install a `resolve.alias` that redirects the bare
     *      specifier `@zenbujs/core/plugin-sources.css` to that
     *      per-host path. Aliases are honored by
     *      `vite.createIdResolver`, which is what Tailwind uses to
     *      resolve CSS `@import`s — so this wins without needing a
     *      user `resolveId` hook.
     */
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

    /**
     * Vite may normalize `root` differently than we guessed in
     * `config()` (e.g. when the user passes a relative path). Rewrite
     * to the canonical path so the alias and the on-disk file agree.
     */
    configResolved(resolved) {
      const canonical = pluginSourcesPathFor(resolved.root);
      if (canonical !== sourcesFile) {
        sourcesFile = canonical;
        writePluginSourcesFile(sourcesFile);
      }
    },

    /**
     * Live-update path: when a plugin is registered or removed
     * (`zenbu.config.ts` / `zenbu.plugin.ts` edits), rewrite the
     * sidecar file and ping this server's clients so Tailwind
     * re-walks the new source list. We deliberately do not rely on
     * vite's chokidar to notice the write — the file lives under
     * `node_modules/`, which vite's default watcher ignores, and
     * that ignore is exactly what gives us cross-worktree
     * isolation. The manual `server.ws.send` is the only reload
     * signal.
     */
    configureServer(server) {
      unsubscribe?.();
      let primed = false;
      unsubscribe = subscribeConfig(() => {
        // Always rewrite the file — covers the race where `config()`
        // ran before any plugin had been registered. Writes are
        // content-compared and skipped when nothing changed, so this
        // is cheap.
        const changed = writePluginSourcesFile(sourcesFile);
        if (!primed) {
          // `subscribeConfig` fires once immediately on subscription;
          // don't full-reload on that initial fire.
          primed = true;
          return;
        }
        if (changed) server.ws.send({ type: "full-reload" });
      });
    },

    /**
     * Production builds run through the same plugin pipeline. Make
     * sure the file is up to date before rollup walks the CSS graph.
     */
    buildStart() {
      writePluginSourcesFile(sourcesFile);
    },

    closeBundle() {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

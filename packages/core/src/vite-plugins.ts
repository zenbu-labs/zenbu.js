import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";
import { zenbuAdvicePlugin } from "@zenbu/advice/vite";
import { getConfig, subscribeConfig } from "./runtime";
import {
  getInjections,
  getAllInjectionPaths,
  type InjectionEntry,
} from "./services/advice-config";

/**
 * Per-renderer Vite plugins. Wires three things into the host
 * renderer's `<head>`:
 *
 *   1. Inline theme tokens (first paint matches host theme).
 *   2. Inline static preludes (boot-trace, view-args, theme,
 *      shortcuts) — framework runtime bootstrap.
 *   3. The injection prelude at `/@injections-prelude` — a virtual
 *      module generated from the injection registry in
 *      `advice-config.ts`. Imports every registered module, then
 *      dispatches by `meta.kind`: advice entries land in
 *      `@zenbu/advice/runtime`, everything else in the in-memory
 *      injection registry that `useInjection` / `useInjections`
 *      read from.
 */

const PRELUDE_PREFIX = "/@injections-prelude";
const RESOLVED_PREFIX = "\0@injections-prelude";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADVICE_RUNTIME_ENTRY = path.resolve(HERE, "advice-runtime.mjs");
const BOOT_TRACE_ENTRY = path.resolve(HERE, "prelude/boot-trace.mjs");

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



/* ---------- Static framework preludes (inlined into HTML) ---------- */

let cachedStaticPreludeBody: string | null = null;
function getStaticPreludeBody(): string {
  if (cachedStaticPreludeBody !== null) return cachedStaticPreludeBody;
  try {
    const code = fs.readFileSync(BOOT_TRACE_ENTRY, "utf8");
    cachedStaticPreludeBody = code.replace(
      /\n\s*export\s*\{[^}]*\}\s*;?\s*$/m,
      "\n",
    );
  } catch {
    cachedStaticPreludeBody = "";
  }
  return cachedStaticPreludeBody;
}

function buildInlinePreludeScript(): string | null {
  const body = getStaticPreludeBody();
  if (!body) return null;
  // Boot-trace is the only inline prelude left in one-DOM mode.
  // Shortcut handling, view-args, and theme forwarding all moved
  // into the React tree (see `ShortcutDispatcher` in `react.ts`
  // and the `<View args=>` context in the same file).
  return `${body}\ninstallBootTraceRenderer();`;
}

/* ---------- Injection prelude codegen ---------- */

/**
 * Emit one import + one dispatch per injection. Advice entries
 * (kind === "advice") go through `@zenbu/advice/runtime`; everything
 * else lands in the in-renderer injection registry that `useInjection`
 * / `useInjections` subscribe to.
 */
function generateInjectionsPreludeCode(entries: InjectionEntry[]): string {
  if (entries.length === 0) return "";

  // An injection without `meta` is the old "content script" pattern:
  // import the module for its side effects (which is how userland
  // mounts hidden React roots etc.) but read no value back. Same for
  // `meta.kind: "bootstrap"`. We can't `import default from ...` for
  // those because the module typically has no default export — that
  // throws synchronously and crashes the whole prelude.
  const isBootstrap = (e: InjectionEntry): boolean =>
    e.meta === undefined || e.meta?.kind === "bootstrap";
  const isAdvice = (e: InjectionEntry): boolean =>
    e.meta?.kind === "advice";

  const hasAdvice = entries.some(isAdvice);
  const hasValue = entries.some(
    (e) => !isBootstrap(e) && !isAdvice(e),
  );

  const imports: string[] = [];
  if (hasAdvice) {
    imports.push('import { replace, advise } from "@zenbu/advice/runtime"');
  }
  if (hasValue) {
    imports.push(
      'import { registerInjection as __zb_registerInjection } from "@zenbujs/core/react"',
    );
  }

  const calls: string[] = [];
  entries.forEach((entry, i) => {
    // Side-effect-only injections — emit a bare `import` so the
    // module runs (its side effects, e.g. mounting a hidden React
    // root, do the actual work) without binding a default export
    // that might not exist.
    if (isBootstrap(entry)) {
      imports.push(`import ${JSON.stringify(entry.modulePath)}`);
      return;
    }

    const alias = `__i${i}`;
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

    if (isAdvice(entry)) {
      const wraps = entry.meta?.wraps as
        | { moduleId: string; name: string }
        | undefined;
      const adviceType = entry.meta?.adviceType as
        | "replace" | "before" | "after" | "around" | undefined;
      if (!wraps || !adviceType) {
        // Misconfigured advice meta — skip the dispatch but keep the
        // import so the side-effecting module still runs.
        return;
      }
      if (adviceType === "replace") {
        calls.push(
          `replace(${JSON.stringify(wraps.moduleId)}, ${JSON.stringify(
            wraps.name,
          )}, ${alias})`,
        );
      } else {
        calls.push(
          `advise(${JSON.stringify(wraps.moduleId)}, ${JSON.stringify(
            wraps.name,
          )}, ${JSON.stringify(adviceType)}, ${alias})`,
        );
      }
      return;
    }

    // Value injection. `meta` is opaque JSON; JSON.stringify both
    // validates serializability and produces a literal we can inline.
    const metaLiteral = JSON.stringify(entry.meta);
    calls.push(
      `__zb_registerInjection(${JSON.stringify(entry.name)}, ${alias}, ${metaLiteral})`,
    );
  });

  return imports.join("\n") + "\n" + calls.join("\n") + "\n";
}

export function resolveAdviceRuntime(): Plugin {
  return {
    name: "zenbu-resolve-advice-runtime",
    enforce: "pre",
    resolveId(source) {
      if (source === "@zenbu/advice/runtime") return ADVICE_RUNTIME_ENTRY;
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
    name: "zenbu-injections-prelude",
    enforce: "pre",

    resolveId(source) {
      if (source === PRELUDE_PREFIX || source.startsWith(PRELUDE_PREFIX + "?")) {
        return RESOLVED_PREFIX + source.slice(PRELUDE_PREFIX.length);
      }
      return null;
    },

    load(id) {
      if (!id.startsWith(RESOLVED_PREFIX)) return null;
      const code = generateInjectionsPreludeCode(getInjections());
      return code || "// empty: no injections registered yet\n";
    },

    handleHotUpdate({ file, server }) {
      // Any edit to an injection source module needs a full reload
      // — the registration is a side effect of the prelude script,
      // which only runs at boot.
      if (getAllInjectionPaths().includes(file)) {
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
          console.error("[injections-prelude] transform error:", e);
        }
        next();
      });
    },

    transformIndexHtml(html, ctx) {
     

      const tags: Array<{
        tag: string;
        attrs?: Record<string, string>;
        children?: string;
        injectTo: "head" | "head-prepend" | "body" | "body-prepend";
      }> = [];

      // The host renderer's own CSS owns `:root` (shadcn tokens,
      // etc.) and is loaded by `index.html` directly. No iframe
      // theme forwarding needed.

      // Boot-trace prelude inlined as one sync `<script>` block.
      const inlinePrelude = buildInlinePreludeScript();
      if (inlinePrelude) {
        tags.push({
          tag: "script",
          children: inlinePrelude,
          injectTo: "head",
        });
      } else {
        // Fallback: dist files missing (shouldn't happen in dev once
        // `pnpm build` has run once). Fall back to the virtual module
        // path so the listeners still install, just slower.
        tags.push({
          tag: "script",
          attrs: { type: "module", src: PRELUDE_PREFIX },
          injectTo: "head",
        });
      }

      // 3. The injection prelude. Imports every registered module
      //    before `main.tsx` runs, so by the time React mounts the
      //    in-memory injection registry is fully populated.
      tags.push({
        tag: "script",
        attrs: { type: "module", src: PRELUDE_PREFIX },
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

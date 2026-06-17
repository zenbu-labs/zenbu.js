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
  return `${body}\ninstallBootTraceRenderer();`;
}

/* ---------- Injection prelude codegen ----------
 * Generates the body of `@injections-prelude`. Registrations push disposers
 * onto `__zb_disposers` and the module self-accepts via HMR; on dispose the
 * previous round is unwound inside one `beginInjectionBatch()` so React
 * subscribers see a single notification with the final state.
 */
function generateInjectionsPreludeCode(entries: InjectionEntry[]): string {
  if (entries.length === 0) {
    // Empty → still emit the HMR boundary so N>0 → 0 can dispose.
    return "if (import.meta.hot) { import.meta.hot.accept() }\n";
  }

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
    imports.push(
      'import { replace, unreplace, advise } from "@zenbu/advice/runtime"',
    );
    // around-advice runs as its own React component (its own fiber)
    // so its hooks don't shift the advised component's hook indices.
    imports.push(
      'import { createElement as __zb_createElement, Component as __zb_Component } from "react"',
    );
  }
  const reactImports: string[] = [
    "  beginInjectionBatch as __zb_beginInjectionBatch,",
    "  endInjectionBatch as __zb_endInjectionBatch,",
    "  reportInjectionLoadFailure as __zb_reportInjectionLoadFailure,",
  ];
  if (hasValue) {
    reactImports.unshift("  registerInjection as __zb_registerInjection,");
  }
  imports.push(
    `import {\n${reactImports.join("\n")}\n} from "@zenbujs/core/react"`,
  );

  const setup: string[] = [
    "const __zb_prevDisposers = (import.meta.hot && import.meta.hot.data && import.meta.hot.data.__zb_disposers) || []",
    "const __zb_disposers = []",
    "__zb_beginInjectionBatch()",
    "for (const u of __zb_prevDisposers) { try { u() } catch {} }",
    // Per-entry isolation: one injection module throwing during
    // evaluation must not take the other N-1 down with it. Static
    // imports would fail the whole prelude (ES module semantics), so
    // each entry loads via its own dynamic import; allSettled keeps
    // processing in registration order. A failed entry is loudly
    // logged, recorded in the renderer's failure registry (so slots
    // can render an error state instead of an empty frame), and
    // forwarded to the dev server terminal.
    "function __zb_fail(name, modulePath, pluginDir, error) {",
    "  console.error(",
    "    '[zenbu] injection \\'' + name + '\\'' + (pluginDir ? ' (plugin at ' + pluginDir + ')' : '') + ' failed to load.',",
    "    'Everything its module registers is disabled until it loads cleanly. Module:', modulePath, 'Error:', error,",
    "  )",
    "  __zb_disposers.push(__zb_reportInjectionLoadFailure({ name, modulePath, pluginDir, error }))",
    "  if (import.meta.hot) {",
    "    try {",
    "      import.meta.hot.send('zenbu:injection-load-failure', {",
    "        name, modulePath, pluginDir: pluginDir ?? null,",
    "        error: String((error && error.stack) || error),",
    "      })",
    "    } catch {}",
    "  }",
    "}",
    "function __zb_take(i, name, modulePath, pluginDir) {",
    "  const r = __zb_results[i]",
    "  if (r.status === 'fulfilled') return r.value",
    "  __zb_fail(name, modulePath, pluginDir, r.reason)",
    "  return null",
    "}",
    "function __zb_export(mod, exportName, name, modulePath, pluginDir) {",
    "  if (mod == null) return null",
    "  const v = mod[exportName]",
    "  if (v === undefined) {",
    "    __zb_fail(name, modulePath, pluginDir, new Error('module evaluated but has no export named \"' + exportName + '\"'))",
    "    return null",
    "  }",
    "  return v",
    "}",
  ];
  const setupAliases: Array<{ alias: string; index: number }> = [];
  const calls: string[] = [];
  const moduleImports: string[] = [];
  let needsAroundWrapper = false;
  entries.forEach((entry, i) => {
    // Per-entry dynamic import (settled below): gives us `.setup` plus
    // `.default` / `.<named>` for the registered value off one alias,
    // or `null` when the module failed — every use is null-guarded.
    const ns = `__m${i}`;
    moduleImports.push(`  import(${JSON.stringify(entry.modulePath)}),`);
    const entryArgs = `${JSON.stringify(entry.name)}, ${JSON.stringify(
      entry.modulePath,
    )}, ${JSON.stringify(entry.pluginDir ?? null)}`;
    calls.push(`const ${ns} = __zb_take(${i}, ${entryArgs})`);
    setupAliases.push({ alias: ns, index: i });

    if (isBootstrap(entry)) return; // work lives in `setup`

    const valueVar = `__v${i}`;
    const valueExpr = `__zb_export(${ns}, ${JSON.stringify(
      entry.exportName,
    )}, ${entryArgs})`;

    if (isAdvice(entry)) {
      const wraps = entry.meta?.wraps as
        | { moduleId: string; name: string }
        | undefined;
      const adviceType = entry.meta?.adviceType as
        | "replace"
        | "before"
        | "after"
        | "around"
        | undefined;
      if (!wraps || !adviceType) return;
      const modIdLit = JSON.stringify(wraps.moduleId);
      const nameLit = JSON.stringify(wraps.name);
      calls.push(`const ${valueVar} = ${valueExpr}`);
      if (adviceType === "around") {
        needsAroundWrapper = true;
        calls.push(
          `if (${valueVar} != null) __zb_disposers.push(advise(${modIdLit}, ${nameLit}, "around", __zb_wrapAround(${valueVar})))`,
        );
      } else if (adviceType === "replace") {
        // `replace` doesn't return a disposer; synthesize one via
        // `unreplace`. Stack-shaped storage in @zenbu/advice would let
        // this match `advise()`'s shape — see follow-up.
        calls.push(
          `if (${valueVar} != null) { replace(${modIdLit}, ${nameLit}, ${valueVar}); __zb_disposers.push(() => unreplace(${modIdLit}, ${nameLit})) }`,
        );
      } else {
        calls.push(
          `if (${valueVar} != null) __zb_disposers.push(advise(${modIdLit}, ${nameLit}, ${JSON.stringify(adviceType)}, ${valueVar}))`,
        );
      }
      return;
    }

    const metaLiteral = JSON.stringify(entry.meta);
    calls.push(`const ${valueVar} = ${valueExpr}`);
    calls.push(
      `if (${valueVar} != null) __zb_disposers.push(__zb_registerInjection(${JSON.stringify(
        entry.name,
      )}, ${valueVar}, ${metaLiteral}))`,
    );
  });

  // Settle every entry module before any registration runs. Top-level
  // await: the prelude is a module script, and the injection batch is
  // already open, so React sees one notification with the final state
  // regardless of how long the imports take.
  setup.push(
    "const __zb_results = await Promise.allSettled([",
    ...moduleImports,
    "])",
  );

  // Per (aroundFn, Original) memoized React component. Stable identity
  // across renders inside one chain incarnation; fresh component when
  // the chain rebuilds so React mounts/unmounts cleanly.
  if (needsAroundWrapper) {
    setup.unshift(
      "const __zb_aroundCache = new WeakMap()",
      // Error boundary between the host tree and each around-advice
      // layer. A plugin's advice throwing during render must degrade
      // to the ORIGINAL component (advice skipped, loudly logged) —
      // never take down the host surface it wraps. Once tripped, the
      // boundary stays in fallback for the life of the mount; editing
      // the advice rebuilds the chain (fresh component identity →
      // remount), which re-arms it.
      "class __zb_AdviceBoundary extends __zb_Component {",
      "  constructor(props) { super(props); this.state = { failed: false } }",
      "  static getDerivedStateFromError() { return { failed: true } }",
      "  componentDidCatch(err) {",
      "    console.error(",
      "      '[zenbu] around-advice \\'' + this.props.__zb_adviceName + '\\' for <' + this.props.__zb_originalName + '> threw during render. Skipping this advice and rendering the original component. Error:',",
      "      err,",
      "    )",
      "  }",
      "  render() {",
      "    if (this.state.failed) return __zb_createElement(this.props.__zb_original, this.props.__zb_props)",
      "    return __zb_createElement(this.props.__zb_comp, this.props.__zb_props)",
      "  }",
      "}",
      "function __zb_wrapAround(aroundFn) {",
      "  return function(Original, props) {",
      "    let perFn = __zb_aroundCache.get(aroundFn)",
      "    if (!perFn) { perFn = new WeakMap(); __zb_aroundCache.set(aroundFn, perFn) }",
      "    let Comp = perFn.get(Original)",
      "    if (!Comp) {",
      "      Comp = function (p) { return aroundFn(Original, p) }",
      "      try { Object.defineProperty(Comp, 'name', { value: aroundFn.name || 'AroundAdvice' }) } catch {}",
      "      perFn.set(Original, Comp)",
      "    }",
      "    return __zb_createElement(__zb_AdviceBoundary, {",
      "      __zb_comp: Comp,",
      "      __zb_original: Original,",
      "      __zb_props: props,",
      "      __zb_adviceName: aroundFn.name || 'around-advice',",
      "      __zb_originalName: Original.displayName || Original.name || 'component',",
      "    })",
      "  }",
      "}",
    );
  }

  // Uniform `setup` hook — runs after prev-disposers + new
  // registrations. Return value (if a function) is captured as the
  // next round's disposer. Same shape as `Service.setup(name, () =>
  // cleanup)` in main-process services.
  for (const { alias, index } of setupAliases) {
    calls.push(
      `if (${alias} && typeof ${alias}.setup === "function") { const __r${index} = ${alias}.setup(); if (typeof __r${index} === "function") __zb_disposers.push(__r${index}) }`,
    );
  }

  const hmrTail = [
    "__zb_endInjectionBatch()",
    "if (import.meta.hot) {",
    // Stash; don't unregister now — that'd commit an empty state
    // to React before the new body runs.
    "  import.meta.hot.dispose((data) => { data.__zb_disposers = __zb_disposers })",
    "  import.meta.hot.accept()",
    "}",
  ].join("\n");

  return (
    imports.join("\n") +
    "\n" +
    setup.join("\n") +
    "\n" +
    calls.join("\n") +
    "\n" +
    hmrTail +
    "\n"
  );
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

/* ---------- Injection prelude virtual module ---------- */
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
      // Editing an injection's source file needs a full reload —
      // registration is a side effect of the prelude script that only
      // runs at boot.
      if (getAllInjectionPaths().includes(file)) {
        server.ws.send({ type: "full-reload" });
        return [];
      }
      return undefined;
    },

    configureServer(server) {
      // Renderer-side injection load failures land in the terminal the
      // dev session was launched from, not just the webview's devtools
      // console — a blank surface should never require hunting for the
      // error two contexts away.
      server.ws.on(
        "zenbu:injection-load-failure",
        (data: {
          name?: string;
          modulePath?: string;
          pluginDir?: string | null;
          error?: string;
        }) => {
          console.error(
            `[zenbu] injection "${data?.name}" failed to load` +
              (data?.pluginDir ? ` (plugin at ${data.pluginDir})` : "") +
              ` — module ${data?.modulePath}\n${data?.error ?? "unknown error"}`,
          );
        },
      );

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

    transformIndexHtml(html) {
      const tags: Array<{
        tag: string;
        attrs?: Record<string, string>;
        children?: string;
        injectTo: "head" | "head-prepend" | "body" | "body-prepend";
      }> = [];

      // Boot-trace prelude: inline sync `<script>`. Falls back to the
      // virtual module path when dist files are missing (cold checkout
      // before `pnpm build`).
      const inlinePrelude = buildInlinePreludeScript();
      tags.push(
        inlinePrelude
          ? { tag: "script", children: inlinePrelude, injectTo: "head" }
          : {
              tag: "script",
              attrs: { type: "module", src: PRELUDE_PREFIX },
              injectTo: "head",
            },
      );
      // Injection prelude. Imports every registered module before
      // `main.tsx` runs so the registry is populated by mount time.
      tags.push({
        tag: "script",
        attrs: { type: "module", src: PRELUDE_PREFIX },
        injectTo: "head",
      });
      return { html, tags };
    },
  };
}

// Advice is a renderer-source transform, not just an entrypoint-root
// transform. The host app's Vite root covers its own renderer tree; enabled
// plugins can also own renderer surfaces, so their `src/**` files need the
// same instrumentation when Vite serves them from outside `config.root`.
const ADVICE_SOURCE_EXT_RE = /\.[jt]sx?$/;

function normalizeFsPath(value: string): string {
  return path.resolve(value).replace(/\\/g, "/").replace(/\/+$/, "");
}

function stripViteRequestSuffix(id: string): string {
  const index = id.search(/[?#]/);
  return index === -1 ? id : id.slice(0, index);
}

function isInsideDir(file: string, dir: string): boolean {
  return file === dir || file.startsWith(`${dir}/`);
}

function adviceTransformRoots(viteRoot: string): string[] {
  const roots = new Set<string>([normalizeFsPath(viteRoot)]);
  for (const plugin of getConfig().plugins) {
    roots.add(normalizeFsPath(path.join(plugin.dir, "src")));
  }
  return [...roots];
}

function shouldAdviceTransform(id: string, viteRoot: string): boolean {
  if (id.includes("\0")) return false;
  const file = normalizeFsPath(stripViteRequestSuffix(id));
  if (!ADVICE_SOURCE_EXT_RE.test(file)) return false;
  return adviceTransformRoots(viteRoot).some((root) => isInsideDir(file, root));
}

/** Scoped wrapper around `@zenbu/advice/vite`'s babel transform. */
export function zenbuAdviceTransform(): Plugin {
  let inner: any = null;
  let viteRoot = "";
  return {
    name: "zenbu-advice-scoped",
    enforce: "pre",
    configResolved(config) {
      viteRoot = config.root;
      inner = zenbuAdvicePlugin({ root: config.root });
      const hook = (inner as any)?.configResolved;
      if (typeof hook === "function") {
        hook.call(this, config);
      }
    },
    transform(code, id) {
      if (!viteRoot || !shouldAdviceTransform(id, viteRoot)) return null;
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

// Drop Vite's cold-boot `full-reload` ws message when no HMR client
// is connected. The optimizer's first commit races Electron's
// `loadURL`; the message is only useful to clients with already-
// fetched bundle URLs. Gating on `clients.size === 0` keeps later
// edits working normally.
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
        if (isFullReload && (ws.clients?.size ?? 0) === 0) return;
        return orig(...args);
      }) as typeof ws.send;
    },
  };
}

/* ---------- Tailwind @source registry ----------
 *
 * Backs `@import "@zenbujs/core/plugin-sources.css"`. Writes Tailwind
 * v4 `@source` directives — one per registered plugin's `src/**` —
 * to a per-host sidecar file under `node_modules/.zenbu/`. Aliased so
 * each worktree gets its own file (sharing one in core's dist caused
 * cross-worktree HMR reloads).
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
        if (!changed) return;
        // CSS HMR via `reloadModule` patches the stylesheet in place.
        // Avoids a `full-reload` that would close+reopen the window.
        try {
          const mod = server.moduleGraph.getModuleById(sourcesFile);
          if (mod) server.reloadModule(mod);
        } catch {}
      }, "vite-plugins/pluginSourcesCss");
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

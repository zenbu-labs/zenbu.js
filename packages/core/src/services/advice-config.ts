import path from "node:path"
import { runtime } from "../runtime"
// Don't import ReloaderService / RendererHostService / RpcService at the
// top — this file is reachable from `services/reloader.ts` via
// `vite-plugins.ts`, and a top-level circular import would resolve the
// dep classes to `undefined` during first eval. Look them up lazily.

/**
 * The injection registry — the one primitive plugins use to push
 * module exports into the renderer.
 *
 * Each injection is a `{ name, modulePath, exportName, meta }` record.
 * The Vite prelude pipeline imports every registered module before
 * `main.tsx` runs, and dispatches based on `meta.kind`:
 *
 *   - `meta.kind === "advice"` (with `meta.wraps` + `meta.adviceType`)
 *     wires up wrap/replace/before/after via `@zenbu/advice/runtime`.
 *
 *   - Anything else (or no kind) lands in the in-memory injection
 *     registry under `name`, where `useInjection(name)` /
 *     `useInjections({ kind })` can find it. `<View name="…">` is the
 *     canonical reader for "render this injection as a React component".
 *
 * A registration with no `meta` and no consumer is the old "content
 * script" pattern: the module is imported for side effects (which is
 * typically how userland mounts hidden React roots that themselves
 * call `useRegisterInjection`).
 */

/** Public spec for `this.inject({...})`. */
export interface InjectionSpec {
  name: string
  modulePath: string
  exportName?: string
  meta?: InjectionMeta
}

/**
 * Opaque, JSON-serializable metadata attached to an injection. The
 * codegen JSON.stringifies this verbatim, so every leaf has to round-
 * trip through `JSON.parse(JSON.stringify(...))`.
 *
 * Conventional keys plugin authors use:
 *   - `kind`: slot key (`"view"`, `"left-sidebar"`, `"footer.item"`, …).
 *             Discovery: `useInjections({ kind: "…" })`.
 *   - `label`: human-readable name.
 *   - `icon`: SVG markup. Auto-attached by `this.inject(...)` from the
 *             owning plugin's manifest if `plugin.icons[name]` exists.
 *
 * Advice-specific:
 *   - `kind: "advice"` + `wraps: { moduleId, name }` + `adviceType`.
 */
export type InjectionMeta = Record<string, unknown> & {
  kind?: string
  label?: string
  icon?: string
  wraps?: { moduleId: string; name: string }
  adviceType?: "replace" | "before" | "after" | "around"
}

export interface InjectionEntry {
  name: string
  modulePath: string
  exportName: string
  meta?: InjectionMeta
}

/**
 * Sugar spec for `this.advise({...})`. Translated into an injection
 * with `meta.kind: "advice"` plus the target / wrap-type meta.
 */
export interface AdviceSpec {
  /**
   * Module whose export is being wrapped. Matched as a suffix against
   * the importing module's id, so file-extension agnostic
   * (`"App.tsx"` matches `/abs/path/App.tsx` and the .ts variant).
   */
  moduleId: string
  /** Name of the export to advise. */
  name: string
  /** Wrap shape — same vocabulary as `@zenbu/advice/runtime`. */
  type: "replace" | "before" | "after" | "around"
  /** Module containing the wrapper. Relative paths resolve against the plugin root. */
  modulePath: string
  /** Named export inside `modulePath`. Defaults to `default`. */
  exportName?: string
  /**
   * Optional explicit injection name. Defaults to a synthetic
   * `advice:<moduleId>:<name>:<type>` so the injection key stays
   * stable across re-registrations of the same target.
   */
  injectionName?: string
}

const RESOLVED_PREFIX = "\0@injections-prelude/"
const APP_RENDERER_RELOADER_ID = "app"

/**
 * The single source of truth. Keyed by injection `name`. Last
 * registration with a given name wins; `dispose()` only clears the
 * slot if it still owns it (so a stale dispose can't blow away a
 * later re-registration).
 */
const injections = new Map<string, InjectionEntry>()
const injectionChangeListeners = new Set<() => void>()

function resolveAgainstPlugin(
  modulePath: string,
  pluginDir: string | null,
): string {
  if (path.isAbsolute(modulePath)) return modulePath
  if (pluginDir == null) {
    throw new Error(
      `[injections] relative modulePath "${modulePath}" registered without a plugin root. ` +
        `Pass an absolute path or register from inside a plugin service.`,
    )
  }
  return path.resolve(pluginDir, modulePath)
}

/**
 * Invalidate the `/@injections-prelude` virtual module in the host
 * Vite graph so the next request regenerates from the live registry.
 */
function invalidatePrelude() {
  try {
    const reloader = runtime.getSlot("reloader")?.instance as
      | { get(id: string): { viteServer?: any } | undefined }
      | undefined
    if (!reloader) return
    const coreEntry = reloader.get(APP_RENDERER_RELOADER_ID)
    if (!coreEntry?.viteServer) return
    const graph = coreEntry.viteServer.moduleGraph
    for (const id of graph.idToModuleMap.keys()) {
      if (typeof id !== "string") continue
      if (id.startsWith(RESOLVED_PREFIX)) {
        const mod = graph.getModuleById(id)
        if (mod) graph.invalidateModule(mod)
      }
    }
  } catch {}
}

/**
 * Invalidate the prelude module + ping the host renderer to reload so
 * the fresh registrations take effect. Module-load injections only
 * run at boot, so a reload is the simplest contract. Also fires the
 * in-process listeners so main-side services can react to
 * injection-set changes without going through the renderer.
 */
function emitReload() {
  invalidatePrelude()
  for (const cb of injectionChangeListeners) {
    try {
      cb()
    } catch {}
  }
  try {
    const rpc = runtime.getSlot("rpc")?.instance as
      | {
          emit: {
            core: { advice: { reload(payload: { type: string }): void } }
          }
        }
      | undefined
    // The host renderer's reload signal is the legacy
    // `core.advice.reload` event; keeping the wire-level event name
    // unchanged means the in-renderer listener doesn't have to change
    // while we're shuffling the prelude.
    rpc?.emit?.core?.advice?.reload({ type: "*" })
  } catch {}
}

/**
 * Subscribe to injection registry changes from the main process.
 * Useful for services that auto-register shortcuts / palette
 * actions per injection (e.g. `SidebarViewShortcutsService`).
 */
export function subscribeInjections(cb: () => void): () => void {
  injectionChangeListeners.add(cb)
  return () => {
    injectionChangeListeners.delete(cb)
  }
}

/**
 * Register an injection. `pluginDir` is used to resolve relative
 * `modulePath` values; pass `null` to require an absolute path.
 */
export function addInjection(
  pluginDir: string | null,
  spec: InjectionSpec,
): () => void {
  const entry: InjectionEntry = {
    name: spec.name,
    modulePath: resolveAgainstPlugin(spec.modulePath, pluginDir),
    exportName: spec.exportName ?? "default",
    meta: spec.meta,
  }
  injections.set(spec.name, entry)
  emitReload()

  return () => {
    if (injections.get(spec.name) === entry) {
      injections.delete(spec.name)
      emitReload()
    }
  }
}

/**
 * Sugar for advice. Materializes an injection with the well-known
 * advice meta shape; the prelude codegen dispatches advice entries
 * through `@zenbu/advice/runtime` instead of the in-renderer
 * injection registry.
 */
export function addAdvice(
  pluginDir: string | null,
  spec: AdviceSpec,
): () => void {
  const name =
    spec.injectionName ??
    `advice:${spec.moduleId}:${spec.name}:${spec.type}`
  return addInjection(pluginDir, {
    name,
    modulePath: spec.modulePath,
    exportName: spec.exportName,
    meta: {
      kind: "advice",
      wraps: { moduleId: spec.moduleId, name: spec.name },
      adviceType: spec.type,
    },
  })
}

/** Every registered injection. Read by the prelude codegen. */
export function getInjections(): InjectionEntry[] {
  return [...injections.values()]
}

/** Source paths for HMR detection in the Vite plugin. */
export function getAllInjectionPaths(): string[] {
  return [...injections.values()].map((e) => e.modulePath)
}

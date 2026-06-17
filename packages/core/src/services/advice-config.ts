import path from "node:path"
import { runtime } from "../runtime"
// Avoid top-level imports of services that pull this file in via
// `vite-plugins.ts`; we look them up lazily inside the emit path.

// The injection registry. Source of truth for everything that flows
// through the Vite prelude pipeline. The codegen in `vite-plugins.ts`
// reads `getInjections()` and dispatches per entry:
//   - `meta.kind === "advice"` -> @zenbu/advice/runtime
//   - no `meta` / `meta.kind === "bootstrap"` -> side-effect import
//   - anything else -> registerInjection(name, value, meta) in the
//     renderer's in-memory map.

export interface InjectionSpec {
  name: string
  modulePath: string
  exportName?: string
  meta?: InjectionMeta
}

/**
 * Opaque JSON metadata. JSON.stringify'd verbatim by the codegen.
 * Conventional: `kind` (slot key, discovery via `useInjections`),
 * `label`, `icon` (auto-attached from plugin manifest if any).
 * Advice entries also carry `wraps` + `adviceType`.
 */
export type InjectionMeta = Record<string, unknown> & {
  kind?: string
  label?: string
  icon?: string
  wraps?: { moduleId: string; name: string }
  /** Stable advice-target id; resolved against `addAdviceTarget`
   * registrations at prelude-generation time (see `getInjections`). */
  wrapsTarget?: string
  adviceType?: "replace" | "before" | "after" | "around"
}

export interface InjectionEntry {
  name: string
  modulePath: string
  exportName: string
  meta?: InjectionMeta
  /** Owning plugin's root dir, when registered from a plugin service.
   * Diagnostics use it to name the culprit when the module fails to
   * load — "which plugin broke" is the first question, not the path. */
  pluginDir?: string
}

/**
 * Sugar spec for `this.advise(...)`. Target one of two ways:
 *
 *  - `target` — a stable advice-target ID the owning plugin declared
 *    via `Service#adviceTarget` / `addAdviceTarget`. Preferred: the
 *    owner can move files freely and only updates its registration;
 *    advisers don't break.
 *  - `moduleId` + `name` — suffix-matched module path + export name.
 *    Breaks silently if the owner moves the file.
 */
export interface AdviceSpec {
  /** Stable advice-target id (preferred over moduleId/name). */
  target?: string
  /** Suffix-matched against the target module's id. */
  moduleId?: string
  /** Name of the export to advise. */
  name?: string
  /** Wrap shape — same vocab as `@zenbu/advice/runtime`. */
  type: "replace" | "before" | "after" | "around"
  /** Wrapper module. Relative paths resolve against the plugin root. */
  modulePath: string
  /** Named export. Defaults to `default`. */
  exportName?: string
  /** Override the synthetic injection name. */
  injectionName?: string
}

// Must match `RESOLVED_PREFIX` in `vite-plugins.ts` byte-for-byte — the
// codegen plugin writes virtual modules under this id, and we look
// them up here by exact `startsWith`. 
const RESOLVED_PREFIX = "\0@injections-prelude"

// Source of truth, keyed by `name`. Last registration wins; dispose
// only clears if we still own the slot.
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

// Invalidate the virtual prelude module AND ask Vite to push an HMR
// update for it. The prelude module self-accepts and disposes its
// previous registrations on `import.meta.hot.dispose`, so a single
// HMR update is enough to swap the renderer's injection registry from
// the old set to the new set with no page reload.
function invalidatePrelude() {
  try {
    const vite = runtime.getSlot("vite")?.instance as
      | { viteServer?: any }
      | undefined
    const server = vite?.viteServer
    if (!server) return
    const graph = server.moduleGraph
    const preludeModules: unknown[] = []
    for (const id of graph.idToModuleMap.keys()) {
      if (typeof id !== "string") continue
      if (id.startsWith(RESOLVED_PREFIX)) {
        const mod = graph.getModuleById(id)
        if (mod) {
          graph.invalidateModule(mod)
          preludeModules.push(mod)
        }
      }
    }
    if (preludeModules.length === 0) return
    // Push an HMR `update` message for each prelude module. Vite's
    // CSS / module HMR pipeline already knows how to ship one, so we
    // reuse its `reloadModule` API. The module's own
    // `import.meta.hot.accept()` keeps the change scoped to the
    // prelude — no page reload, no other modules invalidated.
    for (const mod of preludeModules) {
      try {
        ;(server as { reloadModule: (m: unknown) => unknown }).reloadModule(mod)
      } catch {}
    }
  } catch {}
}

// Invalidate the virtual prelude + reload the renderer + fire
// in-process listeners. Module-load injections only run at boot, so a
// reload is the simplest way to apply changes.

function emitReload() {
  // Surgical path. `invalidatePrelude` invalidates the virtual
  // `@injections-prelude` module in Vite's graph and pushes an HMR
  // update for it. The prelude self-accepts and runs its `dispose`
  // hook to unregister the previous round's renderer-side
  // `registerInjection` slots, then re-evaluates with the current
  // entries. Net: the renderer's injection registry tracks the
  // main-side `injections` Map without any full page reload.
  invalidatePrelude()
  // In-process bus for main-side listeners (e.g. the Vite prelude
  // codegen plugin uses this to know when to regenerate). Cheap and
  // doesn't touch the renderer.
  for (const cb of injectionChangeListeners) {
    try {
      cb()
    } catch {}
  }
  // The legacy `rpc.emit.core.advice.reload({ type: "*" })` path
  // was here. It triggered `location.reload()` in the renderer,
  // which re-fetched the prelude through a page refresh. With the
  // HMR-self-accepting prelude above, that's strictly redundant —
  // and on top of the surgical update it causes a visible page
  // reload (splash flash, scroll position lost, React state
  // discarded). Removed. The renderer-side listener in
  // `react.ts` is now a no-op; safe to delete in a follow-up but
  // harmless to leave.
}

/** Subscribe to registry changes from main-side services. */
export function subscribeInjections(cb: () => void): () => void {
  injectionChangeListeners.add(cb)
  return () => {
    injectionChangeListeners.delete(cb)
  }
}

/** Register an injection. `pluginDir = null` requires an absolute modulePath. */
export function addInjection(
  pluginDir: string | null,
  spec: InjectionSpec,
): () => void {
  const entry: InjectionEntry = {
    name: spec.name,
    modulePath: resolveAgainstPlugin(spec.modulePath, pluginDir),
    exportName: spec.exportName ?? "default",
    meta: spec.meta,
    pluginDir: pluginDir ?? undefined,
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

// ---- Stable advice targets ----
//
// Owners of advisable components declare a stable id → (moduleId,
// name) mapping. Advisers reference the id; when the owner moves the
// file it updates ONE registration and every adviser keeps working.
// Resolution happens lazily in `getInjections()` so registration
// order between owners and advisers doesn't matter.
const adviceTargets = new Map<string, { moduleId: string; name: string }>()
const warnedUnresolvedTargets = new Set<string>()

/** Declare (or re-declare) a stable advice target. Returns a disposer. */
export function addAdviceTarget(
  id: string,
  target: { moduleId: string; name: string },
): () => void {
  adviceTargets.set(id, target)
  warnedUnresolvedTargets.delete(id)
  emitReload()
  return () => {
    if (adviceTargets.get(id) === target) {
      adviceTargets.delete(id)
      emitReload()
    }
  }
}

/** Sugar over `addInjection` with the advice meta shape. */
export function addAdvice(
  pluginDir: string | null,
  spec: AdviceSpec,
): () => void {
  if (!spec.target && !(spec.moduleId && spec.name)) {
    throw new Error(
      `[advice] spec for "${spec.modulePath}" needs either a stable ` +
        "`target` id or a `moduleId` + `name` pair.",
    )
  }
  const name =
    spec.injectionName ??
    (spec.target
      ? `advice:@${spec.target}:${spec.type}`
      : `advice:${spec.moduleId}:${spec.name}:${spec.type}`)
  return addInjection(pluginDir, {
    name,
    modulePath: spec.modulePath,
    exportName: spec.exportName,
    meta: {
      kind: "advice",
      ...(spec.target
        ? { wrapsTarget: spec.target }
        : { wraps: { moduleId: spec.moduleId!, name: spec.name! } }),
      adviceType: spec.type,
    },
  })
}

/**
 * Every registered injection, with stable advice-target ids resolved
 * to concrete `wraps` pairs. Read by the prelude codegen. Entries
 * whose target id has no registration keep `wraps` undefined — the
 * codegen skips them — and warn once per id so a typo'd or
 * not-yet-registered target is visible instead of a silent no-op.
 */
export function getInjections(): InjectionEntry[] {
  return [...injections.values()].map((entry) => {
    const targetId = entry.meta?.wrapsTarget
    if (!targetId || entry.meta?.wraps) return entry
    const resolved = adviceTargets.get(targetId)
    if (!resolved) {
      if (!warnedUnresolvedTargets.has(targetId)) {
        warnedUnresolvedTargets.add(targetId)
        console.warn(
          `[advice] no advice target registered under "${targetId}" ` +
            `(needed by injection "${entry.name}"). The advice will not ` +
            "apply until the owning plugin declares it via adviceTarget().",
        )
      }
      return entry
    }
    return { ...entry, meta: { ...entry.meta, wraps: resolved } }
  })
}

/** Source paths for HMR detection in the Vite plugin. */
export function getAllInjectionPaths(): string[] {
  return [...injections.values()].map((e) => e.modulePath)
}

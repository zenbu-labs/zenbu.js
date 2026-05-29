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
  adviceType?: "replace" | "before" | "after" | "around"
}

export interface InjectionEntry {
  name: string
  modulePath: string
  exportName: string
  meta?: InjectionMeta
}

/** Sugar spec for `this.advise(...)`. */
export interface AdviceSpec {
  /** Suffix-matched against the target module's id. */
  moduleId: string
  /** Name of the export to advise. */
  name: string
  /** Wrap shape — same vocab as `@zenbu/advice/runtime`. */
  type: "replace" | "before" | "after" | "around"
  /** Wrapper module. Relative paths resolve against the plugin root. */
  modulePath: string
  /** Named export. Defaults to `default`. */
  exportName?: string
  /** Override the synthetic injection name. */
  injectionName?: string
}

const RESOLVED_PREFIX = "\0@injections-prelude/"

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

// Invalidate the virtual prelude module so the next request
// regenerates it from the live registry.
function invalidatePrelude() {
  try {
    const vite = runtime.getSlot("vite")?.instance as
      | { viteServer?: any }
      | undefined
    const server = vite?.viteServer
    if (!server) return
    const graph = server.moduleGraph
    for (const id of graph.idToModuleMap.keys()) {
      if (typeof id !== "string") continue
      if (id.startsWith(RESOLVED_PREFIX)) {
        const mod = graph.getModuleById(id)
        if (mod) graph.invalidateModule(mod)
      }
    }
  } catch {}
}

// Invalidate the virtual prelude + reload the renderer + fire
// in-process listeners. Module-load injections only run at boot, so a
// reload is the simplest way to apply changes.

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

/** Sugar over `addInjection` with the advice meta shape. */
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

import path from "node:path"
import { runtime } from "../runtime"
// NOTE: do NOT import ReloaderService / RendererHostService / RpcService at the
// top of this module. This file is reachable from `services/reloader.ts`
// through `vite-plugins.ts`, and a top-level circular import means the dep
// classes used below would resolve to `undefined` during the very first eval
// pass — and *some other* service's `static deps = { reloader: ReloaderService }`
// would close over an `undefined`, taking out the runtime's dep resolver.
// Resolve those services lazily inside the few functions that need them
// (after all modules have finished evaluating).

export interface ViewAdviceEntry {
  moduleId: string
  name: string
  type: "replace" | "before" | "after" | "around"
  modulePath: string
  exportName: string
}

/**
 * Public spec passed to `service.advise({...})`. The plugin root is
 * resolved automatically from the calling service's slot (stamped by
 * `runtime.register` at registration time), so plugin code never has to
 * deal with `import.meta`.
 *
 * `modulePath` is normally relative to the plugin root (the folder
 * containing `zenbu.plugin.json`). Absolute paths are accepted as an
 * escape hatch.
 */
export interface AdviceSpec {
  view: string
  moduleId: string
  name: string
  type: "replace" | "before" | "after" | "around"
  modulePath: string
  exportName: string
}

/**
 * Public spec passed to `service.contentScript({...})`. Same plugin-root
 * resolution rules as `AdviceSpec`.
 */
export interface ContentScriptSpec {
  view: string
  modulePath: string
}

const RESOLVED_PREFIX = "\0@advice-prelude/"
const APP_RENDERER_RELOADER_ID = "app"
const adviceEntries = new Map<string, ViewAdviceEntry[]>()
interface ContentScriptEntry { path: string }
const contentScripts = new Map<string, ContentScriptEntry[]>()

function resolveAgainstPlugin(modulePath: string, pluginDir: string): string {
  if (path.isAbsolute(modulePath)) return modulePath
  return path.resolve(pluginDir, modulePath)
}

function invalidatePrelude(type: string) {
  try {
    const reloader = runtime.getSlot("reloader")?.instance as
      | { get(id: string): { viteServer?: any } | undefined }
      | undefined
    if (!reloader) return
    const coreEntry = reloader.get(APP_RENDERER_RELOADER_ID)
    if (!coreEntry?.viteServer) return
    const graph = coreEntry.viteServer.moduleGraph
    const invalidateMatching = (test: (id: string) => boolean) => {
      const ids: string[] = []
      for (const id of graph.idToModuleMap.keys()) {
        if (typeof id !== "string") continue
        if (test(id)) ids.push(id)
      }
      for (const id of ids) {
        const mod = graph.getModuleById(id)
        if (mod) graph.invalidateModule(mod)
      }
    }
    if (type === "*") {
      // A wildcard registration (applies to every view) changes the prelude
      // content for *every* type, so invalidate every prelude module
      // currently in the graph rather than scanning a per-type prefix.
      invalidateMatching((id) => id.startsWith(RESOLVED_PREFIX))
    } else {
      const prefix = RESOLVED_PREFIX + type
      invalidateMatching(
        (id) => id === prefix || id.startsWith(prefix + "?"),
      )
    }
  } catch {}
}

function emitReload(type: string) {
  invalidatePrelude(type)
  try {
    const rpc = runtime.getSlot("rpc")?.instance as
      | {
          emit: {
            core: { advice: { reload(payload: { type: string }): void } }
          }
        }
      | undefined
    if (!rpc) return
    // `"*"` is a sentinel that every connected iframe treats as "reload me
    // regardless of my view type". Don't fan out over `getAllTypes()` here —
    // when only a wildcard registration exists the fan-out is empty and the
    // event silently disappears.
    rpc.emit.core.advice.reload({ type })
  } catch {}
}

// --- Advice ---

/**
 * Internal advice registrar. Called by `Service#advise` after the runtime
 * has resolved the calling plugin's root directory from its service slot.
 * User code does not call this directly; use `service.advise({...})`
 * instead.
 */
export function addAdvice(pluginDir: string, spec: AdviceSpec): () => void {
  const { view, ...entry } = spec
  const resolvedEntry: ViewAdviceEntry = {
    ...entry,
    modulePath: resolveAgainstPlugin(entry.modulePath, pluginDir),
  }
  const list = adviceEntries.get(view) ?? []
  list.push(resolvedEntry)
  adviceEntries.set(view, list)
  emitReload(view)

  return () => {
    const current = adviceEntries.get(view)
    if (!current) return
    const idx = current.indexOf(resolvedEntry)
    if (idx >= 0) current.splice(idx, 1)
    if (current.length === 0) adviceEntries.delete(view)
    emitReload(view)
  }
}

/**
 * Returns advice entries that apply to `type`. Mirrors the wildcard
 * semantics of `getContentScripts`: entries registered with
 * `view: "*"` apply to every concrete view, listed before view-scoped
 * entries (so concrete-view advice wraps wildcard advice in the
 * around-chain order).
 */
export function getAdvice(type: string): ViewAdviceEntry[] {
  const scoped = adviceEntries.get(type) ?? []
  const wildcard = type !== "*" ? (adviceEntries.get("*") ?? []) : []
  return [...wildcard, ...scoped]
}

export function getAllAdviceTypes(): string[] {
  return [...adviceEntries.keys()]
}

// --- Content Scripts ---

/**
 * Internal content-script registrar. Called by `Service#contentScript`
 * after the runtime has resolved the calling plugin's root directory.
 * User code uses `service.contentScript({...})`.
 */
export function addContentScript(
  pluginDir: string,
  spec: ContentScriptSpec,
): () => void {
  const { view, modulePath } = spec
  const resolvedPath = resolveAgainstPlugin(modulePath, pluginDir)
  const entry: ContentScriptEntry = { path: resolvedPath }
  const list = contentScripts.get(view) ?? []
  list.push(entry)
  contentScripts.set(view, list)
  emitReload(view === "*" ? "*" : view)

  return () => {
    const current = contentScripts.get(view)
    if (!current) return
    const idx = current.indexOf(entry)
    if (idx >= 0) current.splice(idx, 1)
    if (current.length === 0) contentScripts.delete(view)
    emitReload(view === "*" ? "*" : view)
  }
}

export function getContentScripts(type: string): string[] {
  const scoped = (contentScripts.get(type) ?? []).map(e => e.path)
  const global = type !== "*" ? (contentScripts.get("*") ?? []).map(e => e.path) : []
  return [...global, ...scoped]
}

export function getAllContentScriptPaths(): string[] {
  const paths: string[] = []
  for (const list of contentScripts.values()) {
    for (const entry of list) paths.push(entry.path)
  }
  return paths
}

export function getAllTypes(): string[] {
  const types = new Set<string>()
  for (const k of adviceEntries.keys()) types.add(k)
  for (const k of contentScripts.keys()) if (k !== "*") types.add(k)
  return [...types]
}

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

/**
 * Source spec for a component view. `modulePath` may be relative to
 * the registering plugin's root (resolved by `viewRegistry.register`
 * just like advice / content-script paths). `exportName` defaults to
 * `"default"`.
 */
export interface ComponentViewSpec {
  type: string
  modulePath: string
  exportName?: string
}

export interface ComponentViewEntry {
  type: string
  modulePath: string
  exportName: string
}

/**
 * Source spec for a registered function. The export is imported into
 * every iframe's prelude and pushed into the client-side function
 * registry under `name`. `exportName` defaults to `"default"`. `meta`
 * is opaque JSON that consumers (`useFunctions({ kind: "..." })`) can
 * filter against.
 */
export interface FunctionSourceSpec {
  name: string
  modulePath: string
  exportName?: string
  meta?: Record<string, unknown>
}

export interface FunctionSourceEntry {
  name: string
  modulePath: string
  exportName: string
  meta?: Record<string, unknown>
}

const RESOLVED_PREFIX = "\0@advice-prelude/"
const APP_RENDERER_RELOADER_ID = "app"
const adviceEntries = new Map<string, ViewAdviceEntry[]>()
interface ContentScriptEntry { path: string }
const contentScripts = new Map<string, ContentScriptEntry[]>()
/**
 * Component views are global — a single `type` maps to a single source
 * module imported into *every* iframe's prelude so any view can render
 * `<View type="x">` (component mode). Keyed by view `type`, last
 * registration wins.
 */
const componentViews = new Map<string, ComponentViewEntry>()
/**
 * Source-file function registrations. Keyed by function `name`, last
 * registration wins (same churn semantics as component views).
 */
const functionSources = new Map<string, FunctionSourceEntry>()

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
    } else if (type === "**components" || type === "**functions") {
      // Component-view + function-source registrations also affect
      // every iframe's prelude (the generator emits their imports
      // unconditionally). Reuse the wildcard invalidation path; the
      // sentinel strings keep `emitReload` semantics distinct from
      // user-supplied `view: "*"`.
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
    // `"**components"` / `"**functions"` are internal sentinels for
    // global-prelude registration changes — every connected iframe
    // must reload because the registration set is embedded in every
    // prelude. Map either to the user-facing `"*"` event so connected
    // iframes' existing handlers (which look for `"*"` or their own
    // type) just work.
    const userType =
      type === "**components" || type === "**functions" ? "*" : type
    rpc.emit.core.advice.reload({ type: userType })
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
  for (const k of componentViews.keys()) types.add(k)
  for (const k of functionSources.keys()) types.add(k)
  return [...types]
}

// --- Component views ---

/**
 * Internal component-view registrar. Called by
 * `ViewRegistryService.register` when `rendering: "component"` is
 * combined with a `source: { modulePath, exportName }` spec. The
 * resulting module is injected into every iframe's prelude so
 * `<View type={spec.type}>` can render in any view.
 *
 * `pluginDir` is used to resolve relative `modulePath`s, identically
 * to advice / content scripts. Pass `null` to require an absolute
 * path.
 */
export function addComponentView(
  pluginDir: string | null,
  spec: ComponentViewSpec,
): () => void {
  const resolvedPath =
    pluginDir != null
      ? resolveAgainstPlugin(spec.modulePath, pluginDir)
      : (() => {
          if (!path.isAbsolute(spec.modulePath)) {
            throw new Error(
              `[viewRegistry] component view "${spec.type}" has a relative modulePath "${spec.modulePath}" but no plugin root to anchor it against. Pass an absolute path or register from inside a plugin service.`,
            )
          }
          return spec.modulePath
        })()
  const entry: ComponentViewEntry = {
    type: spec.type,
    modulePath: resolvedPath,
    exportName: spec.exportName ?? "default",
  }
  componentViews.set(spec.type, entry)
  emitReload("**components")

  return () => {
    // Only clear if we still own the slot. Avoids a stale dispose
    // from blowing away a later registration of the same type (HMR).
    if (componentViews.get(spec.type) === entry) {
      componentViews.delete(spec.type)
      emitReload("**components")
    }
  }
}

export function getComponentViews(): ComponentViewEntry[] {
  return [...componentViews.values()]
}

export function getAllComponentViewPaths(): string[] {
  return [...componentViews.values()].map((e) => e.modulePath)
}

// --- Function sources ---

/**
 * Internal function-source registrar. Called by
 * `FunctionRegistryService.register` when a `modulePath` is supplied.
 * The resulting module is imported into every iframe's prelude and
 * its export is pushed into the renderer-side function registry under
 * `spec.name` via `registerFunction`.
 *
 * `pluginDir` is used to resolve relative `modulePath`s (identical to
 * the advice / content-script / component-view paths). Pass `null` to
 * require an absolute path.
 */
export function addFunctionSource(
  pluginDir: string | null,
  spec: FunctionSourceSpec,
): () => void {
  const resolvedPath =
    pluginDir != null
      ? resolveAgainstPlugin(spec.modulePath, pluginDir)
      : (() => {
          if (!path.isAbsolute(spec.modulePath)) {
            throw new Error(
              `[functionRegistry] function "${spec.name}" has a relative modulePath "${spec.modulePath}" but no plugin root to anchor it against. Pass an absolute path or register from inside a plugin service.`,
            )
          }
          return spec.modulePath
        })()
  const entry: FunctionSourceEntry = {
    name: spec.name,
    modulePath: resolvedPath,
    exportName: spec.exportName ?? "default",
    meta: spec.meta,
  }
  functionSources.set(spec.name, entry)
  emitReload("**functions")

  return () => {
    if (functionSources.get(spec.name) === entry) {
      functionSources.delete(spec.name)
      emitReload("**functions")
    }
  }
}

export function getFunctionSources(): FunctionSourceEntry[] {
  return [...functionSources.values()]
}

export function getAllFunctionSourcePaths(): string[] {
  return [...functionSources.values()].map((e) => e.modulePath)
}

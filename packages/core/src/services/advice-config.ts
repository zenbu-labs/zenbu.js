import path from "node:path"
import { runtime } from "../runtime"
// Don't import ReloaderService / RendererHostService / RpcService at the
// top — this file is reachable from `services/reloader.ts` via
// `vite-plugins.ts`, and a top-level circular import would resolve the
// dep classes to `undefined` during first eval. Look them up lazily.

export interface ViewAdviceEntry {
  moduleId: string
  name: string
  type: "replace" | "before" | "after" | "around"
  modulePath: string
  exportName: string
}

/**
 * Spec passed to `service.advise({...})`. `modulePath` is relative to
 * the plugin root by default; absolute paths pass through.
 */
export interface AdviceSpec {
  view: string
  moduleId: string
  name: string
  type: "replace" | "before" | "after" | "around"
  modulePath: string
  exportName: string
}

/** Spec for `service.contentScript({...})`. Same path rules as `AdviceSpec`. */
export interface ContentScriptSpec {
  view: string
  modulePath: string
}

/** Source spec for a component view. Same path rules as advice. */
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

/** Source spec for a registered function. Same path rules as advice. */
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

/** Per-view advice (matches `view` or `view: "*"`). */
const adviceEntries = new Map<string, ViewAdviceEntry[]>()

interface ContentScriptEntry { path: string }
const contentScripts = new Map<string, ContentScriptEntry[]>()

/** Component views are global — every iframe's prelude registers all of them. */
const componentViews = new Map<string, ComponentViewEntry>()

/** Function sources are global too. Last-write-wins per name. */
const functionSources = new Map<string, FunctionSourceEntry>()

function resolveAgainstPlugin(modulePath: string, pluginDir: string): string {
  if (path.isAbsolute(modulePath)) return modulePath
  return path.resolve(pluginDir, modulePath)
}

/**
 * Invalidate the `/@advice-prelude/<type>` virtual module in the host
 * Vite graph so the next request regenerates from the live maps.
 * Wildcards / component-view / function changes fan out across every
 * prelude module.
 */
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
    if (
      type === "*" ||
      type === "**components" ||
      type === "**functions"
    ) {
      // Wildcard advice and the two global registries all affect every
      // prelude. The `**components` / `**functions` sentinels exist so
      // `emitReload` can distinguish them from user `view: "*"`.
      invalidateMatching((id) => id.startsWith(RESOLVED_PREFIX))
    } else {
      const prefix = RESOLVED_PREFIX + type
      invalidateMatching(
        (id) => id === prefix || id.startsWith(prefix + "?"),
      )
    }
  } catch {}
}

/**
 * Invalidate the prelude module(s) for `type`, then publish
 * `core.advice.reload` so connected iframes reload. The
 * `**components` / `**functions` sentinels collapse to `"*"` on the
 * wire — those registrations are global.
 */
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
    const userType =
      type === "**components" || type === "**functions" ? "*" : type
    rpc.emit.core.advice.reload({ type: userType })
  } catch {}
}

// --- Advice ---

/** Internal advice registrar. User code calls `service.advise({...})`. */
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
 * Advice that applies to `type`. Wildcards come first so view-scoped
 * advice wraps them in the around-chain order.
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

/** Internal content-script registrar. User code calls `service.contentScript({...})`. */
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
 * Internal component-view registrar. Pass `pluginDir = null` to require
 * an absolute `modulePath`.
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
    // Only clear if we still own the slot — protects against stale
    // disposes overwriting a later re-registration (HMR).
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
 * Internal function-source registrar. Pass `pluginDir = null` to require
 * an absolute `modulePath`.
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

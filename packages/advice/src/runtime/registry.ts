export type AdviceType = "before" | "after" | "around"

export interface AdviceEntry {
  type: AdviceType
  fn: Function
}

export interface FunctionEntry {
  impl: Function
  replacement: Function | null
  advice: AdviceEntry[]
  wrapper?: Function
  /**
   * Memoized advice chain. Built lazily by `applyAdviceChain` and
   * invalidated whenever the structure of the advice array changes
   * (an entry added or removed). impl / replacement changes do NOT
   * invalidate — the chain reads them live at call time.
   *
   * Why this matters: for around-advice on React components, the old
   * code rebuilt the entire `composed` closure stack on every wrapper
   * invocation. That meant the `next` (a.k.a. `__original`) passed
   * to a React around-advice was a brand-new function identity on
   * every render — so `<Original {...props} />` inside the advice
   * caused React to unmount and remount the wrapped subtree on every
   * parent re-render. Caching the composed chain keeps `next`
   * identity stable across calls and fixes that.
   */
  composed?: Function
}

const registry = new Map<string, Map<string, FunctionEntry>>()

function key(moduleId: string, name: string): string {
  return `${moduleId}:${name}`
}

export function getEntry(moduleId: string, name: string): FunctionEntry | undefined {
  return registry.get(moduleId)?.get(name)
}

export function getOrCreateEntry(moduleId: string, name: string): FunctionEntry {
  let moduleMap = registry.get(moduleId)
  if (!moduleMap) {
    moduleMap = new Map()
    registry.set(moduleId, moduleMap)
  }
  let entry = moduleMap.get(name)
  if (!entry) {
    entry = {
      impl: () => {
        throw new Error(
          `[zenbu/advice] "${name}" from module "${moduleId}" is not yet defined — ` +
          `it was called before its module registered an implementation. ` +
          `Likely causes: the defining module failed to evaluate (check earlier ` +
          `console errors), or a circular import reached this binding before ` +
          `the module body ran.`
        )
      },
      replacement: null,
      advice: [],
    }
    moduleMap.set(name, entry)
  }
  return entry
}

/**
 * When a real module registers itself via `setImpl(fullModuleId, ...)`,
 * detect any *short* moduleIds already present in the registry that
 * are a suffix of `fullModuleId`. Those entries are advice that was
 * registered against a non-canonical id (e.g. `"messages/tool-call.tsx"`
 * instead of `"/abs/path/to/messages/tool-call.tsx"`).
 *
 * Without auto-migration that advice will never fire — the registry
 * keys it on the short id, but the real module registers under the
 * full path, so the chain stays empty.
 *
 * Rather than silently auto-resolving (which makes short-id advice
 * "work by magic" and creates ambiguity when two files share a
 * basename), this function just logs a loud `console.error` pointing
 * the caller at the exact full id they should use. The short-id
 * advice does not apply. Callers must pass the full moduleId.
 */
function reportShortIdAdvice(fullModuleId: string, name: string): void {
  if (registry.size === 0) return
  for (const [existingId, existingMap] of registry) {
    if (existingId === fullModuleId) continue
    if (!fullModuleId.endsWith("/" + existingId)) continue
    if (!existingMap.has(name)) continue
    console.error(
      `[zenbu/advice] short moduleId "${existingId}" does not match the real module ` +
      `"${fullModuleId}" \u2014 advice on "${name}" will not fire. ` +
      `Pass the full moduleId to advise()/replace(): "${fullModuleId}".`
    )
  }
}

export function setImpl(moduleId: string, name: string, fn: Function): void {
  reportShortIdAdvice(moduleId, name)
  const entry = getOrCreateEntry(moduleId, name)
  entry.impl = fn
  entry.wrapper = undefined
}

export function setReplacement(moduleId: string, name: string, fn: Function): void {
  const entry = getOrCreateEntry(moduleId, name)
  entry.replacement = fn
}

export function clearReplacement(moduleId: string, name: string): void {
  const entry = getEntry(moduleId, name)
  if (entry) entry.replacement = null
}

export function addAdvice(moduleId: string, name: string, type: AdviceType, fn: Function): () => void {
  const entry = getOrCreateEntry(moduleId, name)
  const adviceEntry: AdviceEntry = { type, fn }
  entry.advice.push(adviceEntry)
  // Structure of the chain changed — next invocation must rebuild.
  entry.composed = undefined
  return () => {
    const idx = entry.advice.indexOf(adviceEntry)
    if (idx >= 0) entry.advice.splice(idx, 1)
    entry.composed = undefined
  }
}

export function clearModule(moduleId: string): void {
  registry.delete(moduleId)
}

export { registry }

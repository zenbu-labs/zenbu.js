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
}

const registry = new Map<string, Map<string, FunctionEntry>>()
// Tracks short moduleId aliases that have already been migrated to a full path.
// Used to detect ambiguous conflicts when a second full path matches the same short alias.
const migratedAliases = new Map<string, string>() // shortId → fullId it was migrated to

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
    entry = { impl: () => { throw new Error(`${moduleId}:${name} not yet defined`) }, replacement: null, advice: [] }
    moduleMap.set(name, entry)
  }
  return entry
}

function migrateSuffixAliases(fullModuleId: string): void {
  if (migratedAliases.size === 0 && registry.size === 0) return

  for (const [shortId, migratedTo] of migratedAliases) {
    if (fullModuleId.endsWith("/" + shortId) && migratedTo !== fullModuleId) {
      console.error(
        `[zenbu/advice] moduleId "${shortId}" is ambiguous — it matches both ` +
        `"${migratedTo}" and "${fullModuleId}". ` +
        `Use the full path in your advise() call to avoid conflicts.`
      )
      return
    }
  }

  for (const [existingId, existingMap] of registry) {
    if (existingId === fullModuleId) continue
    if (!fullModuleId.endsWith("/" + existingId)) continue

    console.warn(
      `[zenbu/advice] moduleId "${existingId}" matched "${fullModuleId}" by suffix. ` +
      `Use the full path "${fullModuleId}" in your advise() call to avoid conflicts.`
    )

    migratedAliases.set(existingId, fullModuleId)
    const targetMap = registry.get(fullModuleId)
    if (!targetMap) {
      registry.set(fullModuleId, existingMap)
    } else {
      for (const [name, entry] of existingMap) {
        if (!targetMap.has(name)) targetMap.set(name, entry)
      }
    }
    registry.delete(existingId)
  }
}

export function setImpl(moduleId: string, name: string, fn: Function): void {
  migrateSuffixAliases(moduleId)
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
  return () => {
    const idx = entry.advice.indexOf(adviceEntry)
    if (idx >= 0) entry.advice.splice(idx, 1)
  }
}

export function clearModule(moduleId: string): void {
  registry.delete(moduleId)
  for (const [shortId, fullId] of migratedAliases) {
    if (fullId === moduleId) migratedAliases.delete(shortId)
  }
}

export { registry, migratedAliases }

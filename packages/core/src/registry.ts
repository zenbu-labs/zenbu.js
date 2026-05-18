export interface ZenbuRegister {}

export type ResolvedDbRoot = ZenbuRegister extends { db: infer T }
  ? T
  : {};

export type ResolvedServiceRouter = ZenbuRegister extends { rpc: infer T }
  ? T
  : {};

export type ResolvedEvents = ZenbuRegister extends { events: infer T } ? T : {};

/**
 * Renderer-visible nested view of every service's `state(...)` cells,
 * keyed `[pluginName][serviceKey][fieldName]`. Falls back to
 * `Record<string, Record<string, Record<string, unknown>>>` until
 * `zen link` writes the augmentation; with the augmentation in scope,
 * `useServiceState`'s selector receives the exact shape.
 */
export type ResolvedServiceStates = ZenbuRegister extends { state: infer T }
  ? T
  : Record<string, Record<string, Record<string, unknown>>>;

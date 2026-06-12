/**
 * Public surface for the injection pipeline. Plugin authors use
 * `this.inject(...)` from a service or `useRegisterInjection` from
 * the renderer; this module re-exports the introspection helpers the
 * Vite plugin needs to generate the prelude module.
 */

export type {
  AdviceSpec,
  InjectionSpec,
  InjectionMeta,
  InjectionEntry,
} from "./services/advice-config";

export {
  addAdvice,
  addAdviceTarget,
  addInjection,
  getInjections,
  getAllInjectionPaths,
  subscribeInjections,
} from "./services/advice-config";

import type { FunctionEntry, AdviceEntry } from "./registry.js"

/**
 * Build (and memoize) the composed advice chain for a function entry.
 *
 * Why memoize: the previous implementation rebuilt the entire closure
 * stack on every call. For around-advice on React components, the
 * `next` argument passed in (which the advice typically re-renders as
 * `<Original {...props} />`) was therefore a brand-new function
 * identity every render. React reconciles `<X />` by component type,
 * so a fresh identity meant unmount + remount of the entire advised
 * subtree on every parent re-render. With a CodeMirror-backed Composer
 * that means destroying and rebuilding `EditorView` on every keystroke
 * — disastrous on the streaming chat hot path.
 *
 * The composed chain depends only on the *shape* of `entry.advice`
 * (which befores/afters/arounds are registered, in what order). It
 * does NOT depend on `entry.impl` or `entry.replacement`, both of
 * which are read live by `coreWithBeforesAfters` at call time. So we
 * cache the composed chain on the entry and invalidate it only when
 * advice is added or removed (see `registry.ts#addAdvice`).
 *
 * `this` is threaded through at call time via `Function.prototype.apply`
 * so the cached closures never have to capture `thisArg`.
 */
function buildChain(entry: FunctionEntry): Function {
  const befores: AdviceEntry[] = []
  const afters: AdviceEntry[] = []
  const arounds: AdviceEntry[] = []

  for (const a of entry.advice) {
    switch (a.type) {
      case "before": befores.push(a); break
      case "after": afters.push(a); break
      case "around": arounds.push(a); break
    }
  }

  function coreWithBeforesAfters(this: any, ...callArgs: any[]): any {
    for (const b of befores) {
      b.fn.apply(this, callArgs)
    }
    let result = (entry.replacement ?? entry.impl).apply(this, callArgs)
    for (let i = afters.length - 1; i >= 0; i--) {
      const afterResult = afters[i].fn.call(this, result, ...callArgs)
      if (afterResult !== undefined) result = afterResult
    }
    return result
  }

  let composed: Function = coreWithBeforesAfters
  for (let i = arounds.length - 1; i >= 0; i--) {
    const aroundFn = arounds[i].fn
    const next = composed
    // Plain `function` so `this` flows through from the outer .apply().
    // The closure captures `next` once and never reallocates, which
    // is exactly the identity stability React needs for around-advice
    // on components.
    composed = function aroundLayer(this: any, ...callArgs: any[]): any {
      return aroundFn.call(this, next, ...callArgs)
    }
  }

  return composed
}

export function applyAdviceChain(entry: FunctionEntry, args: any[], thisArg?: any): any {
  let composed = entry.composed
  if (!composed) {
    composed = buildChain(entry)
    entry.composed = composed
  }
  return composed.apply(thisArg, args)
}

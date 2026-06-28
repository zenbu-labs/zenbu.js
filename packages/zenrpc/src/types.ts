import type * as Effect from "effect/Effect";
export type AnyRouter = {
  [key: string]: ((...args: any[]) => any) | AnyRouter;
};

export type AnyRouterFactory = (getCtx: () => RpcContext) => AnyRouter;

export type RpcContext = {
  clientId: string;
};

/**
 * Strips Error/Effect internals from a tagged error type, keeping _tag
 * and user-defined data fields. Excludes stack, name, cause, symbols,
 * and function-valued properties.
 */
export type SerializedError<E> = E extends { readonly _tag: string }
  ? {
      [K in keyof E as K extends symbol
        ? never
        : K extends "stack" | "name" | "cause"
          ? never
          : E[K] extends (...args: any[]) => any
            ? never
            : K]: E[K];
    }
  : never;

/**
 * Result type for Effect-returning router methods.
 * Always wraps success in { _tag: "success", data: A }.
 * If E has tagged errors, they're added to the discriminated union.
 */
export type EffectResult<A, E> = [E] extends [never]
  ? { readonly _tag: "success"; readonly data: A }
  : { readonly _tag: "success"; readonly data: A } | SerializedError<E>;

/**
 * Recursively converts a router's methods into Promise-returning versions.
 *
 * The first branch is intentional and load-bearing: when a method is
 * **already async** (`(...args) => Promise<X>`), we hand back `T[K]`
 * unchanged — an indexed access type — so editors can resolve cmd+click /
 * go-to-definition through the proxy back to the original service method.
 * The non-async and Effect branches still `infer` and rebuild the signature
 * (the call really does need to be wrapped on the wire), at the cost of
 * breaking go-to-def on those — services that want navigability should make
 * their RPC methods `async`.
 */
export type RouterProxy<T> = {
  [K in keyof T]: T[K] extends (...args: any[]) => Promise<any>
    ? T[K]
    : T[K] extends (...args: infer A) => infer R
      ? [R] extends [Effect.Effect<infer S, infer E, any>]
        ? (...args: A) => Promise<EffectResult<S, E>>
        : (...args: A) => Promise<Awaited<R>>
      : T[K] extends Record<string, any>
        ? RouterProxy<T[K]>
        : never;
};

/**
 * Recursively extracts the Effect requirements (R channel) from all methods
 * in a router tree. Used to constrain the runtime passed to createServer.
 */
export type ExtractRequirements<T> = T extends Record<string, any>
  ? {
      [K in keyof T]: T[K] extends (...args: any[]) => Effect.Effect<any, any, infer R>
        ? R
        : T[K] extends Record<string, any>
          ? ExtractRequirements<T[K]>
          : never;
    }[keyof T]
  : never;

/**
 * Recursively maps an event definition tree into subscribe proxies.
 * Every node is both navigable (for nesting) and subscribable (for leaf events).
 * In practice, only call .subscribe on leaf event nodes.
 */
export type EventProxy<T> = {
  [K in keyof T]: T[K] extends Record<string, any>
    ? EventProxy<T[K]> & { subscribe: (cb: (data: T[K]) => void) => () => void }
    : { subscribe: (cb: (data: T[K]) => void) => () => void };
};

/**
 * Unified event proxy: each node is both callable (emit) and subscribable.
 * Calling a node emits the event; `.subscribe()` listens for it.
 * Assignable to `EventProxy<T>` for backward compatibility.
 */
export type UnifiedEventProxy<T> = {
  [K in keyof T]: T[K] extends Record<string, any>
    ? UnifiedEventProxy<T[K]> &
        ((data: T[K]) => void) &
        { subscribe: (cb: (data: T[K]) => void) => () => void }
    : ((data: T[K]) => void) &
        { subscribe: (cb: (data: T[K]) => void) => () => void };
};

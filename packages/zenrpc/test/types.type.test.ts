import type { Effect } from "effect";
import type { Equal, Expect } from "type-testing";
import type {
  RouterProxy,
  AnyRouter,
  SerializedError,
  EffectResult,
  EventProxy,
  UnifiedEventProxy,
  ExtractRequirements,
} from "../src/types";

// --- RouterProxy maps sync functions to Promise-returning ---

type SyncRouter = {
  greet: (name: string) => string;
};

type _test_sync = Expect<
  Equal<RouterProxy<SyncRouter>, { greet: (name: string) => Promise<string> }>
>;

// --- RouterProxy maps async functions to Promise-returning (unwrapped) ---

type AsyncRouter = {
  fetchUser: (id: string) => Promise<{ id: string; name: string }>;
};

type _test_async = Expect<
  Equal<
    RouterProxy<AsyncRouter>,
    { fetchUser: (id: string) => Promise<{ id: string; name: string }> }
  >
>;

// --- RouterProxy handles nested routers ---

type NestedRouter = {
  users: {
    get: (id: string) => { id: string; name: string };
    list: () => { id: string; name: string }[];
  };
  health: () => "ok";
};

type _test_nested = Expect<
  Equal<
    RouterProxy<NestedRouter>,
    {
      users: {
        get: (id: string) => Promise<{ id: string; name: string }>;
        list: () => Promise<{ id: string; name: string }[]>;
      };
      health: () => Promise<"ok">;
    }
  >
>;

// --- RouterProxy handles deeply nested routers ---

type DeepRouter = {
  a: {
    b: {
      c: {
        method: (x: number) => boolean;
      };
    };
  };
};

type _test_deep = Expect<
  Equal<
    RouterProxy<DeepRouter>,
    {
      a: {
        b: {
          c: {
            method: (x: number) => Promise<boolean>;
          };
        };
      };
    }
  >
>;

// --- RouterProxy handles void return ---

type VoidRouter = {
  notify: (message: string) => void;
};

type _test_void = Expect<
  Equal<RouterProxy<VoidRouter>, { notify: (message: string) => Promise<void> }>
>;

// --- RouterProxy handles multiple arguments ---

type MultiArgRouter = {
  add: (a: number, b: number) => number;
};

type _test_multi_arg = Expect<
  Equal<
    RouterProxy<MultiArgRouter>,
    { add: (a: number, b: number) => Promise<number> }
  >
>;

// --- RouterProxy preserves optional properties in return types ---

type OptionalReturnRouter = {
  find: (id: string) => { name: string; email?: string };
};

type _test_optional_return = Expect<
  Equal<
    RouterProxy<OptionalReturnRouter>,
    { find: (id: string) => Promise<{ name: string; email?: string }> }
  >
>;

// --- ReturnType of factory correctly strips getCtx ---

type ServerRouterFactory = (getCtx: () => { clientId: string }) => {
  greet: (name: string) => string;
  users: {
    get: (id: string) => { id: string };
  };
};

type InferredServerRouter = ReturnType<ServerRouterFactory>;

type _test_factory_strip = Expect<
  Equal<
    RouterProxy<InferredServerRouter>,
    {
      greet: (name: string) => Promise<string>;
      users: {
        get: (id: string) => Promise<{ id: string }>;
      };
    }
  >
>;

// --- AnyRouter assignability ---

type _test_any_router_flat = Expect<
  Equal<
    { greet: (name: string) => string } extends AnyRouter ? true : false,
    true
  >
>;

type _test_any_router_nested = Expect<
  Equal<
    {
      users: { get: (id: string) => string };
    } extends AnyRouter
      ? true
      : false,
    true
  >
>;

// ============================
// Effect-aware type tests
// ============================

type FooError = { readonly _tag: "FooError"; readonly reason: string };
type BarError = { readonly _tag: "BarError"; readonly code: number };

// --- SerializedError passes through plain tagged types unchanged ---

type _test_serialized_foo = Expect<
  Equal<
    SerializedError<FooError>,
    { readonly _tag: "FooError"; readonly reason: string }
  >
>;

type _test_serialized_bar = Expect<
  Equal<
    SerializedError<BarError>,
    { readonly _tag: "BarError"; readonly code: number }
  >
>;

// --- SerializedError distributes over unions ---

type _test_serialized_union = Expect<
  Equal<
    SerializedError<FooError | BarError>,
    | { readonly _tag: "FooError"; readonly reason: string }
    | { readonly _tag: "BarError"; readonly code: number }
  >
>;

// --- SerializedError returns never for non-tagged types ---

type _test_serialized_plain = Expect<
  Equal<SerializedError<{ value: number }>, never>
>;

// --- EffectResult with no errors wraps in success ---

type _test_effect_result_no_errors = Expect<
  Equal<
    EffectResult<number, never>,
    { readonly _tag: "success"; readonly data: number }
  >
>;

// --- EffectResult with errors produces discriminated union ---

type _test_effect_result_with_errors = Expect<
  Equal<
    EffectResult<number, FooError | BarError>,
    | { readonly _tag: "success"; readonly data: number }
    | { readonly _tag: "FooError"; readonly reason: string }
    | { readonly _tag: "BarError"; readonly code: number }
  >
>;

// --- EffectResult with single error ---

type _test_effect_result_single_error = Expect<
  Equal<
    EffectResult<string, FooError>,
    | { readonly _tag: "success"; readonly data: string }
    | { readonly _tag: "FooError"; readonly reason: string }
  >
>;

// --- RouterProxy handles Effect methods with no errors ---

type EffectNoErrorRouter = {
  compute: () => Effect.Effect<number, never>;
};

type _test_effect_no_error_proxy = Expect<
  Equal<
    RouterProxy<EffectNoErrorRouter>,
    {
      compute: () => Promise<{ readonly _tag: "success"; readonly data: number }>;
    }
  >
>;

// --- RouterProxy handles Effect methods with errors ---

type EffectWithErrorRouter = {
  divide: (a: number, b: number) => Effect.Effect<number, FooError | BarError>;
};

type _test_effect_with_error_proxy = Expect<
  Equal<
    RouterProxy<EffectWithErrorRouter>,
    {
      divide: (
        a: number,
        b: number,
      ) => Promise<
        | { readonly _tag: "success"; readonly data: number }
        | { readonly _tag: "FooError"; readonly reason: string }
        | { readonly _tag: "BarError"; readonly code: number }
      >;
    }
  >
>;

// --- RouterProxy handles mixed router (plain + Effect methods) ---

type MixedRouter = {
  plain: (x: string) => string;
  effectSafe: () => Effect.Effect<number, never>;
  effectRisky: () => Effect.Effect<boolean, FooError>;
  nested: {
    effectMethod: (id: string) => Effect.Effect<{ id: string }, BarError>;
    syncMethod: () => void;
  };
};

type _test_mixed_plain = Expect<
  Equal<
    RouterProxy<MixedRouter>["plain"],
    (x: string) => Promise<string>
  >
>;

type _test_mixed_effect_safe = Expect<
  Equal<
    RouterProxy<MixedRouter>["effectSafe"],
    () => Promise<{ readonly _tag: "success"; readonly data: number }>
  >
>;

type _test_mixed_effect_risky = Expect<
  Equal<
    RouterProxy<MixedRouter>["effectRisky"],
    () => Promise<
      | { readonly _tag: "success"; readonly data: boolean }
      | { readonly _tag: "FooError"; readonly reason: string }
    >
  >
>;

type _test_mixed_nested_effect = Expect<
  Equal<
    RouterProxy<MixedRouter>["nested"]["effectMethod"],
    (
      id: string,
    ) => Promise<
      | { readonly _tag: "success"; readonly data: { id: string } }
      | { readonly _tag: "BarError"; readonly code: number }
    >
  >
>;

type _test_mixed_nested_sync = Expect<
  Equal<
    RouterProxy<MixedRouter>["nested"]["syncMethod"],
    () => Promise<void>
  >
>;

// --- RouterProxy handles Effect with complex return type ---

type ComplexReturn = { users: { id: string; name: string }[]; total: number };

type EffectComplexRouter = {
  search: (query: string) => Effect.Effect<ComplexReturn, FooError>;
};

type _test_effect_complex = Expect<
  Equal<
    RouterProxy<EffectComplexRouter>["search"],
    (
      query: string,
    ) => Promise<
      | { readonly _tag: "success"; readonly data: ComplexReturn }
      | { readonly _tag: "FooError"; readonly reason: string }
    >
  >
>;

// --- Factory with Effect methods strips getCtx correctly ---

type EffectFactory = (getCtx: () => { clientId: string }) => {
  safe: () => Effect.Effect<number, never>;
  risky: (x: number) => Effect.Effect<string, FooError>;
  plain: () => boolean;
};

type InferredEffectRouter = ReturnType<EffectFactory>;

type _test_effect_factory_safe = Expect<
  Equal<
    RouterProxy<InferredEffectRouter>["safe"],
    () => Promise<{ readonly _tag: "success"; readonly data: number }>
  >
>;

type _test_effect_factory_risky = Expect<
  Equal<
    RouterProxy<InferredEffectRouter>["risky"],
    (
      x: number,
    ) => Promise<
      | { readonly _tag: "success"; readonly data: string }
      | { readonly _tag: "FooError"; readonly reason: string }
    >
  >
>;

type _test_effect_factory_plain = Expect<
  Equal<RouterProxy<InferredEffectRouter>["plain"], () => Promise<boolean>>
>;

// ============================
// EventProxy type tests
// ============================

// --- Flat event is subscribable ---

type FlatEvents = {
  ping: { ts: number };
};

type _test_event_flat_subscribable =
  EventProxy<FlatEvents>["ping"] extends {
    subscribe: (cb: (data: { ts: number }) => void) => () => void;
  }
    ? true
    : false;

type _test_event_flat = Expect<Equal<_test_event_flat_subscribable, true>>;

// --- Nested events are subscribable at leaves ---

type NestedEvents = {
  chat: {
    messageReceived: { viewId: string; content: string };
    typing: { userId: string };
  };
};

type _test_event_nested_subscribable =
  EventProxy<NestedEvents>["chat"]["messageReceived"] extends {
    subscribe: (cb: (data: { viewId: string; content: string }) => void) => () => void;
  }
    ? true
    : false;

type _test_event_nested = Expect<Equal<_test_event_nested_subscribable, true>>;

// --- Primitive event payload ---

type MixedEvents = {
  view: {
    tabChanged: { tabs: string[] };
  };
  simple: number;
};

type _test_event_primitive = Expect<
  Equal<
    EventProxy<MixedEvents>["simple"],
    { subscribe: (cb: (data: number) => void) => () => void }
  >
>;

// --- Deeply nested events ---

type DeepEvents = {
  a: {
    b: {
      c: { value: boolean };
    };
  };
};

type _test_event_deep_subscribable =
  EventProxy<DeepEvents>["a"]["b"]["c"] extends {
    subscribe: (cb: (data: { value: boolean }) => void) => () => void;
  }
    ? true
    : false;

type _test_event_deep = Expect<Equal<_test_event_deep_subscribable, true>>;

// --- Subscribe returns unsubscribe function ---

type _test_event_unsub_return =
  ReturnType<EventProxy<FlatEvents>["ping"]["subscribe"]> extends () => void
    ? true
    : false;

type _test_event_unsub = Expect<Equal<_test_event_unsub_return, true>>;

// --- Namespace level is navigable ---

type _test_event_namespace_nav =
  EventProxy<NestedEvents>["chat"] extends {
    messageReceived: { subscribe: (...args: any[]) => any };
    typing: { subscribe: (...args: any[]) => any };
  }
    ? true
    : false;

type _test_event_namespace = Expect<Equal<_test_event_namespace_nav, true>>;

// ============================
// ExtractRequirements type tests
// ============================

type SvcA = { readonly _tag: "SvcA" };
type SvcB = { readonly _tag: "SvcB" };

// --- Extracts requirements from Effect-returning methods ---

type RouterWithDeps = {
  foo: () => Effect.Effect<number, never, SvcA>;
  bar: (x: string) => Effect.Effect<string, never, SvcB>;
};

type _test_extract_deps = Expect<
  Equal<ExtractRequirements<RouterWithDeps>, SvcA | SvcB>
>;

// --- Extracts requirements from nested routers ---

type NestedRouterWithDeps = {
  top: () => Effect.Effect<number, never, SvcA>;
  nested: {
    deep: () => Effect.Effect<string, never, SvcB>;
  };
};

type _test_extract_nested = Expect<
  Equal<ExtractRequirements<NestedRouterWithDeps>, SvcA | SvcB>
>;

// --- No requirements from plain methods ---

type PlainRouter = {
  sync: () => string;
  async: () => Promise<number>;
};

type _test_extract_plain = Expect<
  Equal<ExtractRequirements<PlainRouter>, never>
>;

// --- Mixed plain and Effect methods ---

type MixedDepsRouter = {
  plain: () => string;
  effectful: () => Effect.Effect<number, never, SvcA>;
};

type _test_extract_mixed = Expect<
  Equal<ExtractRequirements<MixedDepsRouter>, SvcA | never>
>;

// --- Effect with no requirements ---

type NoReqRouter = {
  safe: () => Effect.Effect<number, never, never>;
};

type _test_extract_no_req = Expect<
  Equal<ExtractRequirements<NoReqRouter>, never>
>;

// ============================
// UnifiedEventProxy type tests
// ============================

// --- Flat event is both callable and subscribable ---

type _test_unified_flat_callable =
  UnifiedEventProxy<FlatEvents>["ping"] extends (data: { ts: number }) => void
    ? true
    : false;

type _test_unified_flat_call = Expect<Equal<_test_unified_flat_callable, true>>;

type _test_unified_flat_sub =
  UnifiedEventProxy<FlatEvents>["ping"] extends {
    subscribe: (cb: (data: { ts: number }) => void) => () => void;
  }
    ? true
    : false;

type _test_unified_flat_subscribe = Expect<Equal<_test_unified_flat_sub, true>>;

// --- Nested unified events are callable + subscribable at leaves ---

type _test_unified_nested_callable =
  UnifiedEventProxy<NestedEvents>["chat"]["messageReceived"] extends (
    data: { viewId: string; content: string },
  ) => void
    ? true
    : false;

type _test_unified_nested_call = Expect<Equal<_test_unified_nested_callable, true>>;

type _test_unified_nested_sub =
  UnifiedEventProxy<NestedEvents>["chat"]["messageReceived"] extends {
    subscribe: (
      cb: (data: { viewId: string; content: string }) => void,
    ) => () => void;
  }
    ? true
    : false;

type _test_unified_nested_subscribe = Expect<Equal<_test_unified_nested_sub, true>>;

// --- UnifiedEventProxy is assignable to EventProxy (backward compat) ---

type _test_unified_compat =
  UnifiedEventProxy<FlatEvents> extends EventProxy<FlatEvents>
    ? true
    : false;

type _test_unified_backward_compat = Expect<Equal<_test_unified_compat, true>>;

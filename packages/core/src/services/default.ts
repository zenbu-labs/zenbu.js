/**
 * Import every default service. Each module's top-level side effect is
 * `runtime.register(<Class>, import.meta)`; the actual `evaluate()`
 * lifecycle is driven by `runtime` based on the dependency graph, so
 * import order doesn't matter for correctness.
 *
 * Imports run in parallel via `Promise.all` because `runtime` will
 * sequence their actual `evaluate()` calls based on the dependency
 * graph anyway. The bootTrace spans surface per-import cost.
 */

export async function defaultServices(): Promise<void> {
  const { bootTrace } = await import("../boot-trace");
  await Promise.all([
    bootTrace.span("import:./boot-trace", () => import("./boot-trace")),
    bootTrace.span("import:./server", () => import("./server")),
    bootTrace.span("import:./vite", () => import("./vite")),
    bootTrace.span("import:./http", () => import("./http")),
    bootTrace.span("import:./db", () => import("./db")),
    bootTrace.span("import:./base-window", () => import("./base-window")),
    bootTrace.span("import:./rpc", () => import("./rpc")),
    bootTrace.span("import:./window", () => import("./window")),
    bootTrace.span("import:./advice-config", () => import("./advice-config")),
    bootTrace.span("import:./updater", () => import("./updater")),
    bootTrace.span("import:./plugin-updater", () => import("./plugin-updater")),
    bootTrace.span("import:./shortcuts", () => import("./shortcuts")),
    bootTrace.span("import:./plugin-manager", () => import("./plugin-manager")),
  ]);
}

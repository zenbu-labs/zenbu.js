/**
 * Import every default service. Each module's top-level side effect is
 * `runtime.register(<Class>, import.meta)`; the actual `evaluate()`
 * lifecycle is driven by `runtime` based on the dependency graph, so
 * import order doesn't matter for correctness.
 *
 * Imports are sequential (not Promise.all). We tried parallelizing and
 * it made boot SLOWER — the heavy services (DbService import pulls in
 * parcel-watcher's native module + effect, ReloaderService imports the
 * whole Vite bundle) compete for CPU and starve the `renderer-host`
 * warmup that runs immediately after, blowing it up from ~220ms to
 * ~1400ms. Until the warmup runs off the critical path, serial imports
 * keep total wall-clock lower.
 */

export async function defaultServices(): Promise<void> {
  const { bootTrace } = await import("../boot-trace");
  await Promise.all([
    bootTrace.span("import:./boot-trace", () => import("./boot-trace")),
    bootTrace.span("import:./server", () => import("./server")),
    bootTrace.span("import:./reloader", () => import("./reloader")),
    bootTrace.span("import:./renderer-host", () => import("./renderer-host")),
    bootTrace.span("import:./http", () => import("./http")),
    bootTrace.span("import:./db", () => import("./db")),
    bootTrace.span("import:./base-window", () => import("./base-window")),
    bootTrace.span("import:./rpc", () => import("./rpc")),
    bootTrace.span("import:./window", () => import("./window")),
    bootTrace.span("import:./advice-config", () => import("./advice-config")),
    bootTrace.span("import:./updater", () => import("./updater")),
    bootTrace.span("import:./plugin-updater", () => import("./plugin-updater")),
    bootTrace.span("import:./shortcuts", () => import("./shortcuts")),
  ]);
}

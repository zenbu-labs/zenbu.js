import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  addAdvice,
  addAdviceTarget,
  addInjection,
  type AdviceSpec,
  type InjectionSpec,
} from "./services/advice-config";
import { bootTrace } from "./boot-trace";

/**
 * The synthetic plugin name used for everything that ships inside
 * `@zenbujs/core`. Mirrors the `core` DB section so RPC, events, and the
 * database all use the same top-level namespace.
 */
export const CORE_PLUGIN_NAME = "core";

export type CleanupReason = "reload" | "shutdown";
type SetupCleanup = ((reason: CleanupReason) => void | Promise<void>) | void;
type SetupFn = () => SetupCleanup;

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;

function readShutdownTimeoutMs(): number {
  const raw = process.env.ZENBU_SHUTDOWN_TIMEOUT_MS;
  if (!raw) return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_SHUTDOWN_TIMEOUT_MS;
}

interface HotContext {
  accept(): void;
  dispose(cb: (data: any) => void | Promise<void>): void;
  prune?(cb: () => void | Promise<void>): void;
  data?: any;
}

interface ServiceSlot {
  error: unknown | null;
  instance: Service | null;
  ServiceClass: ServiceConstructor;
  status: "blocked" | "evaluating" | "ready" | "failed";
  /**
   * Absolute directory of the plugin that owns this service file, resolved
   * once at `runtime.register` time from the registering module's
   * `import.meta.url`. `null` for core-package services that are not
   * declared inside any plugin (`@zenbujs/core/services/*`). Read by
   * `Service#advise` / `Service#contentScript` to anchor relative paths
   * without forcing user code to pass `import.meta`.
   */
  pluginDir: string | null;
}

type AnyServiceClass = (abstract new (...args: any[]) => Service) & {
  key: string;
};
type DepEntry = AnyServiceClass | string;

type DepInstance<D> = D extends AnyServiceClass ? InstanceType<D> : unknown;

type ResolveCtx<TDeps> = { [K in keyof TDeps]: DepInstance<TDeps[K]> };

function resolveDepKey(entry: DepEntry): string {
  if (typeof entry === "string") return entry;
  return entry.key;
}

/**
 * A concrete service class registered with the runtime. Always has a
 * `static key` (set by `Service.create`) and an optional `static deps`
 * map. Used as the parameter type of `runtime.register`.
 */
export type ServiceConstructor = (new (...args: any[]) => Service) & {
  key: string;
  deps?: Record<string, DepEntry>;
};

export abstract class Service {
  static deps: Record<string, DepEntry> = {};

  /**
   * Define a Service base class with `static key`, `static deps`, and a typed
   * `this.ctx`; extend it and add your `evaluate()` body.
   *
   *     export class WindowService extends Service.create({
   *       key: "window",
   *       deps: { http: HttpService },
   *     }) {}
   *
   * For dynamic / optional access to another service, use
   * `runtime.get(SomeService, cb)` instead of declaring it in `deps`.
   */
  static create<
    TKey extends string,
    TDeps extends Record<string, DepEntry> = {},
  >(config: { key: TKey; deps?: TDeps }) {
    const { key, deps } = config;
    const resolvedDeps = (deps ?? {}) as Record<string, DepEntry>;
    abstract class ConfiguredService extends Service {
      static key = key;
      static deps = resolvedDeps;
      declare ctx: ResolveCtx<TDeps>;
    }
    return ConfiguredService;
  }

  ctx: any;

  /** @internal */
  __setupCleanups: Map<
    string,
    (reason: CleanupReason) => void | Promise<void>
  > = new Map();

  evaluate(): void | Promise<void> {}

  /**
   * Inject a named module export into the renderer's injection
   * registry. Read via `useInjection(name)` / `useInjections({ kind })`
   * or rendered via `<View name="…" />`. No `meta` = side-effect-only
   * (old content-script pattern). Returns a sync dispose; wrap in
   * `this.setup(...)`.
   */
  inject(spec: InjectionSpec): () => void {
    const pluginDir = this.__getPluginDir("inject");
    // Icon lookup: search the owning plugin's manifest for a key
    // matching the injection name. Plugins own their own icons —
    // there's no cross-plugin fallback. If you want an icon on
    // your injection, ship it in your plugin's `icons:` map.
    let resolvedSpec = spec;
    const owningPlugin = getPlugins().find((p) => p.dir === pluginDir);
    const iconSvg = owningPlugin?.icons?.[spec.name];
    if (iconSvg && spec.meta?.icon === undefined) {
      resolvedSpec = {
        ...spec,
        meta: { ...(spec.meta ?? {}), icon: iconSvg },
      };
    }
    return addInjection(pluginDir, resolvedSpec);
  }

  /**
   * Wrap another module's export. Sugar over `inject` with
   * `meta.kind: "advice"`; the prelude routes advice entries through
   * `@zenbu/advice/runtime` instead of the injection registry.
   */
  advise(spec: AdviceSpec): () => void {
    const pluginDir = this.__getPluginDir("advise");
    return addAdvice(pluginDir, spec);
  }

  /**
   * Declare a stable advice-target id for a component this plugin
   * owns. Advisers can then `advise({ target: id, ... })` instead of
   * matching module-path suffixes, so moving the file only requires
   * updating this one registration. Returns a disposer; wrap in
   * `this.setup(...)` like any registration.
   */
  adviceTarget(
    id: string,
    target: { moduleId: string; name: string },
  ): () => void {
    return addAdviceTarget(id, target);
  }

  /** @internal */
  __getPluginDir(method: string): string {
    const ctor = this.constructor as { key?: string; name?: string };
    const key = ctor.key;
    const slot = key ? runtime.getSlot(key) : undefined;
    const dir = slot?.pluginDir ?? null;
    if (!dir) {
      const label = ctor.name ?? key ?? "<anonymous>";
      throw new Error(
        `[runtime] Service "${label}" called this.${method}() but its slot has no pluginDir. ` +
          `This service was registered from a file outside any plugin's directory; ` +
          `${method}() is only valid for services declared inside a plugin.`,
      );
    }
    return dir;
  }

  setup(key: string, fn: SetupFn): void {
    const existing = this.__setupCleanups.get(key);
    if (existing) {
      try {
        existing("reload");
      } catch (e) {
        console.error(`[hot] setup cleanup "${key}" failed:`, e);
      }
    }
    const cleanup = fn();
    if (cleanup) {
      this.__setupCleanups.set(key, cleanup);
    } else {
      this.__setupCleanups.delete(key);
    }
  }

  /**
   * Wrap `fn` in a boot-trace span scoped to this service's key. The
   * generated span's `parent` is `service:<key>`, so it nests under the
   * service's row in the flame graph.
   */
  trace<T>(
    name: string,
    fn: () => T | Promise<T>,
    meta?: Record<string, unknown>,
  ): Promise<T> {
    return bootTrace.span(name, fn, meta);
  }

  traceSync<T>(name: string, fn: () => T, meta?: Record<string, unknown>): T {
    return bootTrace.spanSync(name, fn, meta);
  }

  /** @internal */
  async __cleanupAllSetups(reason: CleanupReason = "shutdown") {
    for (const [key, cleanup] of this.__setupCleanups) {
      try {
        await cleanup(reason);
      } catch (e) {
        console.error(`[hot] setup cleanup "${key}" failed:`, e);
      }
    }
    this.__setupCleanups.clear();
  }
}

const SERVICE_BASE_METHODS = new Set(
  Object.getOwnPropertyNames(Service.prototype),
);

export class ServiceRuntime {
  private definitions = new Map<string, ServiceConstructor>();
  private dependentsIndex = new Map<string, Set<string>>();
  private dirtyKeys = new Set<string>();
  private drainError: unknown = null;
  private draining: Promise<void> | null = null;
  private registrationTokens = new Map<string, symbol>();
  private slots = new Map<string, ServiceSlot>();
  private onReconciledCallbacks: Array<(changedKeys: string[]) => void> = [];
  private subscribers = new Map<
    string,
    Set<(instance: Service | undefined) => void>
  >();

  register(
    ServiceClass: ServiceConstructor,
    importMeta?: ImportMeta | null,
  ): void {
    const hot: HotContext | null = (importMeta as any)?.hot ?? null;
    const slotKey = ServiceClass.key;
    if (typeof slotKey !== "string" || slotKey.length === 0) {
      const name = (ServiceClass as { name?: string }).name ?? "<anonymous>";
      throw new Error(
        `[runtime] service "${name}" is missing \`static key\`. ` +
          `Define it via \`Service.create({ key: "...", ... })\`.`,
      );
    }

    const metaUrl = (importMeta as { url?: string } | null | undefined)?.url;
    const pluginDir = metaUrl ? findOwningPluginDir(metaUrl) : null;

    this.definitions.set(slotKey, ServiceClass);
    const slot = this.slots.get(slotKey);
    if (slot) {
      slot.ServiceClass = ServiceClass;
      // Re-stamp on HMR so a service file moved between plugins (rare, but
      // possible during refactors) doesn't keep pointing at its old root.
      slot.pluginDir = pluginDir;
    } else {
      this.slots.set(slotKey, {
        error: null,
        instance: null,
        ServiceClass,
        status: "blocked",
        pluginDir,
      });
    }
    this.rebuildDependentsIndex();

    hot?.accept();
    const token = Symbol(slotKey);
    this.registrationTokens.set(slotKey, token);
    hot?.prune?.(() => {
      this.unregister(slotKey, token);
    });

    void this.scheduleReconcile([slotKey]);
  }

  getAllKeys(): string[] {
    return [...this.slots.keys()];
  }

  getSlot(key: string): ServiceSlot | undefined {
    return this.slots.get(key);
  }

  async whenIdle(): Promise<void> {
    while (this.draining) {
      await this.draining;
    }
    if (this.drainError) {
      const error = this.drainError;
      this.drainError = null;
      throw error;
    }
  }

  async reloadAll(): Promise<void> {
    const keys = [...this.slots.keys()];
    if (keys.length === 0) return;
    await this.scheduleReconcile(keys);
    await this.whenIdle();
  }

  /**
   * Reload a single service by key. No-op if the key is not registered.
   * Used by infrastructure that watches resources outside dynohot's
   * import-graph (e.g. the migrations directory watcher in DbService) and
   * needs to nudge a specific service to re-evaluate without leaning on
   * the devtools-only `__zenbu_dev__.reloadService` hook.
   */
  async reload(key: string): Promise<void> {
    if (!this.slots.has(key)) return;
    await this.scheduleReconcile([key]);
    await this.whenIdle();
  }

  async shutdown(): Promise<void> {
    try {
      await this.whenIdle();
    } catch (error) {
      console.error("[hot] runtime idle wait failed during shutdown:", error);
    }

    const keys = [...this.slots.keys()].reverse();
    for (const key of keys) {
      await this.teardownService(key, { removeSlot: true });
    }
    this.definitions.clear();
    this.dependentsIndex.clear();
    this.dirtyKeys.clear();
    this.registrationTokens.clear();
  }

  /**
   * Subscribe to a service. Behavior-subject style: the callback fires
   * synchronously once with the current value (the live instance if ready,
   * `undefined` otherwise), then again on every reconcile of that service —
   * so you see the new instance after each HMR. Pass through `undefined`
   * when the service tears down or unregisters.
   *
   * Returns an unsubscribe function. Always call it from a `setup()` cleanup
   * (or wherever you'd otherwise leak callbacks across reloads).
   */
  get<T extends Service>(
    ref: { key: string },
    cb: (instance: T | undefined) => void,
  ): () => void {
    const key = ref.key;
    let subs = this.subscribers.get(key);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(key, subs);
    }
    const wrapped = cb as (instance: Service | undefined) => void;
    subs.add(wrapped);

    const slot = this.slots.get(key);
    const current =
      slot?.status === "ready" && slot.instance ? (slot.instance as T) : undefined;
    try {
      cb(current);
    } catch (e) {
      console.error(`[hot] runtime.get subscriber for "${key}" threw:`, e);
    }

    return () => {
      const set = this.subscribers.get(key);
      if (!set) return;
      set.delete(wrapped);
      if (set.size === 0) this.subscribers.delete(key);
    };
  }

  private fireSubscribers(key: string): void {
    const subs = this.subscribers.get(key);
    if (!subs || subs.size === 0) return;
    const slot = this.slots.get(key);
    const instance =
      slot?.status === "ready" && slot.instance ? slot.instance : undefined;
    for (const cb of [...subs]) {
      try {
        cb(instance);
      } catch (e) {
        console.error(`[hot] runtime.get subscriber for "${key}" threw:`, e);
      }
    }
  }

  /**
   * Build a 3-level router keyed by plugin name → service key → method.
   * Mirrors how the database is sectioned (`root.<plugin>.<field>`) so a
   * service's RPC surface lives under its owning plugin's namespace
   * instead of polluting the top level. Core services bucket under
   * `"core"` because the core package is registered as a synthetic
   * plugin (see `getPluginRegistry`).
   */
  buildRouter(): Record<
    string,
    Record<string, Record<string, (...args: any[]) => any>>
  > {
    const router: Record<
      string,
      Record<string, Record<string, (...args: any[]) => any>>
    > = {};

    for (const [slotKey, slot] of this.slots) {
      if (slot.status !== "ready" || !slot.instance) continue;
      const proto = Object.getPrototypeOf(slot.instance);
      const methods: Record<string, (...args: any[]) => any> = {};

      for (const name of Object.getOwnPropertyNames(proto)) {
        if (SERVICE_BASE_METHODS.has(name)) continue;
        if (name.startsWith("_")) continue;
        const desc = Object.getOwnPropertyDescriptor(proto, name);
        if (!desc || typeof desc.value !== "function") continue;
        const instance = slot.instance as any;
        methods[name] = (...args: any[]) => instance[name](...args);
      }

      if (Object.keys(methods).length === 0) continue;

      const pluginName = pluginNameForDir(slot.pluginDir);
      const bucket = (router[pluginName] ??= {});
      bucket[slotKey] = methods;
    }
    return router;
  }

  onReconciled(cb: (changedKeys: string[]) => void): () => void {
    this.onReconciledCallbacks.push(cb);
    return () => {
      const idx = this.onReconciledCallbacks.indexOf(cb);
      if (idx >= 0) this.onReconciledCallbacks.splice(idx, 1);
    };
  }

  private resolveDepSlot(depKey: string): ServiceSlot | undefined {
    return this.slots.get(depKey);
  }

  private injectCtx(
    instance: Service,
    ServiceClass: ServiceConstructor,
  ): void {
    const deps = ServiceClass.deps ?? {};
    const ctx: Record<string, Service> = {};
    for (const [name, entry] of Object.entries(deps)) {
      const key = resolveDepKey(entry);
      const slot = this.resolveDepSlot(key);
      if (!slot || slot.status !== "ready" || !slot.instance) {
        throw new Error(
          `Dependency "${key}" not ready for "${ServiceClass.key}"`,
        );
      }
      ctx[name] = slot.instance;
    }
    (instance as any).ctx = ctx;
  }

  private rebuildDependentsIndex(): void {
    const next = new Map<string, Set<string>>();
    for (const [slotKey, ServiceClass] of this.definitions) {
      const deps = ServiceClass.deps ?? {};
      for (const entry of Object.values(deps)) {
        const depKey = resolveDepKey(entry);
        const dependents = next.get(depKey) ?? new Set<string>();
        dependents.add(slotKey);
        next.set(depKey, dependents);
      }
    }
    this.dependentsIndex = next;
  }

  private getAffectedKeys(changedKeys: Iterable<string>): string[] {
    const affected = new Set<string>();
    const visit = (key: string) => {
      if (affected.has(key)) return;
      affected.add(key);
      for (const dependent of this.dependentsIndex.get(key) ?? []) {
        visit(dependent);
      }
    };
    for (const key of changedKeys) {
      visit(key);
    }
    return [...affected].filter((key) => this.definitions.has(key));
  }

  private listMissingDeps(ServiceClass: ServiceConstructor): string[] {
    const deps = ServiceClass.deps ?? {};
    const missing: string[] = [];
    for (const entry of Object.values(deps)) {
      const key = resolveDepKey(entry);
      const slot = this.resolveDepSlot(key);
      if (!slot || slot.status !== "ready" || !slot.instance) {
        missing.push(key);
      }
    }
    return missing;
  }

  private ensureSlot(
    key: string,
    ServiceClass: ServiceConstructor,
  ): ServiceSlot {
    const existing = this.slots.get(key);
    if (existing) return existing;
    const slot: ServiceSlot = {
      error: null,
      instance: null,
      ServiceClass,
      status: "blocked",
      pluginDir: null,
    };
    this.slots.set(key, slot);
    return slot;
  }

  private async teardownService(
    key: string,
    options: { removeSlot?: boolean; reason?: CleanupReason } = {},
  ): Promise<void> {
    const slot = this.slots.get(key);
    if (!slot) return;

    const instance = slot.instance;
    slot.instance = null;
    slot.status = "blocked";
    slot.error = null;

    if (instance) {
      const reason = options.reason ?? "shutdown";
      // Bound each service's cleanup. A pty/socket/watcher whose drain
      // never resolves must not wedge the entire shutdown — emit a loud
      // log and proceed. Tune via ZENBU_SHUTDOWN_TIMEOUT_MS.
      const timeoutMs = readShutdownTimeoutMs();
      const cleanup = instance.__cleanupAllSetups(reason);
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.error(
            `[hot] ${key} ${reason} cleanup timed out after ${timeoutMs}ms; forcing teardown`,
          );
          resolve();
        }, timeoutMs);
        timer.unref?.();
      });
      try {
        await Promise.race([cleanup, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    if (options.removeSlot) {
      this.slots.delete(key);
    }
  }

  private async unregister(key: string, token: symbol): Promise<void> {
    if (this.registrationTokens.get(key) !== token) return;

    this.registrationTokens.delete(key);
    this.definitions.delete(key);
    await this.teardownService(key, { removeSlot: true });
    this.rebuildDependentsIndex();
    // Notify subscribers that the service is gone before dependents reconcile.
    this.fireSubscribers(key);
    await this.scheduleReconcile([key]);
  }

  private async scheduleReconcile(keys: Iterable<string>): Promise<void> {
    for (const key of keys) {
      this.dirtyKeys.add(key);
    }

    if (this.draining) {
      return this.draining;
    }

    this.draining = (async () => {
      try {
        while (this.dirtyKeys.size > 0) {
          const batch = [...this.dirtyKeys];
          this.dirtyKeys.clear();
          await this.reconcileBatch(batch);
        }
      } catch (error) {
        this.drainError = error;
        console.error("[hot] runtime reconcile failed:", error);
      } finally {
        this.draining = null;
        if (this.dirtyKeys.size > 0) {
          void this.scheduleReconcile([]);
        } else {
          this.scheduleBlockedDiagnostic();
        }
      }
    })();

    return this.draining;
  }

  private blockedDiagnosticTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * A service whose dep key never resolves stays `blocked` forever —
   * historically with no signal at all unless it had been ready before
   * a hot reload. That silent no-op is how a typo'd string-key dep (or
   * a disabled plugin) turns into "feature mysteriously does nothing".
   * After the runtime goes idle, give stragglers a grace period, then
   * name them loudly with WHY each dep is missing.
   */
  private scheduleBlockedDiagnostic(): void {
    if (this.blockedDiagnosticTimer) clearTimeout(this.blockedDiagnosticTimer);
    this.blockedDiagnosticTimer = setTimeout(() => {
      this.blockedDiagnosticTimer = null;
      if (this.draining || this.dirtyKeys.size > 0) return; // another batch is in flight
      for (const [key, slot] of this.slots) {
        if (slot.status !== "blocked") continue;
        const ServiceClass = this.definitions.get(key);
        if (!ServiceClass) continue;
        const reasons = this.listMissingDeps(ServiceClass).map((dep) => {
          const depSlot = this.resolveDepSlot(dep);
          if (!depSlot && !this.definitions.has(dep)) {
            return `"${dep}" (no service registered under this key — typo in a string-key dep, or the owning plugin is disabled)`;
          }
          if (depSlot?.status === "failed") {
            return `"${dep}" (failed to evaluate — see its error above)`;
          }
          return `"${dep}" (still ${depSlot?.status ?? "unregistered"})`;
        });
        if (reasons.length === 0) continue;
        console.warn(
          `[runtime] service "${key}" is blocked waiting on: ${reasons.join(", ")}. ` +
            `Its RPC surface and evaluate() side effects are NOT active.`,
        );
      }
    }, 5000);
    // Don't keep the process alive just for diagnostics.
    this.blockedDiagnosticTimer?.unref?.();
  }

  private async reconcileBatch(changedKeys: readonly string[]): Promise<void> {
    const affectedKeys = this.getAffectedKeys(changedKeys);
    if (affectedKeys.length === 0) return;

    const affected = new Map<string, ServiceConstructor>();
    for (const key of affectedKeys) {
      const ServiceClass = this.definitions.get(key);
      if (ServiceClass) {
        affected.set(key, ServiceClass);
      }
    }

    const levels = this.topologicalLevels(affected);

    // Snapshot which keys were previously ready so reconcileKey can gate the
    // "waiting on deps" log (Phase 1 nulls out the instance, erasing that signal).
    const wasReady = new Set<string>();
    for (const key of affectedKeys) {
      if (this.slots.get(key)?.status === "ready") wasReady.add(key);
    }

    // Phase 1: tear down all affected in REVERSE topo order (dependents before
    // dependencies). Full teardown — not just setup-cleanup — so each service
    // gets a fresh instance in Phase 2. We deliberately do NOT carry instance
    // state across reconciles: there is no migration hook, so reusing a stale
    // instance with a swapped prototype is a correctness footgun.
    for (const level of [...levels].reverse()) {
      await Promise.all(
        level.map((key) => this.teardownService(key, { reason: "reload" })),
      );
    }

    // Phase 2: re-evaluate in forward topo order (dependencies before dependents)
    for (const level of levels) {
      await Promise.all(level.map((key) => this.reconcileKey(key, wasReady)));
    }

    // Notify per-service subscribers (`runtime.get(ref, cb)`) with the new
    // instance — or `undefined` if the slot ended up not-ready.
    for (const key of affectedKeys) {
      this.fireSubscribers(key);
    }

    if (affectedKeys.length > 0) {
      for (const cb of this.onReconciledCallbacks) {
        try {
          cb(affectedKeys);
        } catch (e) {
          console.error("[hot] onReconciled callback failed:", e);
        }
      }
    }
  }

  private async reconcileKey(
    key: string,
    wasReady: ReadonlySet<string>,
  ): Promise<void> {
    const ServiceClass = this.definitions.get(key);
    if (!ServiceClass) return;

    const slot = this.ensureSlot(key, ServiceClass);
    slot.ServiceClass = ServiceClass;

    const missingDeps = this.listMissingDeps(ServiceClass);
    if (missingDeps.length > 0) {
      await this.teardownService(key, { reason: "reload" });
      if (wasReady.has(key)) {
        console.log(`[hot] ${key} waiting on: ${missingDeps.join(", ")}`);
      }
      return;
    }

    const instance = new (ServiceClass as any)();
    slot.instance = instance;
    slot.status = "evaluating";
    slot.error = null;

    try {
      this.injectCtx(instance, ServiceClass);
      // Wrap evaluate() in a boot-trace span so each service is one row
      // in the flame. Top-level `parent` is null which puts it under
      // whatever main-process phase the runtime was scheduled from
      // (default-services / plugin-controller-main).
      await bootTrace.span(`service:${key}`, () => instance.evaluate());
      slot.status = "ready";
    } catch (e) {
      slot.status = "failed";
      slot.error = e;
      console.error(`[hot] ${key} failed to evaluate:`, e);
    }
  }

  private topologicalLevels(
    services: Map<string, ServiceConstructor>,
  ): string[][] {
    const keys = new Set(services.keys());
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const key of keys) {
      inDegree.set(key, 0);
      dependents.set(key, []);
    }

    for (const [slotKey, ServiceClass] of services) {
      const deps = ServiceClass.deps ?? {};
      let degree = 0;
      for (const entry of Object.values(deps)) {
        const depKey = resolveDepKey(entry);
        if (keys.has(depKey)) {
          degree++;
          dependents.get(depKey)!.push(slotKey);
        }
      }
      inDegree.set(slotKey, degree);
    }

    const levels: string[][] = [];
    let queue = [...keys].filter((k) => inDegree.get(k) === 0);

    while (queue.length > 0) {
      levels.push(queue);
      const next: string[] = [];
      for (const key of queue) {
        for (const dep of dependents.get(key)!) {
          const d = inDegree.get(dep)! - 1;
          inDegree.set(dep, d);
          if (d === 0) next.push(dep);
        }
      }
      queue = next;
    }

    const resolved = levels.flat();
    if (resolved.length !== keys.size) {
      const missing = [...keys].filter((k) => !resolved.includes(k));
      throw new Error(
        `Circular dependency detected involving: ${missing.join(", ")}`,
      );
    }

    return levels;
  }
}
// Process-singleton. On hot reload of THIS file, dynohot re-evaluates the
// module but we keep the existing instance (so registered services survive)
// and `setPrototypeOf` rebinds it to the fresh prototype, so new methods on
// ServiceRuntime take effect without a process restart.

/**
 * Devtools-only handles on `globalThis.__zenbu_dev__`, kept off the public
 * `ServiceRuntime` autocomplete surface. Lives here because it reaches into
 * private internals (`scheduleReconcile`) inside the encapsulation boundary.
 */
function installDevHook(rt: ServiceRuntime): void {
  const internals = rt as unknown as {
    definitions: Map<string, unknown>;
    scheduleReconcile: (keys: string[]) => Promise<void>;
  };
  (globalThis as any).__zenbu_dev__ = {
    reloadService: async (key: string): Promise<void> => {
      if (!internals.definitions.has(key)) {
        throw new Error(`No service registered for key "${key}"`);
      }
      await internals.scheduleReconcile([key]);
      await rt.whenIdle();
    },
  };
}

export const runtime: ServiceRuntime = (() => {
  const existing = (globalThis as any).__zenbu_service_runtime__ as
    | ServiceRuntime
    | undefined;
  if (existing) {
    Object.setPrototypeOf(existing, ServiceRuntime.prototype);
    installDevHook(existing);
    return existing;
  }
  const fresh = new ServiceRuntime();
  (globalThis as any).__zenbu_service_runtime__ = fresh;
  installDevHook(fresh);
  return fresh;
})();

// Plugin / app-entrypoint registry. Single source of truth for plugin
// metadata at runtime, populated by the generated barrel (`loaders/zenbu.ts`)
// before any plugin's service files import. Module-singleton via
// `globalThis.__zenbu_plugin_registry__` so HMR of this file keeps contents.

/**
 * A plugin manifest after the loader has resolved every relative path to
 * absolute. Mirrors `ResolvedPlugin` in `cli/lib/build-config.ts` but is
 * declared inline here to avoid runtime.ts importing CLI code.
 */
export interface PluginRecord {
  name: string;
  dir: string;
  services: string[];
  schemaPath?: string;
  migrationsPath?: string;
  preloadPath?: string;
  eventsPath?: string;
  icons?: Record<string, string>;

  args?: unknown;
}

interface ConfigSubscriberEntry {
  fn: (snapshot: ConfigSnapshot) => void;
 
  label: string;
}

interface PluginRegistry {
  plugins: Map<string, PluginRecord>;
  /** Absolute path of the renderer entrypoint directory, or null until registered. */
  appEntrypoint: string | null;
  /** Absolute path of `splash.html` inside the entrypoint dir. */
  splashPath: string | null;
  /** Subscribers that fire on every replacePlugins / registerAppEntrypoint. */
  subscribers: Set<ConfigSubscriberEntry>;
}
let configSubscriberSeq = 0;

/**
 * Live snapshot of the resolved Zenbu config. Returned by `getConfig()` and
 * delivered to `subscribeConfig` callbacks. Re-emitted whenever the loader
 * regenerates the plugin barrel — i.e. on every edit to `zenbu.config.ts`
 * or any imported `zenbu.plugin.ts`.
 */
export interface ConfigSnapshot {
  plugins: PluginRecord[];
  /** Absolute path of the renderer entrypoint directory. */
  appEntrypoint: string | null;
  /** Absolute path of `splash.html` inside the entrypoint dir. */
  splashPath: string | null;
}

function getPluginRegistry(): PluginRegistry {
  const slot = globalThis as unknown as {
    __zenbu_plugin_registry__?: PluginRegistry;
  };
  if (!slot.__zenbu_plugin_registry__) {
    slot.__zenbu_plugin_registry__ = {
      plugins: new Map(),
      appEntrypoint: null,
      splashPath: null,
      subscribers: new Set(),
    };
    // Seed the synthetic core plugin so any `runtime.register` call from
    // a core service file (which happens BEFORE the loader-emitted barrel
    // runs `replacePlugins(...)`) can resolve its `pluginDir` and end up
    // bucketed under `"core"` in the router.
    seedCorePlugin(slot.__zenbu_plugin_registry__);
  } else if (!slot.__zenbu_plugin_registry__.subscribers) {
    // HMR'd into an older shape; lazily fill the field.
    slot.__zenbu_plugin_registry__.subscribers = new Set();
  }
  return slot.__zenbu_plugin_registry__;
}

/**
 * Walk up from this module's location until we hit the `@zenbujs/core`
 * package.json. Cached at first call. Same trick as `findCorePackageRoot`
 * in `services/db.ts`; consolidated here so the runtime can register
 * itself without round-tripping through a service file.
 */
let cachedCorePluginDir: string | null = null;
function getCorePluginDir(): string {
  if (cachedCorePluginDir) return cachedCorePluginDir;
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  while (dir !== path.dirname(dir)) {
    const pkgPath = path.join(dir, "package.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (parsed?.name === "@zenbujs/core") {
        cachedCorePluginDir = dir;
        return dir;
      }
    } catch {
      // missing/unparseable; keep climbing
    }
    dir = path.dirname(dir);
  }
  // Fallback: assume runtime.ts is at <core>/src/runtime.ts (or the
  // built equivalent at <core>/dist/runtime.mjs).
  cachedCorePluginDir = path.resolve(here, "..");
  return cachedCorePluginDir;
}

function seedCorePlugin(reg: PluginRegistry): void {
  if (reg.plugins.has(CORE_PLUGIN_NAME)) return;
  reg.plugins.set(CORE_PLUGIN_NAME, {
    name: CORE_PLUGIN_NAME,
    dir: getCorePluginDir(),
    services: [],
  });
}

/**
 * Resolve the plugin namespace that owns a given service slot's
 * `pluginDir`. Core services (and anything not declared inside a plugin)
 * fall back to `"core"`. Used by `buildRouter` to nest the runtime
 * router by plugin name.
 */
function pluginNameForDir(dir: string | null): string {
  if (!dir) return CORE_PLUGIN_NAME;
  for (const plugin of getPluginRegistry().plugins.values()) {
    if (plugin.dir === dir) return plugin.name;
  }
  return CORE_PLUGIN_NAME;
}

function snapshotConfig(reg: PluginRegistry): ConfigSnapshot {
  return {
    plugins: [...reg.plugins.values()],
    appEntrypoint: reg.appEntrypoint,
    splashPath: reg.splashPath,
  };
}

function notifySubscribers(reg: PluginRegistry): void {
  if (reg.subscribers.size === 0) return;
  const snapshot = snapshotConfig(reg);
  for (const sub of reg.subscribers) {
    try {
      sub.fn(snapshot);
    } catch (err) {
      console.error(`[zenbu config subscriber ${sub.label}] threw:`, err);
    }
  }
}

/**
 * Register a plugin's resolved manifest. Idempotent — replaces any existing
 * entry for the same `name`. Called by the loader-emitted barrel; user code
 * normally does not call this directly.
 */
export function registerPlugin(record: PluginRecord): void {
  const reg = getPluginRegistry();
  if (record.name === CORE_PLUGIN_NAME) {
    console.warn(
      `[zenbu] plugin name "${CORE_PLUGIN_NAME}" is reserved for the core package; ignoring registerPlugin`,
    );
    return;
  }
  reg.plugins.set(record.name, record);
  notifySubscribers(reg);
}

/**
 * Drop a plugin from the registry. Used when the loader regenerates the
 * barrel and needs to clear stale entries.
 */
export function unregisterPlugin(name: string): void {
  const reg = getPluginRegistry();
  if (!reg.plugins.delete(name)) return;
  notifySubscribers(reg);
}

/**
 * Replace the entire plugin set in one shot. The loader uses this on every
 * barrel regeneration so removed plugins disappear cleanly. The synthetic
 * `core` plugin is always reseeded after the clear so user records cannot
 * accidentally evict it (and a user record named `"core"` is rejected so
 * the namespace stays unambiguous).
 */
export function replacePlugins(records: PluginRecord[]): void {
  const reg = getPluginRegistry();
  reg.plugins.clear();
  seedCorePlugin(reg);
  for (const record of records) {
    if (record.name === CORE_PLUGIN_NAME) {
      console.warn(
        `[zenbu] plugin name "${CORE_PLUGIN_NAME}" is reserved for the core package; ignoring user plugin record`,
      );
      continue;
    }
    reg.plugins.set(record.name, record);
  }
  notifySubscribers(reg);
}

export function getPlugins(): PluginRecord[] {
  return [...getPluginRegistry().plugins.values()];
}

/**
 * Find the plugin whose `dir` contains the file at `metaUrl`. The plugin
 * registry (populated by the loader-emitted barrel before any service
 * file imports) is the source of truth — no filesystem walking. Returns
 * the plugin's absolute directory, or `null` if the file lives outside
 * every registered plugin (the framework's own `@zenbujs/core/services/*`
 * files take this branch and end up with `slot.pluginDir = null`).
 *
 * Picks the deepest matching plugin so a nested workspace plugin wins
 * over its parent.
 */
function findOwningPluginDir(metaUrl: string): string | null {
  let file: string;
  try {
    file = fileURLToPath(metaUrl);
  } catch {
    return null;
  }
  let bestMatch: { dir: string; depth: number } | null = null;
  for (const plugin of getPluginRegistry().plugins.values()) {
    const rel = path.relative(plugin.dir, file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const depth = plugin.dir.split(path.sep).length;
    if (!bestMatch || depth > bestMatch.depth) {
      bestMatch = { dir: plugin.dir, depth };
    }
  }
  return bestMatch?.dir ?? null;
}

export function getPlugin(name: string): PluginRecord | undefined {
  return getPluginRegistry().plugins.get(name);
}

/**
 * Set the renderer entrypoint directory + the absolute path to splash.html
 * inside it. Called once by the loader-emitted barrel. Consumers
 * (`view-registry`, `vite-plugins`, `setup-gate`'s splash window) read
 * via `getAppEntrypoint()` / `getSplashPath()`.
 */
export function registerAppEntrypoint(
  rendererDir: string,
  splashPath?: string | null,
): void {
  const reg = getPluginRegistry();
  reg.appEntrypoint = rendererDir;
  reg.splashPath = splashPath ?? null;
  notifySubscribers(reg);
}

export function getAppEntrypoint(): string | null {
  return getPluginRegistry().appEntrypoint;
}

export function getSplashPath(): string | null {
  return getPluginRegistry().splashPath;
}

/**
 * Snapshot of the current resolved config — plugins + entrypoints. Cheap;
 * just walks the in-memory registry. The returned object is a fresh copy,
 * safe to retain or pass through serialization boundaries.
 */
export function getConfig(): ConfigSnapshot {
  return snapshotConfig(getPluginRegistry());
}

/**
 * Subscribe to config changes. The callback fires:
 *   - immediately on subscription (with the current snapshot),
 *   - after each `replacePlugins(...)` / `registerPlugin(...)` /
 *     `registerAppEntrypoint(...)` call — i.e. every time the loader
 *     regenerates the plugin barrel after a `zenbu.config.ts` edit.
 *
 * Callback exceptions are logged and swallowed so one buggy subscriber
 * can't break others. The returned function unsubscribes.
 */
export function subscribeConfig(
  callback: (snapshot: ConfigSnapshot) => void,
  label?: string,
): () => void {
  const reg = getPluginRegistry();
  configSubscriberSeq += 1;
  const entry: ConfigSubscriberEntry = {
    fn: callback,
    label: label ?? `anon#${configSubscriberSeq}`,
  };
  reg.subscribers.add(entry);
  // Fire once with the current snapshot so callers can initialize from a
  // single place instead of `cb(getConfig()); subscribeConfig(cb)`.
  try {
    callback(snapshotConfig(reg));
  } catch (err) {
    console.error("[zenbu config subscriber] initial fire threw:", err);
  }
  return () => {
    reg.subscribers.delete(entry);
  };
}

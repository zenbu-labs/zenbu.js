import * as Effect from "effect/Effect";
import { Service, runtime } from "../runtime";
import { DbService } from "./db";
import { addFunctionSource } from "./advice-config";
import { createLogger } from "../shared/log";

const log = createLogger("function-registry");

/**
 * Opaque, JSON-serializable metadata attached to a registered function.
 * Surfaced verbatim to the renderer via `core.lastKnownFunctionRegistry`;
 * the renderer's `useFunctions` hook uses `meta` to filter — e.g.
 * `useFunctions({ kind: "cm.completion" })`. Conventions for keys are
 * up to the subsystem that defined the function point.
 */
export type FunctionMeta = Record<string, unknown> & {
  kind?: string;
  label?: string;
};

interface FunctionEntry {
  name: string;
  meta?: FunctionMeta;
  /**
   * Dispose for the per-iframe prelude registration. Calling it
   * removes the `__zb_registerFunction(...)` line from every iframe's
   * generated prelude and triggers a reload.
   */
  disposeSource: () => void;
}

/**
 * Spec for registering a renderer-side function. The function itself
 * lives in a source file (`modulePath`); the framework imports it in
 * every iframe's prelude and pushes the export into the in-renderer
 * `@zenbujs/core/react` function registry under `name`.
 *
 * `modulePath` must be absolute (same convention as `ViewRegistry.register`'s
 * `root` and the `source.modulePath` field on component views).
 *
 * `exportName` defaults to `"default"`. `meta` is opaque JSON that
 * consumers can filter on via `useFunctions({ kind: "..." })`.
 */
export interface RegisterFunctionSpec {
  name: string;
  modulePath: string;
  exportName?: string;
  meta?: FunctionMeta;
}

/**
 * Server-side registry for renderer functions.
 *
 * Parallels `ViewRegistryService` deliberately: services register
 * source modules under a stable `name`; the framework's prelude
 * pipeline imports those modules into every iframe and pushes the
 * exported value into a client-side `Map<name, fn>` that the
 * `useFunction` / `useFunctions` hooks read from. Registry metadata is
 * replicated to the renderer through `core.lastKnownFunctionRegistry`
 * so consumers can discover what's available even before deciding to
 * invoke anything.
 *
 * Distinct from views: the function is a plain JS value, not a React
 * component, and is consumed by other renderer subsystems (e.g. a
 * CodeMirror wrapper that wants `CompletionSource`s).
 */
export class FunctionRegistryService extends Service.create({
  key: "function-registry",
  deps: { db: DbService },
}) {
  private fns = new Map<string, FunctionEntry>();

  register(spec: RegisterFunctionSpec): FunctionEntry {
    const { name, modulePath, exportName, meta } = spec;
    log.verbose(
      `register("${name}", modulePath="${modulePath}", export="${exportName ?? "default"}")`,
    );
    // Re-registration replaces. Dispose the old source registration
    // first so the prelude generator drops the stale import before we
    // emit the new one.
    const existing = this.fns.get(name);
    if (existing) existing.disposeSource();

    const disposeSource = addFunctionSource(null, {
      name,
      modulePath,
      exportName,
      meta,
    });
    const entry: FunctionEntry = { name, meta, disposeSource };
    this.fns.set(name, entry);
    void this.syncToDb();
    return entry;
  }

  unregister(name: string): void {
    const entry = this.fns.get(name);
    if (!entry) return;
    entry.disposeSource();
    this.fns.delete(name);
    void this.syncToDb();
  }

  get(name: string): FunctionEntry | undefined {
    return this.fns.get(name);
  }

  evaluate() {
    // Mirror view-registry: wipe stale rows on boot, dispose source
    // registrations on tear-down.
    void this.syncToDb();
    this.setup("function-registry-cleanup", () => {
      return async () => {
        for (const entry of this.fns.values()) {
          entry.disposeSource();
        }
        this.fns.clear();
        await this.syncToDb();
      };
    });
  }

  private async syncToDb(): Promise<void> {
    const client = this.ctx.db.effectClient;
    const snapshot = [...this.fns.values()].map((e) => ({
      name: e.name,
      meta: e.meta,
    }));
    await Effect.runPromise(
      client.update((root) => {
        root.core.lastKnownFunctionRegistry = snapshot;
      }),
    ).catch(() => {});
  }
}

runtime.register(FunctionRegistryService, import.meta);

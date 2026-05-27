import * as Effect from "effect/Effect";
import { Service, runtime } from "../runtime";
import { DbService } from "./db";
import { addFunctionSource } from "./advice-config";
import { createLogger } from "../shared/log";

const log = createLogger("function-registry");

/**
 * Opaque, JSON metadata attached to a registered function. Surfaced via
 * `core.lastKnownFunctionRegistry`; consumers filter on it via
 * `useFunctions({ kind: "..." })`.
 */
export type FunctionMeta = Record<string, unknown> & {
  kind?: string;
  label?: string;
};

interface FunctionEntry {
  name: string;
  meta?: FunctionMeta;
  /** Removes the prelude registration + triggers a reload. */
  disposeSource: () => void;
}

/**
 * Spec for registering a renderer-side function. Every iframe's
 * prelude imports `modulePath` and pushes the export into the client
 * function registry under `name`. `modulePath` must be absolute.
 */
export interface RegisterFunctionSpec {
  name: string;
  modulePath: string;
  exportName?: string;
  meta?: FunctionMeta;
}

/**
 * Server-side registry for renderer functions. Source modules go through
 * the prelude pipeline; metadata mirrors to
 * `core.lastKnownFunctionRegistry` for discovery.
 */
export class FunctionRegistryService extends Service.create({
  key: "functionRegistry",
  deps: { db: DbService },
}) {
  private fns = new Map<string, FunctionEntry>();

  register(spec: RegisterFunctionSpec): FunctionEntry {
    const { name, modulePath, exportName, meta } = spec;
    log.verbose(
      `register("${name}", modulePath="${modulePath}", export="${exportName ?? "default"}")`,
    );
    // Re-registration replaces: dispose the old source so its prelude
    // entry drops before we emit the new one.
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
    // Wipe stale rows on boot, dispose source registrations on teardown.
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

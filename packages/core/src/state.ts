/**
 * Service in-memory state.
 *
 * Pattern:
 *
 *   import { Service, state } from "@zenbujs/core/runtime"
 *
 *   export class ServerStatusService extends Service.create({ key: "server-status" }) {
 *     status = state<"idle" | "running" | "error">("idle")
 *     port   = state<number | null>(null)
 *
 *     async start() {
 *       this.status.set("starting")
 *       this.port.set(await spawnServer())
 *       this.status.set("running")
 *     }
 *   }
 *
 * Each `state(initial)` creates a `ServiceState<T>` cell. The runtime
 * discovers these on service evaluation, registers them under
 * `<plugin>.<service>.<field>`, and the `StateService` broadcasts
 * snapshots+updates over the WebSocket `state` channel. Renderer code
 * reads via the `useServiceState` hook.
 *
 * Lifetime is tied to the service instance:
 *   - service evaluates → state instance registered, initial value broadcast
 *   - state.set(...) called → update broadcast to all connected clients
 *   - service torn down (hot reload / shutdown) → state instance unregistered
 *
 * Nothing is persisted to disk. That is the entire point: state dies with
 * the service so a force-quit does not leave stale rows in the database.
 *
 * Constraints:
 *   - values must be JSON-serializable (no functions, no class instances,
 *     no circular references — the wire transport is plain JSON.stringify)
 *   - equality is `Object.is`: `.set(prev)` is a no-op; `.set({...obj})`
 *     fires even if shape is identical
 *   - writes are main-process-only in v1; renderer writes go through
 *     ordinary RPC methods on the service
 */

/**
 * Brand symbol used by the runtime to detect ServiceState instances when
 * walking a service instance's own properties. `Symbol.for` so it survives
 * module reloads where two `state.ts` evaluations might otherwise mint
 * non-equal symbols.
 */
export const STATE_MARKER: unique symbol = Symbol.for(
  "@zenbujs/core/ServiceState",
) as never;

export type StateUnsubscribe = () => void;

export class ServiceState<T> {
  /** Brand: lets `isServiceState(x)` work without instanceof, which is HMR-fragile. */
  readonly [STATE_MARKER] = true as const;

  private _value: T;
  private subscribers = new Set<(value: T) => void>();

  constructor(initial: T) {
    this._value = initial;
  }

  get value(): T {
    return this._value;
  }

  get(): T {
    return this._value;
  }

  set(next: T): void {
    if (Object.is(this._value, next)) return;
    this._value = next;
    this.fire();
  }

  update(fn: (prev: T) => T): void {
    this.set(fn(this._value));
  }

  subscribe(cb: (value: T) => void): StateUnsubscribe {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  private fire(): void {
    if (this.subscribers.size === 0) return;
    const snapshot = this._value;
    for (const cb of [...this.subscribers]) {
      try {
        cb(snapshot);
      } catch (err) {
        console.error("[state] subscriber threw:", err);
      }
    }
  }
}

/**
 * Create a reactive in-memory state cell for a service field. See module
 * header for usage.
 */
export function state<T>(initial: T): ServiceState<T> {
  return new ServiceState<T>(initial);
}

/**
 * Type guard. Used by `ServiceRuntime` to find state fields on a service
 * instance without leaning on `instanceof` (which breaks across module
 * reloads).
 */
export function isServiceState(value: unknown): value is ServiceState<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { [STATE_MARKER]?: unknown })[STATE_MARKER] === true
  );
}

/**
 * One entry in the runtime's state registry — `pluginName.serviceKey.fieldName`
 * together with the underlying cell. The dispatcher emits these as the
 * wire snapshot and listens to each cell's `.subscribe()` for broadcasts.
 */
export interface StateEntry {
  path: string;
  pluginName: string;
  serviceKey: string;
  fieldName: string;
  cell: ServiceState<unknown>;
}

/**
 * Build the dotted path used on the wire. Kept here so the runtime,
 * service, and renderer all agree on the format.
 */
export function stateEntryPath(
  pluginName: string,
  serviceKey: string,
  fieldName: string,
): string {
  return `${pluginName}.${serviceKey}.${fieldName}`;
}

/** Server → client snapshot message. */
export interface StateSnapshotMessage {
  t: "snapshot";
  values: Record<string, unknown>;
}

/** Server → client per-field update message. */
export interface StateUpdateMessage {
  t: "update";
  path: string;
  /** `undefined` means the field was removed (service torn down). */
  value: unknown;
}

export type StateWireMessage = StateSnapshotMessage | StateUpdateMessage;

/**
 * Renderer-side mirror of the runtime's state registry. Apply incoming
 * snapshot/update messages; the React hook reads from `getTree()` (a
 * cached nested view of `<plugin>.<service>.<field>` → value) and
 * re-renders via `subscribe()`.
 *
 * Lives here (not `react.ts`) so it is plain TS — testable in node and
 * reusable from any renderer-side glue, not just React.
 */
export class ClientStateStore {
  private values = new Map<string, unknown>();
  private listeners = new Set<() => void>();
  private cachedTree: Record<string, unknown> = {};

  apply(msg: StateWireMessage): void {
    if (msg.t === "snapshot") {
      this.values.clear();
      for (const [path, value] of Object.entries(msg.values)) {
        this.values.set(path, value);
      }
    } else {
      if (msg.value === undefined) {
        this.values.delete(msg.path);
      } else {
        this.values.set(msg.path, msg.value);
      }
    }
    this.cachedTree = this.buildTree();
    this.notify();
  }

  getTree(): Record<string, unknown> {
    return this.cachedTree;
  }

  /** Flat path → value view. Same shape as the wire `snapshot.values`. */
  getEntries(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [path, value] of this.values) out[path] = value;
    return out;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private notify(): void {
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch (err) {
        console.error("[state] client listener threw:", err);
      }
    }
  }

  private buildTree(): Record<string, unknown> {
    const root: Record<string, unknown> = {};
    for (const [path, value] of this.values) {
      const parts = path.split(".");
      let cur = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i]!;
        const next = cur[key];
        if (typeof next !== "object" || next === null) {
          const fresh: Record<string, unknown> = {};
          cur[key] = fresh;
          cur = fresh;
        } else {
          cur = next as Record<string, unknown>;
        }
      }
      cur[parts[parts.length - 1]!] = value;
    }
    return root;
  }
}

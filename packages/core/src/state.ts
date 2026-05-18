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

/**
 * The WebSocket multiplexer channel name carrying state snapshots and
 * updates. Imported by both the server (`StateService`) and the renderer
 * (`ZenbuProvider`) so the two sides cannot drift.
 */
export const STATE_WIRE_CHANNEL = "state" as const;

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
/**
 * Try to capture the wire path a selector reads, using a recording
 * Proxy that records every string-keyed property access. Returns the
 * dotted path on success, or `null` if the selector did anything the
 * recorder cannot represent — Symbol access, function calls (`.find`),
 * `in` checks, conditionals returning a non-leaf, throws. Callers fall
 * back to tree-walk + dedup in that case.
 */
export function tryRecordSelectorPath(
  selector: (tree: any) => unknown,
): string | null {
  const parts: string[] = [];
  let bailed = false;
  const make = (): any =>
    new Proxy(
      {},
      {
        get(_, prop) {
          if (typeof prop !== "string") {
            bailed = true;
            return undefined;
          }
          // Common thenable / iteration probes done by libraries or
          // the React renderer — bail rather than record garbage.
          if (
            prop === "then" ||
            prop === Symbol.toPrimitive.toString() ||
            prop === "toJSON"
          ) {
            bailed = true;
            return undefined;
          }
          parts.push(prop);
          return make();
        },
        has() {
          bailed = true;
          return false;
        },
        apply() {
          bailed = true;
          return undefined;
        },
      },
    );
  let result: unknown;
  try {
    result = selector(make());
  } catch {
    return null;
  }
  if (bailed) return null;
  // The leaf must itself be the recording proxy — selector must end at
  // a property access, not return a literal.
  if (typeof result !== "object" || result === null) return null;
  return parts.join(".");
}

export class ClientStateStore {
  private values = new Map<string, unknown>();
  /** Tree-level (every change) listeners — used by selectors that walk the tree. */
  private treeListeners = new Set<() => void>();
  /** Path-indexed listeners — fire only when the specific path's value changes. */
  private pathListeners = new Map<string, Set<() => void>>();
  private cachedTree: Record<string, unknown> = {};

  apply(msg: StateWireMessage): void {
    const changedPaths: string[] = [];
    if (msg.t === "snapshot") {
      // Diff: any path that changed value (or was added/removed) counts.
      const next = new Map<string, unknown>(Object.entries(msg.values));
      for (const [path, value] of next) {
        if (!this.values.has(path) || !Object.is(this.values.get(path), value)) {
          changedPaths.push(path);
        }
      }
      for (const path of this.values.keys()) {
        if (!next.has(path)) changedPaths.push(path);
      }
      this.values = next;
    } else {
      const prev = this.values.get(msg.path);
      if (msg.value === undefined) {
        if (this.values.has(msg.path)) {
          this.values.delete(msg.path);
          changedPaths.push(msg.path);
        }
      } else if (!this.values.has(msg.path) || !Object.is(prev, msg.value)) {
        this.values.set(msg.path, msg.value);
        changedPaths.push(msg.path);
      }
    }
    if (changedPaths.length === 0) return;
    this.cachedTree = this.buildTree();
    this.notify(changedPaths);
  }

  getTree(): Record<string, unknown> {
    return this.cachedTree;
  }

  /** Direct read by wire path. Returns `undefined` if the path is unknown. */
  getValueAt(path: string): unknown {
    return this.values.get(path);
  }

  /** Flat path → value view. Same shape as the wire `snapshot.values`. */
  getEntries(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [path, value] of this.values) out[path] = value;
    return out;
  }

  /**
   * Tree-level subscription — `cb` fires after any apply that changes
   * at least one value. Used by selectors that walk the tree (`.find()`,
   * etc.) where the consumer cannot pre-declare the path of interest.
   */
  subscribe(cb: () => void): () => void {
    this.treeListeners.add(cb);
    return () => {
      this.treeListeners.delete(cb);
    };
  }

  /**
   * Path-indexed subscription — `cb` fires only when the value at
   * `path` changes (added, replaced, or removed). The fast path for
   * the `useServiceState` Proxy-recorded selector.
   */
  subscribePath(path: string, cb: () => void): () => void {
    let set = this.pathListeners.get(path);
    if (!set) {
      set = new Set();
      this.pathListeners.set(path, set);
    }
    set.add(cb);
    return () => {
      const cur = this.pathListeners.get(path);
      if (!cur) return;
      cur.delete(cb);
      if (cur.size === 0) this.pathListeners.delete(path);
    };
  }

  private notify(changedPaths: readonly string[]): void {
    // Path-indexed listeners first — cheap, targeted.
    for (const path of changedPaths) {
      const set = this.pathListeners.get(path);
      if (!set) continue;
      for (const cb of [...set]) {
        try {
          cb();
        } catch (err) {
          console.error("[state] client path listener threw:", err);
        }
      }
    }
    // Tree listeners — fire once per apply, no matter how many paths changed.
    for (const cb of [...this.treeListeners]) {
      try {
        cb();
      } catch (err) {
        console.error("[state] client tree listener threw:", err);
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

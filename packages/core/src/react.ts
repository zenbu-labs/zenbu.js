/**
 * Public renderer-side surface for plugin authors. Wraps the websocket
 * lifecycle, RPC client, replica DB connection, and event subscription
 * behind a single `<ZenbuProvider>` plus hooks.
 *
 * DB hooks (`useDb`, `useCollection`) are implemented in `@zenbu/kyju/react`
 * and composed here via `KyjuProvider` mounted inside `ZenbuProvider`.
 * Core only adds the websocket lifecycle (RPC/events) and the
 * `ZenbuRegister`-driven type narrowing so call sites never need a generic.
 */

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { connectReplica } from "@zenbu/kyju/transport";
import { encodeFrame, decodeFrame } from "./transport/ws-frame";
import type {
  ClientProxy,
  SchemaShape,
} from "@zenbu/kyju";
import { createKyjuReact } from "@zenbu/kyju/react";
import type {
  CollectionRefValue,
} from "@zenbu/kyju/schema";
import { connectRpc } from "@zenbu/zenrpc";
import type {
  UnifiedEventProxy,
  RouterProxy,
} from "@zenbu/zenrpc";
import type {
  ResolvedDbRoot,
  ResolvedServiceRouter,
  ResolvedEvents,
} from "./registry";
import type {
  PluginRepoRef,
  UpdateCheck,
} from "./services/plugin-updater";

type AnyRpc = RouterProxy<
  Record<string, Record<string, Record<string, (...args: any[]) => any>>>
>;
type AnyEvents = UnifiedEventProxy<Record<string, Record<string, unknown>>>;
type AnyDbClient = ClientProxy<SchemaShape>;
type Replica = Awaited<ReturnType<typeof connectReplica>>["replica"];

type Connection = {
  rpc: AnyRpc;
  events: AnyEvents;
  db: AnyDbClient;
  replica: Replica;
};

type ConnectionState =
  | { status: "connecting" }
  | { status: "connected"; conn: Connection }
  | { status: "error"; error: string };

const ConnectionContext = createContext<ConnectionState | null>(null);

/**
 * Args delivered to a `<View>` rendered injection. Read by
 * `useViewArgs()` so child components don't have to destructure
 * `args` themselves.
 */
const ViewArgsContext = createContext<Record<string, unknown> | null>(null);

// The `Resolved*` types are conditional on `ZenbuRegister` — they resolve
// lazily at the consumer's compilation unit (after `zen link`'s module
// augmentation is in scope). We alias them here so core's own build
// doesn't eagerly collapse them to the fallback.
type RegisteredDbRoot = ResolvedDbRoot;
type RegisteredServiceRouter = ResolvedServiceRouter;
type RegisteredEvents = ResolvedEvents;

const kyjuReact = createKyjuReact<SchemaShape, RegisteredDbRoot>();

// ---- DB hooks (delegated to kyju, typed via ZenbuRegister) ----

/**
 * Subscribe to a slice of the live DB. The selector's `root` is typed via
 * `ZenbuRegister["db"]`, populated by `zen link`. No generic at the call site.
 *
 *   const count = useDb((root) => root.app.count)
 */
export function useDb(): RegisteredDbRoot;
export function useDb<T>(
  selector: (root: RegisteredDbRoot) => T,
  isEqual?: (a: T, b: T) => boolean,
): T;
export function useDb<T>(
  selector?: (root: RegisteredDbRoot) => T,
  isEqual?: (a: T, b: T) => boolean,
) {
  return kyjuReact.useDb(selector as any, isEqual);
}

export const useCollection = kyjuReact.useCollection;

// ---- Provider ----

export type ZenbuProviderProps = {
  wsUrl?: string;
  fallback?: ReactNode;
  errorFallback?: (error: string) => ReactNode;
  children: ReactNode;
};

export function ZenbuProvider({
  wsUrl,
  fallback,
  errorFallback,
  children,
}: ZenbuProviderProps) {
  const [state, setState] = useState<ConnectionState>({ status: "connecting" });
  const cleanupRef = useRef<(() => void) | null>(null);
  const retriesRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const resolvedUrl = (() => {
      if (wsUrl) return wsUrl;
      const params = new URLSearchParams(window.location.search);
      const port = params.get("wsPort");
      const token = params.get("wsToken");
      if (!port) return { error: "Missing ?wsPort= in URL" } as const;
      if (!token) return { error: "Missing ?wsToken= in URL" } as const;
      return `ws://127.0.0.1:${port}?token=${encodeURIComponent(token)}`;
    })();

    if (typeof resolvedUrl !== "string") {
      setState({ status: "error", error: resolvedUrl.error });
      return;
    }

    function connect() {
      if (cancelled) return;
      setState({ status: "connecting" });
      cleanupRef.current = null;

      const ws = new WebSocket(resolvedUrl as string);
      // Binary db frames arrive as ArrayBuffer rather than Blob.
      ws.binaryType = "arraybuffer";

      ws.onopen = async () => {
        try {
          retriesRef.current = 0;

          const {
            server: rpc,
            events,
            disconnect: disconnectRpc,
          } = await connectRpc({
            version: "0",
            send: (data) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ ch: "rpc", data }));
              }
            },
            subscribe: (cb) => {
              const handler = (e: MessageEvent) => {
                // The rpc channel is text-only; ignore binary db frames.
                if (typeof e.data !== "string") return;
                const msg = JSON.parse(e.data);
                if (msg.ch === "rpc") cb(msg.data);
              };
              ws.addEventListener("message", handler);
              return () => ws.removeEventListener("message", handler);
            },
          });

          const {
            client: db,
            replica,
            disconnect: disconnectDb,
          } = await connectReplica({
            send: (event) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(encodeFrame({ ch: "db", data: event }));
              }
            },
            subscribe: (cb) => {
              const handler = (e: MessageEvent) => {
                const msg = decodeFrame(e.data, typeof e.data !== "string");
                if (msg.ch === "db") cb(msg.data);
              };
              ws.addEventListener("message", handler);
              return () => ws.removeEventListener("message", handler);
            },
          });

          if (cancelled) {
            await disconnectDb();
            disconnectRpc();
            ws.close();
            return;
          }

          // Subscribe to the host's reload signal so registration
          // changes (a new injection appearing after the prelude was
          // generated) trigger a one-shot `location.reload()` and a
          // fresh prelude pulls them in.
          let unsubReload: (() => void) | null = null;
          {
            const adviceReload = (events as any)?.core?.advice?.reload;
            if (adviceReload?.subscribe) {
              unsubReload = adviceReload.subscribe((data: { type?: string }) => {
                if (data?.type === "*") {
                  location.reload();
                }
              });
            }
          }

          cleanupRef.current = () => {
            unsubReload?.();
            disconnectDb();
            disconnectRpc();
            ws.close();
          };

          // Forward any buffered boot-trace events the renderer prelude
          // accumulated before this WS was up. Fire-and-forget — we don't
          // want a slow ingest to gate first render. The `?.` guards a
          // disabled/missing tracer.
          try {
            const bt = (window as unknown as {
              __zenbuBootTrace?: {
                drain: () => unknown[];
                timeOrigin: number;
                mark: (name: string, meta?: Record<string, unknown>) => void;
              };
            }).__zenbuBootTrace;
            if (bt) {
              bt.mark("zenbu-provider-connected");
              const events = bt.drain();
              const reporter = (rpc as any)?.core?.bootTrace?.report;
              if (typeof reporter === "function" && events.length > 0) {
                void reporter({
                  events,
                  timeOrigin: bt.timeOrigin,
                }).catch(() => {});
              }
              // Keep draining after connect: readiness marks often fire later
              // (children mount, Suspense resolves, first frame).
              const started = Date.now();
              const drainLateMarks = () => {
                const more = bt.drain();
                if (more.length > 0 && typeof reporter === "function") {
                  void reporter({
                    events: more,
                    timeOrigin: bt.timeOrigin,
                  }).catch(() => {});
                }
                if (Date.now() - started < 8000) {
                  setTimeout(drainLateMarks, 250);
                }
              };
              setTimeout(drainLateMarks, 250);
            }
          } catch {}

          setState({
            status: "connected",
            conn: {
              rpc: rpc as AnyRpc,
              events: events as AnyEvents,
              db: db as AnyDbClient,
              replica,
            },
          });
        } catch (err) {
          if (!cancelled) {
            ws.close();
            scheduleReconnect();
          }
        }
      };

      ws.onerror = () => {};

      ws.onclose = () => {
        if (!cancelled) {
          cleanupRef.current?.();
          cleanupRef.current = null;
          scheduleReconnect();
        }
      };
    }

    function scheduleReconnect() {
      if (cancelled) return;
      const delay = Math.min(300 * Math.pow(2, retriesRef.current), 3000);
      retriesRef.current++;
      setState({ status: "connecting" });
      reconnectTimer = setTimeout(connect, delay);
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [wsUrl]);

  if (state.status === "connecting") {
    return createElement(
      "span",
      { "data-zenbu-connecting": true },
      fallback ?? null,
    );
  }
  if (state.status === "error") {
    return createElement(
      "span",
      { "data-zenbu-error": true },
      errorFallback ? errorFallback(state.error) : null,
    );
  }

  // KyjuProvider lives inside ConnectionContext so kyju's hooks find
  // their context. `ShortcutDispatcher` is an effect-only child that
  // installs the keydown listener (one per ZenbuProvider = one per
  // BrowserWindow).
  return createElement(
    ConnectionContext.Provider,
    { value: state },
    createElement(
      kyjuReact.KyjuProvider,
      {
        client: state.conn.db,
        replica: state.conn.replica,
        children: createElement(
          "div",
          { "data-zenbu-root": true, style: { display: "contents" } },
          createElement(ShortcutDispatcher, {}),
          children,
        ),
      },
    ),
  );
}

// ---- Shortcut dispatcher ----
// Capture-phase `keydown` on `window` -> walk `[data-zenbu-focus-context]`
// ancestors from `event.target` for the active stack -> match against the
// cached binding list (synced via the `bindings()` RPC + `changed`
// event) -> `preventDefault()` on match + RPC dispatch.

type ShortcutBinding = {
  key?: string;
  code?: string;
  meta?: boolean;
  control?: boolean;
  alt?: boolean;
  shift?: boolean;
};

type ShortcutWhen =
  | string
  | string[]
  | { all?: string[]; any?: string[]; not?: string | string[] };

type ShortcutBindingsSnapshot = {
  id: string;
  bindings: ShortcutBinding[];
  when?: ShortcutWhen;
};

function shortcutInputMatchesBinding(
  ev: KeyboardEvent,
  b: ShortcutBinding,
): boolean {
  if (!!b.meta !== !!ev.metaKey) return false;
  if (!!b.control !== !!ev.ctrlKey) return false;
  if (!!b.alt !== !!ev.altKey) return false;
  if (!!b.shift !== !!ev.shiftKey) return false;
  if (b.code && ev.code !== b.code) return false;
  if (b.key) {
    const want = String(b.key).toLowerCase();
    const have = String(ev.key || "").toLowerCase();
    if (have !== want) return false;
  }
  return true;
}

function shortcutWhenMatches(
  w: ShortcutWhen | undefined,
  active: readonly string[],
): boolean {
  if (w == null) return true;
  const set = new Set(active);
  if (typeof w === "string") return set.has(w);
  if (Array.isArray(w)) {
    for (const id of w) if (!set.has(id)) return false;
    return true;
  }
  if (w.all) for (const id of w.all) if (!set.has(id)) return false;
  if (w.any) {
    let hit = false;
    for (const id of w.any)
      if (set.has(id)) {
        hit = true;
        break;
      }
    if (!hit) return false;
  }
  if (w.not) {
    const nots = Array.isArray(w.not) ? w.not : [w.not];
    for (const id of nots) if (set.has(id)) return false;
  }
  return true;
}

// Innermost-first; multiple ids on one wrapper are space-separated
// (same convention `class` uses).
function readActiveFocusContexts(el: Element | null): string[] {
  const out: string[] = [];
  let node: Node | null = el ?? document.activeElement;
  while (node && node.nodeType === 1) {
    const attr = (node as Element).getAttribute?.(
      "data-zenbu-focus-context",
    );
    if (attr) {
      for (const id of String(attr).split(/\s+/)) if (id) out.push(id);
    }
    node = node.parentNode;
  }
  return out;
}

function ShortcutDispatcher(): null {
  const rpc = useRpc() as unknown as {
    core: {
      shortcuts: {
        bindings: () => Promise<ShortcutBindingsSnapshot[]>;
        handleKeydown: (args: {
          input: ShortcutBinding;
          contexts: string[];
        }) => Promise<unknown>;
      };
    };
  };
  const events = useEvents() as unknown as {
    core: {
      shortcuts: { changed: { subscribe: (cb: () => void) => () => void } };
    };
  };

  // Ref so the keydown handler reads bindings synchronously without
  // re-binding the listener on every refresh.
  const bindingsRef = useRef<ShortcutBindingsSnapshot[]>([]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const list = await rpc.core.shortcuts.bindings();
        if (!cancelled) bindingsRef.current = list;
      } catch {
        // Service not ready yet; the next `changed` emit catches us up.
      }
    };
    void refresh();
    const off = events.core.shortcuts.changed.subscribe(() => {
      void refresh();
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [rpc, events]);

  useEffect(() => {
    const handler = (ev: KeyboardEvent) => {
      if (ev.defaultPrevented) return;
      const input: ShortcutBinding = {
        key: ev.key,
        code: ev.code,
        meta: !!ev.metaKey,
        control: !!ev.ctrlKey,
        alt: !!ev.altKey,
        shift: !!ev.shiftKey,
      };
      const contexts = readActiveFocusContexts(
        ev.target as Element | null,
      );
      // Local match decides `preventDefault()` only; main re-runs
      // the match for dispatch.
      let matched = false;
      for (const entry of bindingsRef.current) {
        let keyHit = false;
        for (const b of entry.bindings) {
          if (shortcutInputMatchesBinding(ev, b)) {
            keyHit = true;
            break;
          }
        }
        if (!keyHit) continue;
        if (!shortcutWhenMatches(entry.when, contexts)) continue;
        matched = true;
        break;
      }
      if (matched) {
        try {
          ev.preventDefault();
        } catch {}
        try {
          ev.stopPropagation();
        } catch {}
      }
      void rpc.core.shortcuts
        .handleKeydown({ input, contexts })
        .catch(() => {});
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [rpc]);

  return null;
}

// ---- Connection accessor (RPC/events/db-client) ----

function useConnection(): Connection {
  const state = useContext(ConnectionContext);
  if (!state) {
    throw new Error("useDb/useRpc/useEvents must be used inside <ZenbuProvider>");
  }
  if (state.status !== "connected") {
    throw new Error(
      `Zenbu connection is not ready (status: ${state.status}). ` +
        `Render a <ZenbuProvider fallback={...}> around your hooks.`,
    );
  }
  return state.conn;
}

// ---- RPC / events / db-client hooks (core-only, not DB subscription) ----

export type { ZenbuRegister } from "./registry";

export function useRpc(): RouterProxy<RegisteredServiceRouter> {
  return useConnection().rpc as unknown as RouterProxy<RegisteredServiceRouter>;
}

type PluginUpdaterRpc = {
  listRepos(): Promise<PluginRepoRef[]>;
  checkRepo(args: { path: string }): Promise<UpdateCheck>;
  checkAll(): Promise<UpdateCheck[]>;
  applyRepo(args: {
    path: string;
    targetCommit?: string;
    requireFastForward?: boolean;
  }): Promise<never>;
};

/** Convenience wrapper around `rpc.core.pluginUpdater`. */
export function useUpdater(): PluginUpdaterRpc {
  const rpc = useRpc() as unknown as { core: { pluginUpdater: PluginUpdaterRpc } };
  return useMemo(() => rpc.core.pluginUpdater, [rpc]);
}

export type DbClient = {
  readRoot(): RegisteredDbRoot;
  update(
    fn: (root: RegisteredDbRoot) => void | RegisteredDbRoot,
  ): Promise<void>;
  createBlob(data: Uint8Array, hot?: boolean, contentType?: string): Promise<string>;
  deleteBlob(blobId: string): Promise<void>;
  getBlobData(blobId: string): Promise<Uint8Array | null>;
};

export function useDbClient(): DbClient {
  return useConnection().db as unknown as DbClient;
}

/**
 * Build a stable HTTP URL for a blob's bytes, served straight from disk by
 * the host (see the `/__blob/` route in the db service). Works in any
 * renderer context — including ones outside `<ZenbuProvider>` such as
 * CodeMirror widgets — because it derives the host port/token from the view
 * URL rather than React context. Returns "" when unavailable.
 *
 * Prefer this over reading bytes + `URL.createObjectURL` for images/media:
 * no DB-channel transfer, no per-render byte copy, browser-cached, and
 * stable per `blobId` (so it doesn't flicker on remount).
 */
export function blobUrl(blobId: string, mime?: string): string {
  const params = new URLSearchParams(window.location.search);
  const port = params.get("wsPort");
  const token = params.get("wsToken");
  if (!port || !token || !blobId) return "";
  const q = new URLSearchParams({ token });
  if (mime) q.set("type", mime);
  return `http://127.0.0.1:${port}/__blob/${encodeURIComponent(blobId)}?${q.toString()}`;
}

/** React convenience wrapper around {@link blobUrl}; `null` when no blobId. */
export function useBlobUrl(
  blobId: string | null | undefined,
  mime?: string,
): string | null {
  return blobId ? blobUrl(blobId, mime) : null;
}

export function useEvents(): UnifiedEventProxy<RegisteredEvents> {
  return useConnection().events as unknown as UnifiedEventProxy<RegisteredEvents>;
}

export type { CollectionRefValue };

// ---- <FocusContext>: focus-context primitive for shortcut `when` ----

/**
 * Declares a named focus region, active whenever DOM focus is inside it.
 * Contexts nest (active stack is innermost-first); pass an array for multiple
 * ids at one level. Renders a `<div>` wrapper.
 */
export interface FocusContextProps {
  id: string | string[];
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  tabIndex?: number;
  /** Forwarded onto the wrapper so callers can imperatively `focus()` it. */
  innerRef?: Ref<HTMLDivElement>;
}

export function FocusContext({
  id,
  children,
  className,
  style,
  tabIndex,
  innerRef,
}: FocusContextProps): ReactElement {
  const ids = Array.isArray(id) ? id : [id];
  const dataValue = ids.filter(Boolean).join(" ");
  return createElement(
    "div",
    {
      ref: innerRef,
      className,
      style,
      tabIndex,
      "data-zenbu-focus-context": dataValue,
      // Clicking a non-focusable child focuses the wrapper so it "enters" the
      // context; focusable targets (buttons, inputs, links) handle their own focus.
      onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        if (isFocusable(target)) return;
        const wrapper = e.currentTarget;
        if (wrapper && wrapper.tabIndex >= 0) {
          try { wrapper.focus({ preventScroll: true }); } catch {}
        }
      },
    },
    children,
  );
}

function isFocusable(el: HTMLElement): boolean {
  if (el.tabIndex >= 0) return true;
  // Tab-stop heuristic: covers the elements the user really clicks on.
  // We intentionally don't enumerate every focusable element type — if
  // a custom element wants to opt in it can set `tabIndex >= 0`.
  const tag = el.tagName;
  if (tag === "BUTTON" || tag === "A" || tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
    return true;
  }
  // Walk up a couple of levels so clicking the icon inside a button
  // still counts as a focusable target. Bounded so we don't re-walk
  // the whole tree.
  let node: HTMLElement | null = el.parentElement;
  for (let i = 0; node && i < 3; i++) {
    if (node.tabIndex >= 0) return true;
    const ntag = node.tagName;
    if (ntag === "BUTTON" || ntag === "A") return true;
    node = node.parentElement;
  }
  return false;
}

/**
 * Hook companion for `<FocusContext>`. Returns `{ ref, active, focus() }` where
 * `active` tracks only this element's focus. For the global stack use
 * `useDb(root => root.core.focus.contexts.includes(id))`.
 */
export function useFocusContext(_id: string | string[]) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    const update = () => {
      const focused =
        document.activeElement === el ||
        (document.activeElement != null && el.contains(document.activeElement));
      setActive((prev) => (prev === focused ? prev : focused));
    };
    update();
    document.addEventListener("focusin", update, true);
    document.addEventListener("focusout", update, true);
    return () => {
      document.removeEventListener("focusin", update, true);
      document.removeEventListener("focusout", update, true);
    };
  }, []);

  const focus = useMemo(
    () => () => {
      try {
        ref.current?.focus({ preventScroll: true });
      } catch {}
    },
    [],
  );

  return { ref, active, focus };
}

// ---- Component view registry (client-side) ----

// ---- Injection registry (client-side) ----

/** Opaque metadata; consumers filter via `useInjections({ kind: … })`. */
export type InjectionMeta = Record<string, unknown> & {
  kind?: string;
  label?: string;
  icon?: string;
};

export type AnyFn = (...args: any[]) => any;

export interface InjectionEntry<F = unknown> {
  name: string;
  value: F;
  meta?: InjectionMeta;
}

/** Props for an injection rendered through `<View>`. */
export type ViewComponentProps<
  A extends Record<string, unknown> = Record<string, unknown>,
> = {
  args: A;
};

export type ViewComponent<
  A extends Record<string, unknown> = Record<string, unknown>,
> = ComponentType<ViewComponentProps<A>>;

// One in-renderer Map keyed by `name`. Populated by the Vite prelude
// (for `this.inject(...)`) and by `useRegisterInjection` at runtime.
// Last-writer-wins.
const injectionRegistry = new Map<string, InjectionEntry<unknown>>();
const injectionRegistryListeners = new Set<() => void>();

// When > 0, `emitInjectionRegistryChange()` queues a
// single deferred notification
let injectionBatchDepth = 0;
let injectionBatchPending = false;

function emitInjectionRegistryChange() {
  if (injectionBatchDepth > 0) {
    injectionBatchPending = true;
    return;
  }
  for (const cb of injectionRegistryListeners) {
    try {
      cb();
    } catch {}
  }
}


export function beginInjectionBatch(): void {
  injectionBatchDepth++;
}


export function endInjectionBatch(): void {
  if (injectionBatchDepth === 0) return;
  injectionBatchDepth--;
  if (injectionBatchDepth > 0) return;
  if (!injectionBatchPending) return;
  injectionBatchPending = false;
  for (const cb of injectionRegistryListeners) {
    try {
      cb();
    } catch {}
  }
}

/**
 * Register an injection. Returns an unregister fn. Wrap closures in
 * `useCallback` / `useMemo` to keep identity stable, or use
 * `useRegisterInjection` which handles that for you.
 */
export function registerInjection<F = unknown>(
  name: string,
  value: F,
  meta?: InjectionMeta,
): () => void {
  const entry: InjectionEntry<unknown> = { name, value, meta };
  injectionRegistry.set(name, entry);
  emitInjectionRegistryChange();
  return () => {
    // Only clear if we still own the slot — keeps a later
    // re-registration intact when a stale dispose fires after it.
    if (injectionRegistry.get(name) === entry) {
      injectionRegistry.delete(name);
      emitInjectionRegistryChange();
    }
  };
}

function subscribeInjectionRegistry(cb: () => void) {
  injectionRegistryListeners.add(cb);
  return () => {
    injectionRegistryListeners.delete(cb);
  };
}

/**
 * Hook companion to `registerInjection`. Registers `value` under
 * `name` while the calling component is mounted; re-registers when
 * `value` identity or `name` changes.
 */
export function useRegisterInjection<F = unknown>(
  name: string,
  value: F,
  meta?: InjectionMeta,
): void {
  // Stringify meta for the effect deps so callers don't need to
  // memoize the meta object themselves. Cheap because meta is small.
  const metaKey = useMemo(
    () => (meta === undefined ? "" : JSON.stringify(meta)),
    [meta],
  );
  useEffect(() => {
    return registerInjection(name, value, meta);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, value, metaKey]);
}

/** Read one injection by name. Reactive. */
export function useInjection<F = unknown>(name: string): F | undefined {
  return useSyncExternalStore(
    subscribeInjectionRegistry,
    () => injectionRegistry.get(name)?.value as F | undefined,
    () => injectionRegistry.get(name)?.value as F | undefined,
  );
}

export type InjectionsFilter =
  | { kind?: string; [k: string]: unknown }
  | ((entry: InjectionEntry) => boolean);

function matchesFilter(
  entry: InjectionEntry<unknown>,
  filter: InjectionsFilter | undefined,
): boolean {
  if (filter === undefined) return true;
  if (typeof filter === "function") return filter(entry as InjectionEntry);
  const meta = entry.meta ?? {};
  for (const [k, v] of Object.entries(filter)) {
    if ((meta as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

/**
 * Read injections, optionally filtered by `meta` keys or a predicate.
 * Reactive; array reference is stable when the result hasn't changed.
 *
 *   useInjections({ kind: "footer.item" })
 *   useInjections((e) => e.name.startsWith("git/"))
 */
export function useInjections<F = unknown>(
  filter?: InjectionsFilter,
): Array<InjectionEntry<F>> {
  const lastSnapshotRef = useRef<Array<InjectionEntry<F>>>([]);
  const lastKeyRef = useRef<string>("");

  const getSnapshot = () => {
    const matches: Array<InjectionEntry<F>> = [];
    for (const entry of injectionRegistry.values()) {
      if (matchesFilter(entry, filter)) {
        matches.push(entry as InjectionEntry<F>);
      }
    }
    const key = matches.map((m) => m.name).join("\u0000");
    if (
      key === lastKeyRef.current &&
      matches.length === lastSnapshotRef.current.length
    ) {
      let same = true;
      for (let i = 0; i < matches.length; i++) {
        if (matches[i]!.value !== lastSnapshotRef.current[i]!.value) {
          same = false;
          break;
        }
      }
      if (same) return lastSnapshotRef.current;
    }
    lastKeyRef.current = key;
    lastSnapshotRef.current = matches;
    return matches;
  };

  return useSyncExternalStore(
    subscribeInjectionRegistry,
    getSnapshot,
    getSnapshot,
  );
}

// ---- <View>: render an injection as a React component ----

/**
 * Render the injection registered under `name`. The component
 * receives `{ args }` as a prop; child components can also read
 * args via `useViewArgs<A>()`. Re-renders pick up registry
 * replacements. `fallback` shows when the name has no injection
 * yet.
 */
export type ViewProps = {
  /** Injection name to render. Required. */
  name: string;
  /** Arbitrary props passed to the injection's component as `args`. */
  args?: Record<string, unknown>;
  /** When false, sets `style.display: none`. The component stays
   *  mounted — use this to preserve in-component state across
   *  visibility toggles. */
  visible?: boolean;
  style?: CSSProperties;
  className?: string;
  /** Rendered when no injection is registered under `name` yet. */
  fallback?: ReactNode;
};

export function View({
  name,
  args,
  visible = true,
  style,
  className,
  fallback = null,
}: ViewProps): ReactElement {
  const ComponentImpl = useInjection<ViewComponent<any>>(name);

  const wrapperStyle: CSSProperties = {
    ...style,
    display: visible ? style?.display ?? "contents" : "none",
  };

  if (!ComponentImpl) {
    return createElement(
      "span",
      {
        "data-zenbu-view-pending": name,
        style: wrapperStyle,
        className,
      },
      fallback,
    );
  }

  return createElement(
    "div",
    {
      className,
      style: wrapperStyle,
      "data-zenbu-view": name,
    },
    createElement(
      ViewArgsContext.Provider,
      { value: (args ?? {}) as Record<string, unknown> },
      createElement(ComponentImpl, { args: args ?? {} }),
    ),
  );
}

/**
 * Read the current `args` passed to the enclosing `<View>` injection.
 * Equivalent to destructuring `args` from the component's props —
 * exposed as a hook so consumers don't have to thread `args` down
 * the tree manually.
 *
 * Re-renders when the parent passes a new `args` object.
 */
export function useViewArgs<T extends Record<string, unknown>>(): T {
  const ctxArgs = useContext(ViewArgsContext);
  return (ctxArgs ?? ({} as Record<string, unknown>)) as T;
}

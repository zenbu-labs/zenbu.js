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
import {
  connectReplica,
  dbStringify,
  dbParse,
} from "@zenbu/kyju/transport";
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
  EventProxy,
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
type AnyEvents = EventProxy<Record<string, Record<string, unknown>>>;
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
 * Args delivered to a component-mode `<View>`. The iframe path uses
 * `window.__zenbuViewArgs` (populated by the prelude's postMessage
 * listener); the in-process component path reads this context instead.
 * `useViewArgs()` prefers the context when present so the same hook
 * works in both rendering modes.
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

  // Gate iframe view rendering on the first view-args message arriving.
  // This guarantees `useViewArgs<T>(): T` is non-null at every call site:
  // children only mount after the parent has delivered args. The
  // entrypoint view (top-level, no parent) skips the gate — it never
  // gets args from anyone.
  const isIframeView =
    typeof window !== "undefined" &&
    window.parent !== window &&
    !!window.__zenbuViewArgs;
  const [viewArgsReady, setViewArgsReady] = useState<boolean>(
    () => !isIframeView || !!window.__zenbuViewArgs?.current,
  );
  useEffect(() => {
    if (viewArgsReady) return;
    const store = window.__zenbuViewArgs;
    if (!store) return;
    let cancelled = false;
    store.ready.then(() => {
      if (!cancelled) setViewArgsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [viewArgsReady]);

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
                ws.send(dbStringify({ ch: "db", data: event }));
              }
            },
            subscribe: (cb) => {
              const handler = (e: MessageEvent) => {
                const msg = dbParse(e.data);
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

          // Close the race where the iframe's prelude was generated
          // before late-registering services contributed their
          // functions / component views. Compare db snapshot to the
          // in-memory registries the prelude populated; mismatch
          // → reload once. Fresh prelude has everything, second run
          // passes the check, no loop.
          try {
            const root = (db as unknown as { readRoot: () => unknown }).readRoot();
            const core = (root as { core?: unknown } | undefined)?.core as
              | {
                  lastKnownFunctionRegistry?: Array<{ name: string }>;
                  lastKnownViewRegistry?: Array<{ type: string; rendering?: string }>;
                }
              | undefined;
            const dbFns = core?.lastKnownFunctionRegistry ?? [];
            const dbComponentViews = (core?.lastKnownViewRegistry ?? []).filter(
              (v) => v.rendering === "component",
            );
            const missingFn = dbFns.filter((f) => !functionRegistry.has(f.name));
            const missingView = dbComponentViews.filter(
              (v) => !viewComponentRegistry.has(v.type),
            );
            if (missingFn.length > 0 || missingView.length > 0) {
              await disconnectDb();
              disconnectRpc();
              ws.close();
              location.reload();
              return;
            }
          } catch (err) {
            // Best-effort; fall through to the live reload subscription.
            // eslint-disable-next-line no-console
            console.warn("[zenbu/react] reconcile check failed:", err);
          }

          // View type lives at `/views/<type>/...` or `?type=<name>`.
          // Mirrors `resolveType()` in `vite-plugins.ts`.
          const viewMatch = window.location.pathname.match(/^\/views\/([^/]+)\//);
          const viewType =
            viewMatch?.[1] ??
            new URLSearchParams(window.location.search).get("type");
          let unsubReload: (() => void) | null = null;
          if (viewType) {
            const adviceReload = (events as any)?.core?.advice?.reload;
            if (adviceReload?.subscribe) {
              unsubReload = adviceReload.subscribe((data: { type?: string }) => {
                if (data?.type === "*" || data?.type === viewType) {
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
              // Keep draining for a few seconds after connect. App-level
              // readiness marks often happen after <ZenbuProvider> flips to
              // connected (children mount, Suspense resolves, first frame / FCP
              // fires). A single 1200ms drain made the flame graph look
              // "ready" while visible app work was still happening.
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
  if (!viewArgsReady) {
    // Connected but args haven't landed yet. In practice this window is
    // sub-millisecond — the child posts `zenbu:view-ready` from the
    // inline prelude and the parent replies synchronously. Rendering
    // `fallback` keeps the visual story consistent with the connecting
    // state for the rare case it stretches.
    return createElement(
      "span",
      { "data-zenbu-view-args-pending": true },
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

  // Compose KyjuProvider inside ConnectionContext so kyju's useDb /
  // useCollection hooks find their context. The KyjuProvider receives
  // the same replica + client that core stores on ConnectionContext.
  return createElement(
    ConnectionContext.Provider,
    { value: state },
    createElement(
      kyjuReact.KyjuProvider,
      { client: state.conn.db, replica: state.conn.replica, children },
    ),
  );
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
  createBlob(data: Uint8Array, hot?: boolean): Promise<string>;
  deleteBlob(blobId: string): Promise<void>;
  getBlobData(blobId: string): Promise<Uint8Array | null>;
};

export function useDbClient(): DbClient {
  return useConnection().db as unknown as DbClient;
}

export function useEvents(): EventProxy<RegisteredEvents> {
  return useConnection().events as unknown as EventProxy<RegisteredEvents>;
}

export type { CollectionRefValue };

// ---- <FocusContext>: focus-context primitive for shortcut `when` ----

/**
 * Declares a named focus region. The region is *active* whenever DOM
 * focus is anywhere inside the wrapper element (including inside
 * descendant iframes). Shortcuts registered with a matching `when`
 * clause only fire while the region is active.
 *
 * Multiple `<FocusContext>` instances nest naturally — the active
 * stack is innermost-first. You can declare more than one id at the
 * same level by passing an array (`id={["app.sidebar", "app.workspace"]}`),
 * which is exposed to the prelude as a space-separated
 * `data-zenbu-focus-context` attribute (same convention as `class`).
 *
 * `<FocusContext>` renders a `<div>` wrapper by default. Pass
 * `tabIndex={-1}` and a `ref` (or use `useFocusContext`) if you want
 * the wrapper itself to be programmatically focusable.
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
      // Route pointerdown on non-focusable children back to the wrapper
      // so clicking an unfocusable list row still "enters" the context.
      // We only steal focus when the click target isn't itself focusable
      // — buttons, inputs, links handle their own focus.
      onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        // Already focusable? Let the native behavior take over.
        if (isFocusable(target)) return;
        const wrapper = e.currentTarget;
        if (wrapper && wrapper.tabIndex >= 0) {
          // preventScroll keeps lists from jumping when the user just
          // wanted to click a row, and preventDefault below would
          // otherwise also kill text selection.
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
 * Hook companion for `<FocusContext>`. Returns:
 *
 *   - `ref`     : attach to your container (or pass to `<FocusContext
 *                 innerRef={...} tabIndex={-1}>`) so callers can
 *                 programmatically focus the region.
 *   - `active`  : true while DOM focus is inside `ref.current`.
 *                 Reactive — the component re-renders on transitions.
 *   - `focus()` : imperatively focus the container with `preventScroll`.
 *
 * The `active` flag tracks the *single* element this hook owns; for
 * "is the global stack including this id active" use
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

/**
 * Props received by a component-mode view. `args` mirrors what the
 * caller passed to `<View args=...>` (or `{}` when nothing was passed).
 *
 * The shape is intentionally minimal: anything more elaborate (per-view
 * metadata, slot info, etc.) lives in the server-side `ViewRegistryService`
 * and is read out via `useDb` from `core.lastKnownViewRegistry` if the
 * component cares.
 */
export type ViewComponentProps<
  A extends Record<string, unknown> = Record<string, unknown>,
> = {
  args: A;
};

export type ViewComponent<
  A extends Record<string, unknown> = Record<string, unknown>,
> = ComponentType<ViewComponentProps<A>>;

/**
 * In-process registry of React components keyed by view `type`. Used by
 * `<View>` when the server-side registry reports `rendering: "component"`.
 *
 * This is a plain client-side store — entries do not need to round-trip
 * to the server. The server-side `ViewRegistryService.register({ type,
 * rendering: "component", meta })` advertises the slot (icon, sidebar,
 * label, focus integration); the component itself is pushed here from
 * user-land at runtime.
 */
const viewComponentRegistry = new Map<string, ViewComponent<any>>();
const viewComponentListeners = new Set<() => void>();

function emitViewComponentChange() {
  for (const cb of viewComponentListeners) {
    try {
      cb();
    } catch {}
  }
}

/**
 * Register a React component to render for `<View type={type}>` when the
 * server-side registry has the view in `"component"` rendering mode.
 *
 * Returns an unregister function. If a different component is already
 * registered under `type`, it is replaced (last writer wins) so HMR and
 * re-renders of the registering tree behave naturally.
 */
export function registerViewComponent<
  A extends Record<string, unknown> = Record<string, unknown>,
>(type: string, Component: ViewComponent<A>): () => void {
  viewComponentRegistry.set(type, Component as ViewComponent<any>);
  emitViewComponentChange();
  return () => {
    // Only clear if we still own the slot — prevents a stale unmount
    // from blowing away a replacement registered after us.
    if (viewComponentRegistry.get(type) === (Component as ViewComponent<any>)) {
      viewComponentRegistry.delete(type);
      emitViewComponentChange();
    }
  };
}

export function getViewComponent(type: string): ViewComponent<any> | undefined {
  return viewComponentRegistry.get(type);
}

function subscribeViewComponents(cb: () => void) {
  viewComponentListeners.add(cb);
  return () => {
    viewComponentListeners.delete(cb);
  };
}

function useViewComponent(type: string): ViewComponent<any> | undefined {
  return useSyncExternalStore(
    subscribeViewComponents,
    () => viewComponentRegistry.get(type),
    () => viewComponentRegistry.get(type),
  );
}

/**
 * Convenience hook: register `Component` for `type` while the calling
 * component is mounted. Designed as the primitive for the "sentinel"
 * pattern — mount a tiny component anywhere in your tree that pushes
 * itself into the registry, optionally with advice applied. Unmounting
 * the sentinel unregisters.
 */
export function useRegisterViewComponent<
  A extends Record<string, unknown> = Record<string, unknown>,
>(type: string, Component: ViewComponent<A>): void {
  useEffect(() => {
    return registerViewComponent<A>(type, Component);
  }, [type, Component]);
}

// ---- Function registry (client-side) ----

/**
 * Opaque metadata attached to a registered function. Mirrors
 * `FunctionMeta` on the server side; consumers (`useFunctions`) can
 * filter by any field they care about — `kind` is the conventional
 * one (e.g. `kind: "cm.completion"`).
 */
export type FunctionMeta = Record<string, unknown> & {
  kind?: string;
  label?: string;
};

export type AnyFn = (...args: any[]) => any;

/**
 * What the registry actually stores. In practice this is usually a
 * function, but registered values can be anything serializable from a
 * module — e.g. a CodeMirror `Extension` (which is a value, not a
 * function). The generic on the hooks defaults to `AnyFn` for ergonomics
 * but you can pass any type at the call site (`useFunctions<Extension>(...)`).
 */
export type RegistryValue = unknown;

export interface FunctionRegistryEntry<F = AnyFn> {
  name: string;
  fn: F;
  meta?: FunctionMeta;
}

/**
 * In-process registry of functions keyed by `name`. Populated either
 * by the prelude (for service-declared source-file functions) or by
 * `registerFunction` / `useRegisterFunction` at runtime (for
 * React-scoped closures). Read via `useFunction` / `useFunctions`.
 *
 * Last-writer-wins: if both a service-declared and a React-declared
 * function share a name, whichever registered most recently is the
 * one consumers see. Same churn rule as the component-view registry.
 */
const functionRegistry = new Map<string, FunctionRegistryEntry<unknown>>();
const functionRegistryListeners = new Set<() => void>();

function emitFunctionRegistryChange() {
  for (const cb of functionRegistryListeners) {
    try {
      cb();
    } catch {}
  }
}

/**
 * Imperatively register a function under `name`. Returns an unregister
 * function. If `name` is already taken, the previous entry is replaced.
 *
 * Identity matters — calling this with a *new* function reference on
 * every render churns the registry and forces consumers to re-read.
 * Wrap closures in `useCallback` / `useMemo`, or use
 * `useRegisterFunction` which does the right thing automatically.
 */
export function registerFunction<F = AnyFn>(
  name: string,
  fn: F,
  meta?: FunctionMeta,
): () => void {
  const entry: FunctionRegistryEntry<unknown> = { name, fn, meta };
  functionRegistry.set(name, entry);
  emitFunctionRegistryChange();
  return () => {
    // Only clear if we still own the slot — keep the latest
    // registration intact when a stale dispose fires after a
    // replacement.
    if (functionRegistry.get(name) === entry) {
      functionRegistry.delete(name);
      emitFunctionRegistryChange();
    }
  };
}

function subscribeFunctionRegistry(cb: () => void) {
  functionRegistryListeners.add(cb);
  return () => {
    functionRegistryListeners.delete(cb);
  };
}

/**
 * Convenience hook: register `fn` for `name` while the calling
 * component is mounted. Re-registers when `fn` identity or `name`
 * changes; unregisters on unmount.
 *
 * Wrap your function in `useCallback` so dependencies decide when
 * to re-register — otherwise you'll churn the registry every render.
 */
export function useRegisterFunction<F = AnyFn>(
  name: string,
  fn: F,
  meta?: FunctionMeta,
): void {
  // Stringify meta for the effect deps so callers don't need to
  // memoize the meta object themselves. Cheap because meta is small.
  const metaKey = useMemo(
    () => (meta === undefined ? "" : JSON.stringify(meta)),
    [meta],
  );
  useEffect(() => {
    return registerFunction(name, fn, meta);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, fn, metaKey]);
}

/**
 * Read one registered function by `name`. Reactive: re-renders when
 * the entry is added, replaced, or removed.
 */
export function useFunction<F = AnyFn>(name: string): F | undefined {
  return useSyncExternalStore(
    subscribeFunctionRegistry,
    () => functionRegistry.get(name)?.fn as F | undefined,
    () => functionRegistry.get(name)?.fn as F | undefined,
  );
}

export type FunctionsFilter =
  | { kind?: string; [k: string]: unknown }
  | ((entry: FunctionRegistryEntry) => boolean);

function matchesFilter(
  entry: FunctionRegistryEntry<unknown>,
  filter: FunctionsFilter | undefined,
): boolean {
  if (filter === undefined) return true;
  if (typeof filter === "function") return filter(entry as FunctionRegistryEntry);
  const meta = entry.meta ?? {};
  for (const [k, v] of Object.entries(filter)) {
    if ((meta as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

/**
 * Read every registered function, optionally filtered by `meta`
 * fields or a predicate. Reactive: re-renders when the registry
 * changes (entries added/removed/replaced). The returned array is a
 * fresh reference on every change — stable across renders that
 * don't affect the registry.
 *
 *   useFunctions()                          → all entries
 *   useFunctions({ kind: "cm.completion" }) → entries whose meta.kind === "cm.completion"
 *   useFunctions((e) => e.name.startsWith("git."))
 */
export function useFunctions<F = AnyFn>(
  filter?: FunctionsFilter,
): Array<FunctionRegistryEntry<F>> {
  // Hold the same snapshot reference across reads that produce an
  // equal result. `useSyncExternalStore` requires a stable snapshot
  // identity for skipping re-renders.
  const lastSnapshotRef = useRef<Array<FunctionRegistryEntry<F>>>([]);
  const lastKeyRef = useRef<string>("");

  const getSnapshot = () => {
    const matches: Array<FunctionRegistryEntry<F>> = [];
    for (const entry of functionRegistry.values()) {
      if (matchesFilter(entry, filter)) {
        matches.push(entry as FunctionRegistryEntry<F>);
      }
    }
    // Cheap structural key — names + fn identity ordering. If both
    // are identical to last call, return the cached array so
    // downstream `useMemo` / effect deps don't churn.
    const key = matches.map((m) => m.name).join("\u0000");
    if (key === lastKeyRef.current && matches.length === lastSnapshotRef.current.length) {
      // Identity check on each fn so a replacement of the same name
      // still produces a fresh snapshot.
      let same = true;
      for (let i = 0; i < matches.length; i++) {
        if (matches[i]!.fn !== lastSnapshotRef.current[i]!.fn) {
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
    subscribeFunctionRegistry,
    getSnapshot,
    getSnapshot,
  );
}

// ---- <View>: iframe-or-component primitive ----

/**
 * Mounts a registered view (separate Vite root, registered via
 * `ViewRegistryService.register(type, …)`) inside an `<iframe>` and:
 *
 * 1. **Auto-inherits auth from the parent iframe's URL.** Reads `wsPort` /
 *    `wsToken` from `window.location.search` and forwards them in the
 *    child URL so the child's `<ZenbuProvider>` connects without the
 *    consumer wiring anything.
 * 2. **Mount-once src.** The iframe's `src` is set on first mount and
 *    *never updated*. Toggling `visible` only flips `style.display` —
 *    state inside the child (sockets, ghostty terminals, etc.) survives
 *    visibility changes.
 * 3. **Args via postMessage handshake.** Args are *never* serialized into
 *    the iframe URL — they can be arbitrarily large and would blow past
 *    URL length limits and pollute devtools. Instead, the child's inline
 *    prelude (`installViewArgsListener`) installs a `message` listener
 *    synchronously in `<head>` and posts `{ kind: "zenbu:view-ready" }`
 *    to its parent. This `<View>` listens for that ping and replies with
 *    `{ kind: "zenbu:view-args", args }`. The handshake guarantees the
 *    first args message can't be dropped: the child only announces
 *    readiness after its listener is attached.
 * 4. **Reactive updates via postMessage.** When `args` changes after
 *    mount, we re-post `{ kind: "zenbu:view-args", args }`. URL is
 *    never rewritten (iframe stays alive).
 *
 * Child sessions die on unmount. There is no cache: if the consumer
 * unmounts the `<View>` element, any state inside it (e.g. PTY sockets)
 * is gone. Caller is responsible for explicit teardown via RPC if
 * needed.
 */
export type ViewProps = {
  /** Registered view type — first arg to `ViewRegistryService.register`. */
  type: string;
  /** Initial args; serialized into the child URL as base64-JSON. */
  args?: Record<string, unknown>;
  /** When false, sets `style.display: none`. Iframe is NOT unmounted. */
  visible?: boolean;
  style?: CSSProperties;
  className?: string;
  onLoad?: () => void;
  /** Rendered while the view registry has not yet reported a URL for this type. */
  fallback?: ReactNode;
};

const VIEW_ARGS_MESSAGE_KIND = "zenbu:view-args";
const VIEW_READY_MESSAGE_KIND = "zenbu:view-ready";
const VIEW_THEME_MESSAGE_KIND = "zenbu:view-theme";

/**
 * Shadcn-standard design tokens we forward from the host's `:root` into
 * every plugin iframe. The host *defines* these in its own CSS (it's
 * already shadcn or shadcn-compatible). The framework just reads them
 * off `getComputedStyle(document.documentElement)` and propagates them
 * to plugin views so the views automatically match the host's theme.
 *
 * Extending this list later doesn't break older plugins because they
 * just won't reference the newer vars.
 */
const HOST_THEME_TOKENS: readonly string[] = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--popover",
  "--popover-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--border",
  "--input",
  "--ring",
  "--radius",
];

const VIEW_BACKGROUND_TOKEN = "--zenbu-view-background";
const VIEW_FOREGROUND_TOKEN = "--zenbu-view-foreground";
const VIEW_COLOR_SCHEME_TOKEN = "--zenbu-view-color-scheme";


/**
 * Read the configured set of host theme tokens off `:root`. Empty
 * strings are skipped — lets the host omit individual vars without
 * having to define every shadcn slot.
 */
function isTransparentColor(value: string): boolean {
  return (
    value === "transparent" ||
    value === "rgba(0, 0, 0, 0)" ||
    value === "rgba(0,0,0,0)"
  );
}

function inferColorScheme(rootStyle: CSSStyleDeclaration): "light" | "dark" {
  const declared = rootStyle.colorScheme;
  if (declared.split(/\s+/).includes("dark")) return "dark";
  if (declared.split(/\s+/).includes("light")) return "light";
  if (document.documentElement.classList.contains("dark")) return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readHostTheme(): Record<string, string> {
  if (typeof document === "undefined") return {};
  const rootStyle = getComputedStyle(document.documentElement);
  const bodyStyle = document.body ? getComputedStyle(document.body) : rootStyle;
  const tokens: Record<string, string> = {};
  for (const name of HOST_THEME_TOKENS) {
    const value = rootStyle.getPropertyValue(name).trim();
    if (value) tokens[name] = value;
  }

  const tokenBackground = tokens["--background"];
  const bodyBackground = bodyStyle.backgroundColor.trim();
  const rootBackground = rootStyle.backgroundColor.trim();
  const background = tokenBackground
    || (!isTransparentColor(bodyBackground)
      ? bodyBackground
      : !isTransparentColor(rootBackground)
        ? rootBackground
        : undefined);
  if (background) tokens[VIEW_BACKGROUND_TOKEN] = background;

  const foreground = tokens["--foreground"] || bodyStyle.color.trim() || rootStyle.color.trim();
  if (foreground) tokens[VIEW_FOREGROUND_TOKEN] = foreground;
  tokens[VIEW_COLOR_SCHEME_TOKEN] = inferColorScheme(rootStyle);

  return tokens;
}

function encodeViewTheme(tokens: Record<string, string>): string | null {
  if (Object.keys(tokens).length === 0) return null;
  try {
    return btoa(unescape(encodeURIComponent(JSON.stringify(tokens))));
  } catch (err) {
    console.warn("[zenbu/View] failed to encode theme:", err);
    return null;
  }
}

function buildViewThemeCss(tokens: Record<string, string>): string {
  const root =
    ":root:root{" +
    Object.keys(tokens)
      .map((k) => `${k}:${tokens[k]}`)
      .join(";") +
    "}";
  const background = `var(${VIEW_BACKGROUND_TOKEN}, var(--background, Canvas))`;
  const foreground = `var(${VIEW_FOREGROUND_TOKEN}, var(--foreground, CanvasText))`;
  const colorScheme = `var(${VIEW_COLOR_SCHEME_TOKEN}, normal)`;
  return (
    root +
    `html,body,#root{width:100%;height:100%;background:${background};color:${foreground};color-scheme:${colorScheme}}` +
    "body{margin:0}"
  );
}

function buildPendingViewSrcDoc(tokens: Record<string, string>): string {
  return `<!doctype html><html><head><style>${buildViewThemeCss(tokens)}</style></head><body><div id="root"></div></body></html>`;
}

function buildViewUrl(
  baseUrl: string,
  type: string,
  encodedTheme: string | null,
): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  const parentParams = new URLSearchParams(window.location.search);
  const params = new URLSearchParams();
  const wsPort = parentParams.get("wsPort");
  const wsToken = parentParams.get("wsToken");
  if (wsPort) params.set("wsPort", wsPort);
  if (wsToken) params.set("wsToken", wsToken);
  params.set("type", type);
  // NOTE: args intentionally NOT included — they go over postMessage so
  // arbitrarily large payloads can't blow past URL length limits.
  if (encodedTheme) params.set("theme", encodedTheme);
  return `${trimmed}/?${params.toString()}`;
}

function shallowJSONEqual(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function View({
  type,
  args,
  visible = true,
  style,
  className,
  onLoad,
  fallback = null,
}: ViewProps): ReactElement {
  // The view registry is replicated to the renderer via the core db slice.
  // We read both the URL (iframe mode) and the rendering kind in one
  // selector so the component branch doesn't have to wait on a separate
  // round trip.
  const entry = useDb((root) =>
    (
      root as unknown as {
        core: {
          lastKnownViewRegistry: Array<{
            type: string;
            url: string;
            rendering?: "iframe" | "component";
          }>;
        };
      }
    ).core.lastKnownViewRegistry.find((v) => v.type === type) ?? null,
  );
  const rendering = entry?.rendering ?? "iframe";
  const url = entry?.url ?? null;
  const ComponentImpl = useViewComponent(type);

  if (rendering === "component") {
    // Component views bypass the iframe pipeline entirely: no Vite, no
    // theme forwarding (we share the host's CSS scope), no postMessage
    // bridge. We still honor `visible` so callers can flip a component
    // view in/out the same way they can an iframe view.
    if (!ComponentImpl) {
      return createElement(
        "span",
        {
          "data-zenbu-view-pending": type,
          style: {
            display: visible ? style?.display ?? "contents" : "none",
            ...style,
          },
          className,
        },
        fallback,
      );
    }
    const wrapperStyle: CSSProperties = {
      ...style,
      display: visible ? style?.display ?? "contents" : "none",
    };
    return createElement(
      "div",
      {
        className,
        style: wrapperStyle,
        "data-zenbu-view": type,
        "data-zenbu-view-rendering": "component",
      },
      createElement(
        ViewArgsContext.Provider,
        { value: (args ?? {}) as Record<string, unknown> },
        createElement(ComponentImpl, { args: args ?? {} }),
      ),
    );
  }

  const rpc = useRpc();
  // (iframe-mode path below)

  // Lazy views start with an empty `url`. Fire `core.viewRegistry.ensure`
  // to kick off the on-demand Vite server boot — the URL will appear in
  // `lastKnownViewRegistry` once the server is listening and this hook
  // will re-render with the real URL. Best-effort; eager views just
  // hit the early-return path.
  useEffect(() => {
    if (url) return;
    const ensure = rpc?.core?.viewRegistry?.ensure;
    if (typeof ensure !== "function") return;
    let cancelled = false;
    void ensure({ type })
      .catch((err: unknown) => {
        if (!cancelled) {
          console.warn(`[zenbu/View] ensure("${type}") failed:`, err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [type, url, rpc]);

  // Snapshot the iframe URL on first commit and never recompute. Changes to
  // `args` after mount go via postMessage — rewriting `src` would reload
  // the iframe and trash any in-flight state.
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const initialUrlRef = useRef<string | null>(null);
  const lastThemeRef = useRef<Record<string, string> | null>(null);
  const loadedRef = useRef(false);
  // Always-current args reference so the `view-ready` handshake and the
  // args-change effect both post the freshest value. React closures over
  // `args` would otherwise risk responding to a ready ping with a stale
  // snapshot if the parent re-rendered before the child finished loading.
  const argsRef = useRef<Record<string, unknown>>(args ?? {});
  argsRef.current = args ?? {};

  if (initialUrlRef.current === null && url) {
    const theme = readHostTheme();
    const encodedTheme = encodeViewTheme(theme);
    lastThemeRef.current = theme;
    initialUrlRef.current = buildViewUrl(url, type, encodedTheme);
  }

  // Respond to the child's `zenbu:view-ready` ping with the current args.
  // The child's prelude installs its listener synchronously at HTML parse
  // time and pings us before any user code runs, so this handshake races
  // ahead of `useViewArgs` mounting in the child and the first message is
  // never dropped.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe) return;
      if (event.source !== iframe.contentWindow) return;
      const data = event.data as { kind?: string } | null;
      if (!data || data.kind !== VIEW_READY_MESSAGE_KIND) return;
      iframe.contentWindow?.postMessage(
        { kind: VIEW_ARGS_MESSAGE_KIND, args: argsRef.current },
        "*",
      );
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // Push reactive updates whenever args change post-mount. Before the
  // iframe has loaded, the ready handshake above will deliver the latest
  // `argsRef.current` once the child pings us, so we don't need a
  // separate `load`-event branch here.
  const lastArgsJsonRef = useRef<string | null>(null);
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    if (!loadedRef.current) return;
    let serialized: string;
    try {
      serialized = JSON.stringify(args ?? {});
    } catch {
      serialized = "";
    }
    if (serialized === lastArgsJsonRef.current) return;
    lastArgsJsonRef.current = serialized;
    iframe.contentWindow?.postMessage(
      { kind: VIEW_ARGS_MESSAGE_KIND, args: args ?? {} },
      "*",
    );
  }, [args]);

  // Track host theme changes and push them into the iframe so plugin
  // views automatically follow toggles (dark mode, theme picker, OS
  // `prefers-color-scheme`). The *initial* paint is handled by the
  // `?theme=` URL param above plus vite's `transformIndexHtml` (which
  // inlines a synchronous `<style>` before any other CSS) — this hook
  // is for live updates only.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const pushIfChanged = () => {
      const tokens = readHostTheme();
      if (shallowJSONEqual(tokens, lastThemeRef.current)) return;
      lastThemeRef.current = tokens;
      const iframe = iframeRef.current;
      if (!iframe?.contentWindow) return;
      const send = () =>
        iframe.contentWindow?.postMessage(
          { kind: VIEW_THEME_MESSAGE_KIND, tokens },
          "*",
        );
      if (loadedRef.current) send();
      else iframe.addEventListener("load", send, { once: true });
    };

    // Catches class / data-theme / inline style swaps on <html>, which
    // is how shadcn-style theme pickers usually flip palettes.
    const observer = new MutationObserver(pushIfChanged);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });

    // Catches OS-level dark mode toggles when the host follows the
    // system theme.
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", pushIfChanged);

    return () => {
      observer.disconnect();
      media.removeEventListener("change", pushIfChanged);
    };
  }, []);

  if (lastThemeRef.current === null) {
    lastThemeRef.current = readHostTheme();
  }

  const frameBackground = lastThemeRef.current?.[VIEW_BACKGROUND_TOKEN];
  const frameColorScheme = lastThemeRef.current?.[VIEW_COLOR_SCHEME_TOKEN];
  const frameStyle: CSSProperties = {
    border: "none",
    backgroundColor: frameBackground,
    colorScheme:
      frameColorScheme === "dark" || frameColorScheme === "light"
        ? frameColorScheme
        : undefined,
    ...style,
    display: visible ? style?.display ?? "block" : "none",
  };

  if (!initialUrlRef.current) {
    return createElement("iframe", {
      ref: iframeRef,
      srcDoc: buildPendingViewSrcDoc(lastThemeRef.current),
      className,
      style: frameStyle,
      "data-zenbu-view-pending": type,
      "aria-label": typeof fallback === "string" ? fallback : `Loading ${type}`,
    });
  }

  return createElement("iframe", {
    ref: iframeRef,
    src: initialUrlRef.current,
    className,
    style: frameStyle,
    onLoad: () => {
      loadedRef.current = true;
      onLoad?.();
    },
  });
}

/**
 * Read the current view args inside a child iframe rendered by `<View>`.
 *
 * Args arrive entirely over `postMessage` — see the `<View>` doc-block
 * for the handshake. The early `installViewArgsListener` prelude
 * captures messages before any user code runs and stores them on
 * `window.__zenbuViewArgs`. `<ZenbuProvider>` gates rendering on the
 * first args message arriving, so by the time any component calls this
 * hook the global is guaranteed to be populated. That means the return
 * type is non-null and the consumer never has to handle a loading state.
 */
export function useViewArgs<T extends Record<string, unknown>>(): T {
  // Component-mode views are wrapped in `<ViewArgsContext.Provider>` by
  // `<View>`. Iframe-mode views don't have a parent context (different
  // realm) and fall back to the postMessage-fed global store.
  const ctxArgs = useContext(ViewArgsContext);
  const store =
    typeof window !== "undefined" ? window.__zenbuViewArgs : undefined;

  const [args, setArgs] = useState<T>(() => {
    if (ctxArgs) return ctxArgs as T;
    return (store?.current ?? ({} as Record<string, unknown>)) as T;
  });

  // When the context value changes (parent re-rendered `<View args=...>`
  // with new args), follow it. The postMessage subscription below only
  // runs when there's no context — i.e. iframe-mode.
  useEffect(() => {
    if (ctxArgs) setArgs(ctxArgs as T);
  }, [ctxArgs]);

  useEffect(() => {
    if (ctxArgs) return; // component-mode: the context path above wins.
    if (!store) return;
    // Catch the case where args arrived between our state initializer
    // and the subscription below (shouldn't happen if ZenbuProvider
    // gates correctly, but cheap to guard).
    if (store.current && store.current !== (args as unknown)) {
      setArgs(store.current as T);
    }
    const listener = (next: Record<string, unknown>) => {
      setArgs(next as T);
    };
    store.listeners.add(listener);
    return () => {
      store.listeners.delete(listener);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxArgs]);

  return args;
}

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
  type CSSProperties,
  type ReactElement,
  type ReactNode,
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
import { ClientStateStore, type StateWireMessage } from "./state";

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
  state: ClientStateStore;
};

type ConnectionState =
  | { status: "connecting" }
  | { status: "connected"; conn: Connection }
  | { status: "error"; error: string };

const ConnectionContext = createContext<ConnectionState | null>(null);

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

          // Service in-memory state replica. Pure receive — there is no
          // client→server channel in v1 (writes still go through RPC).
          const stateStore = new ClientStateStore();
          const stateHandler = (e: MessageEvent) => {
            try {
              const msg = JSON.parse(e.data);
              if (msg?.ch !== "state") return;
              stateStore.apply(msg.data as StateWireMessage);
            } catch {
              // Non-JSON or unrelated frame — other channel handlers
              // already inspected it.
            }
          };
          ws.addEventListener("message", stateHandler);
          const disconnectState = () =>
            ws.removeEventListener("message", stateHandler);

          if (cancelled) {
            disconnectState();
            await disconnectDb();
            disconnectRpc();
            ws.close();
            return;
          }

          // View type is encoded in the URL by `WindowService.openView`. It
          // can land in either of two places — a `/views/<type>/` path
          // segment (used by plugins that mount a multi-page Vite layout) or
          // a `?type=<name>` query param (the default route). Mirrors
          // `resolveType()` in `vite-plugins.ts` so the two parsers can't
          // drift apart.
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
            disconnectState();
            disconnectDb();
            disconnectRpc();
            ws.close();
          };

          setState({
            status: "connected",
            conn: {
              rpc: rpc as AnyRpc,
              events: events as AnyEvents,
              db: db as AnyDbClient,
              replica,
              state: stateStore,
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

// ---- Service state hook ----

/**
 * Shape of the renderer's flat-to-nested view of service state cells.
 * Generated codegen lives elsewhere; the public hook accepts an
 * `unknown`-typed tree so plugin authors can cast at the selector
 * boundary until typegen lands.
 */
export type ServiceStateTree = Record<string, unknown>;

/**
 * Subscribe to a slice of a service's in-memory state. Mirrors `useDb` —
 * pass a selector that walks `tree[plugin][service][field]`. Re-renders
 * when the selected value changes (compared with `isEqual`, default
 * `Object.is`).
 *
 *   const status = useServiceState<"idle" | "running">(
 *     (s) => (s.core as any)["server-status"].status,
 *   )
 *
 * Returns `undefined` for any unknown path — the snapshot may not have
 * arrived yet, or the owning service is not currently registered. Use
 * a default value (`?? "idle"`) at the call site.
 */
export function useServiceState<T>(
  selector: (tree: ServiceStateTree) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const store = useConnection().state;
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const isEqualRef = useRef(isEqual);
  isEqualRef.current = isEqual;
  const lastRef = useRef<{ has: boolean; value: T }>({
    has: false,
    value: undefined as T,
  });

  const getSnapshot = () => {
    const next = selectorRef.current(store.getTree());
    if (lastRef.current.has && isEqualRef.current(lastRef.current.value, next)) {
      return lastRef.current.value;
    }
    lastRef.current = { has: true, value: next };
    return next;
  };

  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    getSnapshot,
    getSnapshot,
  );
}

export type { CollectionRefValue };

// ---- <View>: child-iframe primitive ----

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
 * 3. **Initial args via URL.** `args` is encoded as base64 JSON in
 *    `?args=` on first paint so the child can render without waiting on
 *    a postMessage handshake. Use `useViewArgs<T>()` inside the child
 *    to read.
 * 4. **Reactive args via postMessage.** When `args` changes after mount,
 *    we send `{ kind: "zenbu:view-args", args }` to the iframe's
 *    `contentWindow`. URL is *not* rewritten (iframe stays alive).
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
const VIEW_ARGS_PARAM_LIMIT = 1500;

function encodeViewArgs(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  try {
    return btoa(unescape(encodeURIComponent(JSON.stringify(args))));
  } catch (err) {
    console.warn("[zenbu/View] failed to encode args:", err);
    return null;
  }
}

function decodeViewArgs<T>(encoded: string | null): T {
  if (!encoded) return {} as T;
  try {
    return JSON.parse(decodeURIComponent(escape(atob(encoded)))) as T;
  } catch (err) {
    console.warn("[zenbu/View] failed to decode args:", err);
    return {} as T;
  }
}

function buildViewUrl(
  baseUrl: string,
  type: string,
  encodedArgs: string | null,
): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  const parentParams = new URLSearchParams(window.location.search);
  const params = new URLSearchParams();
  const wsPort = parentParams.get("wsPort");
  const wsToken = parentParams.get("wsToken");
  if (wsPort) params.set("wsPort", wsPort);
  if (wsToken) params.set("wsToken", wsToken);
  params.set("type", type);
  if (encodedArgs) params.set("args", encodedArgs);
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
  // The view registry is now a service in-memory state cell on
  // ViewRegistryService — read it reactively without round-tripping
  // through the DB. Returns null until the snapshot arrives or until a
  // view of this type is registered.
  const url = useServiceState((s) => {
    const entries = (
      s as { core?: { ["view-registry"]?: { registry?: Array<{ type: string; url: string }> } } }
    )?.core?.["view-registry"]?.registry;
    if (!Array.isArray(entries)) return null;
    return entries.find((v) => v.type === type)?.url ?? null;
  });

  // Snapshot the iframe URL on first commit and never recompute. Changes to
  // `args` after mount go via postMessage — rewriting `src` would reload
  // the iframe and trash any in-flight state.
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const initialUrlRef = useRef<string | null>(null);
  const lastArgsRef = useRef<string | null>(null);
  const loadedRef = useRef(false);

  if (initialUrlRef.current === null && url) {
    const encoded = encodeViewArgs(args);
    if (encoded && encoded.length > VIEW_ARGS_PARAM_LIMIT) {
      console.warn(
        `[zenbu/View] args for "${type}" exceed ${VIEW_ARGS_PARAM_LIMIT} chars in URL — consider postMessage-only updates.`,
      );
    }
    lastArgsRef.current = encoded;
    initialUrlRef.current = buildViewUrl(url, type, encoded);
  }

  useEffect(() => {
    if (!iframeRef.current) return;
    const encoded = encodeViewArgs(args);
    if (shallowJSONEqual(encoded, lastArgsRef.current)) return;
    lastArgsRef.current = encoded;

    const send = () => {
      iframeRef.current?.contentWindow?.postMessage(
        { kind: VIEW_ARGS_MESSAGE_KIND, args: args ?? {} },
        "*",
      );
    };
    if (loadedRef.current) {
      send();
    } else {
      // Will fire from the iframe's onLoad below.
      const iframe = iframeRef.current;
      const onceLoaded = () => {
        send();
        iframe.removeEventListener("load", onceLoaded);
      };
      iframe.addEventListener("load", onceLoaded);
      return () => iframe.removeEventListener("load", onceLoaded);
    }
  }, [args]);

  if (!initialUrlRef.current) {
    return createElement(
      "span",
      { "data-zenbu-view-pending": type },
      fallback,
    );
  }

  return createElement("iframe", {
    ref: iframeRef,
    src: initialUrlRef.current,
    className,
    style: { border: "none", ...style, display: visible ? style?.display ?? "block" : "none" },
    onLoad: () => {
      loadedRef.current = true;
      onLoad?.();
    },
  });
}

/**
 * Read the current view args inside a child iframe rendered by `<View>`.
 * Initial value comes from `?args=` in the iframe's URL; updates arrive
 * via `postMessage` and re-render this hook's caller.
 */
export function useViewArgs<T extends Record<string, unknown>>(): T {
  const [args, setArgs] = useState<T>(() => {
    const params = new URLSearchParams(
      typeof window !== "undefined" ? window.location.search : "",
    );
    return decodeViewArgs<T>(params.get("args"));
  });

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if ((data as { kind?: string }).kind !== VIEW_ARGS_MESSAGE_KIND) return;
      const next = (data as { args?: T }).args;
      if (next && typeof next === "object") setArgs(next);
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  return args;
}

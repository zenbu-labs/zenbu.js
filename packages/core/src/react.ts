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

          if (cancelled) {
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
              // Drain again on next tick to catch FCP / LCP marks that fire
              // a frame or two after connect.
              setTimeout(() => {
                const more = bt.drain();
                if (more.length > 0 && typeof reporter === "function") {
                  void reporter({
                    events: more,
                    timeOrigin: bt.timeOrigin,
                  }).catch(() => {});
                }
              }, 1200);
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

/**
 * Read the configured set of host theme tokens off `:root`. Empty
 * strings are skipped — lets the host omit individual vars without
 * having to define every shadcn slot.
 */
function readHostTheme(): Record<string, string> {
  if (typeof document === "undefined") return {};
  const style = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const name of HOST_THEME_TOKENS) {
    const value = style.getPropertyValue(name).trim();
    if (value) tokens[name] = value;
  }
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

function buildViewUrl(
  baseUrl: string,
  type: string,
  encodedArgs: string | null,
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
  if (encodedArgs) params.set("args", encodedArgs);
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
  const url = useDb((root) =>
    (
      root as unknown as {
        core: { lastKnownViewRegistry: Array<{ type: string; url: string }> };
      }
    ).core.lastKnownViewRegistry.find((v) => v.type === type)?.url ?? null,
  );
  const rpc = useRpc() as any;

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
  const lastArgsRef = useRef<string | null>(null);
  const lastThemeRef = useRef<Record<string, string> | null>(null);
  const loadedRef = useRef(false);

  if (initialUrlRef.current === null && url) {
    const encodedArgs = encodeViewArgs(args);
    if (encodedArgs && encodedArgs.length > VIEW_ARGS_PARAM_LIMIT) {
      console.warn(
        `[zenbu/View] args for "${type}" exceed ${VIEW_ARGS_PARAM_LIMIT} chars in URL — consider postMessage-only updates.`,
      );
    }
    const theme = readHostTheme();
    const encodedTheme = encodeViewTheme(theme);
    lastArgsRef.current = encodedArgs;
    lastThemeRef.current = theme;
    initialUrlRef.current = buildViewUrl(url, type, encodedArgs, encodedTheme);
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

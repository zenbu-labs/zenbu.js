/**
 * View-args listener installed into every Zenbu view iframe by the inline
 * framework prelude. It exists for one reason: view args can be arbitrarily
 * large and must not ride the iframe URL (URLs have hard per-platform
 * limits — Chromium's is around 2 MB, but practically anything past a few
 * KB starts breaking devtools, navigation, and embedded URLs).
 *
 * Protocol
 * --------
 *
 * 1. The parent `<View>` element creates an iframe with **no** `?args=`
 *    query param.
 * 2. This prelude runs synchronously in the iframe's `<head>` before any
 *    other module loads. It installs a `message` listener and stores the
 *    latest args on `window.__zenbuViewArgs.current`.
 * 3. The prelude posts `{ kind: "zenbu:view-ready" }` to `window.parent`.
 *    The parent responds with `{ kind: "zenbu:view-args", args }`. This
 *    handshake guarantees the args message is never dropped: the child
 *    only announces readiness *after* its listener is attached, and the
 *    parent only sends *after* it has received the readiness signal.
 * 4. Subsequent args updates from the parent flow through the same
 *    `zenbu:view-args` channel; subscribers registered via
 *    `window.__zenbuViewArgs.listeners` re-render.
 *
 * The companion React hook `useViewArgs<T>(): T` reads from this global.
 * `<ZenbuProvider>` blocks rendering children until
 * `window.__zenbuViewArgs.ready` resolves, so consumers see a non-null,
 * fully-typed args object on first render.
 */

type ViewArgs = Record<string, unknown>;

declare global {
  interface Window {
    __zenbuViewArgs?: {
      /** Latest args received from the parent. `null` until the first message. */
      current: ViewArgs | null;
      /** Subscribers notified on every args update (including the first). */
      listeners: Set<(args: ViewArgs) => void>;
      /** Resolves once the first args message has arrived. */
      ready: Promise<ViewArgs>;
    };
  }
}

const VIEW_ARGS_MESSAGE_KIND = "zenbu:view-args";
const VIEW_READY_MESSAGE_KIND = "zenbu:view-ready";

export function installViewArgsListener(): void {
  if (typeof window === "undefined") return;
  if (window.__zenbuViewArgs) return;

  const listeners = new Set<(args: ViewArgs) => void>();
  let resolveReady!: (args: ViewArgs) => void;
  const ready = new Promise<ViewArgs>((resolve) => {
    resolveReady = resolve;
  });

  const store = {
    current: null as ViewArgs | null,
    listeners,
    ready,
  };
  window.__zenbuViewArgs = store;

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    const data = event.data as { kind?: string; args?: unknown } | null;
    if (!data || data.kind !== VIEW_ARGS_MESSAGE_KIND) return;
    const args = data.args;
    if (!args || typeof args !== "object" || Array.isArray(args)) return;
    const next = args as ViewArgs;
    const isFirst = store.current === null;
    store.current = next;
    if (isFirst) resolveReady(next);
    for (const listener of listeners) {
      try {
        listener(next);
      } catch (err) {
        console.warn("[zenbu/view-args] listener threw:", err);
      }
    }
  });

  // Tell the parent we're ready to receive args. The parent attaches its
  // `message` listener synchronously when the iframe element mounts (well
  // before this script runs in the child), so by the time we post here
  // the parent is guaranteed to be listening. We re-announce on
  // `DOMContentLoaded` as belt-and-suspenders for any pathological case
  // (e.g. parent in the middle of a synchronous block when we first post).
  const announce = () => {
    try {
      window.parent?.postMessage({ kind: VIEW_READY_MESSAGE_KIND }, "*");
    } catch {
      // Cross-origin or detached parent — nothing we can do.
    }
  };
  announce();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", announce, { once: true });
  }
}

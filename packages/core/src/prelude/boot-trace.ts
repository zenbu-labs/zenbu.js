/**
 * Boot-trace renderer prelude.
 *
 * Loaded as the very first <script type="module"> in every Zenbu iframe
 * (see `vite-plugins.ts`). Sets up `window.__zenbuBootTrace` with `mark`
 * / `span` helpers and auto-records:
 *
 *   - prelude-start   (this module's top level)
 *   - dom-content-loaded
 *   - load
 *   - fcp (first contentful paint, via PerformanceObserver)
 *   - lcp (largest contentful paint)
 *
 * Events are buffered until the websocket connects and `ZenbuProvider`
 * forwards them via `rpc.core.bootTrace.report(events)`. The framework
 * then merges them into the main-process trace and renders them in the
 * unified flame.
 *
 * Anchored to the iframe's `performance.timeOrigin` so the `at` timestamps
 * are comparable to the main process by converting through `Date.now()` —
 * see `bootTrace.addEvents` in the host's `BootTraceService.report`.
 */

type RendererEvent =
  | {
      kind: "span";
      name: string;
      startedAt: number; // ms since timeOrigin
      endedAt: number;
      durationMs: number;
      parent: string | null;
      meta?: Record<string, unknown>;
    }
  | {
      kind: "mark";
      name: string;
      at: number; // ms since timeOrigin
      meta?: Record<string, unknown>;
    };

interface BootTraceAPI {
  /** Wall-clock ms when this iframe started executing (epoch). */
  timeOrigin: number;
  /** Buffered events not yet forwarded to the host. */
  buffer: RendererEvent[];
  mark(name: string, meta?: Record<string, unknown>): void;
  span<T>(name: string, fn: () => T | Promise<T>, meta?: Record<string, unknown>): Promise<T>;
  spanSync<T>(name: string, fn: () => T, meta?: Record<string, unknown>): T;
  /** Called by the framework provider once the RPC connection is up. */
  drain(): RendererEvent[];
}

function installBootTrace(viewType: string): void {
  const w = window as unknown as { __zenbuBootTrace?: BootTraceAPI };
  if (w.__zenbuBootTrace) return;

  const buffer: RendererEvent[] = [];
  const openSpans: Array<{
    name: string;
    startedAt: number;
    parent: string | null;
    meta?: Record<string, unknown>;
  }> = [];

  const now = (): number => performance.now();

  const prefix = `renderer[${viewType}]:`;

  const mark = (name: string, meta?: Record<string, unknown>): void => {
    buffer.push({
      kind: "mark",
      name: prefix + name,
      at: now(),
      ...(meta ? { meta } : {}),
    });
  };

  const finishSpan = (
    open: { name: string; startedAt: number; parent: string | null; meta?: Record<string, unknown> },
  ): void => {
    const endedAt = now();
    buffer.push({
      kind: "span",
      name: prefix + open.name,
      startedAt: open.startedAt,
      endedAt,
      durationMs: endedAt - open.startedAt,
      parent: open.parent ? prefix + open.parent : null,
      ...(open.meta ? { meta: open.meta } : {}),
    });
  };

  const span = async <T>(
    name: string,
    fn: () => T | Promise<T>,
    meta?: Record<string, unknown>,
  ): Promise<T> => {
    const parent = openSpans[openSpans.length - 1]?.name ?? null;
    const open = { name, startedAt: now(), parent, meta };
    openSpans.push(open);
    try {
      return await fn();
    } finally {
      const popped = openSpans.pop();
      if (popped) finishSpan(popped);
    }
  };

  const spanSync = <T>(
    name: string,
    fn: () => T,
    meta?: Record<string, unknown>,
  ): T => {
    const parent = openSpans[openSpans.length - 1]?.name ?? null;
    const open = { name, startedAt: now(), parent, meta };
    openSpans.push(open);
    try {
      return fn();
    } finally {
      const popped = openSpans.pop();
      if (popped) finishSpan(popped);
    }
  };

  const drain = (): RendererEvent[] => {
    const out = buffer.splice(0, buffer.length);
    return out;
  };

  w.__zenbuBootTrace = {
    timeOrigin: performance.timeOrigin,
    buffer,
    mark,
    span,
    spanSync,
    drain,
  };

  // ---- auto marks ----

  mark("prelude-start");

  // DOMContentLoaded fires when HTML is parsed; `load` waits for subresources.
  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      () => mark("dom-content-loaded"),
      { once: true },
    );
  } else {
    mark("dom-content-loaded");
  }
  window.addEventListener("load", () => mark("load"), { once: true });

  // First / Largest contentful paint via PerformanceObserver. Wrapped in
  // try/catch because Electron's blink can sometimes report these as
  // already buffered, in which case we read them out of the entries
  // immediately.
  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === "paint") {
          mark(entry.name); // "first-paint" | "first-contentful-paint"
        } else if (entry.entryType === "largest-contentful-paint") {
          mark("largest-contentful-paint", { size: (entry as any).size });
        }
      }
    });
    po.observe({ type: "paint", buffered: true });
    po.observe({ type: "largest-contentful-paint", buffered: true });
  } catch {
    // unsupported environment — drop silently
  }
}

/**
 * Exported entry point used by the per-iframe advice prelude. Call site:
 *   import { installBootTraceRenderer } from "@zenbu/core/prelude/boot-trace"
 *   installBootTraceRenderer(<viewType>)
 */
export function installBootTraceRenderer(viewType: string): void {
  installBootTrace(viewType);
}

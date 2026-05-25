/**
 * BootTraceService — main-process sink for renderer boot-trace events.
 *
 * `ZenbuProvider` drains `window.__zenbuBootTrace.buffer` on connect and
 * calls `rpc.core.bootTrace.report(...)` so the events land in the same
 * `bootTrace` singleton the rest of the framework writes to. From there
 * the unified flame includes both processes.
 *
 * Also exposes `flush()` so the renderer can manually trigger the final
 * print (useful after FCP). The default 1500ms timer in `setup-gate.ts`
 * still fires as a fallback.
 */
import { Service, runtime } from "../runtime";
import { bootTrace, type TraceEvent } from "../boot-trace";

interface WireSpan {
  kind: "span";
  name: string;
  startedAt: number; // ms since the renderer's `performance.timeOrigin`
  endedAt: number;
  durationMs: number;
  parent: string | null;
  meta?: Record<string, unknown>;
}

interface WireMark {
  kind: "mark";
  name: string;
  at: number; // ms since the renderer's `performance.timeOrigin`
  meta?: Record<string, unknown>;
}

type WireEvent = WireSpan | WireMark;

/**
 * Convert a renderer-side timestamp (ms since its `timeOrigin`) to a
 * main-process boot-trace timestamp (ms since process start).
 *
 * `timeOrigin` is the renderer's epoch-anchored process-creation time;
 * the main process's analogue is `processStartedAtEpoch`. The delta is
 * the offset we add to renderer measurements to land them on the unified
 * timeline.
 */
function rebaseToMain(rendererMs: number, timeOrigin: number, processStartedAtEpoch: number): number {
  return rendererMs + (timeOrigin - processStartedAtEpoch);
}

export class BootTraceService extends Service.create({ key: "bootTrace" }) {
  /**
   * Renderer ingest endpoint. Called via RPC from `ZenbuProvider`.
   *
   * @param args.events  Buffered events from `window.__zenbuBootTrace.drain()`.
   * @param args.timeOrigin  Renderer's `performance.timeOrigin` (epoch ms).
   */
  report(args: { events: WireEvent[]; timeOrigin: number }): void {
    if (!bootTrace.isEnabled()) return;
    // Pull the main-process epoch anchor from the trace singleton so
    // both sides converge on `ms since main process start`.
    const slot = globalThis as unknown as {
      __zenbu_boot_trace__?: { processStartedAtEpoch: number };
    };
    const mainEpoch = slot.__zenbu_boot_trace__?.processStartedAtEpoch ?? Date.now();

    const rebased: TraceEvent[] = args.events.map((ev) => {
      if (ev.kind === "mark") {
        return {
          kind: "mark",
          name: ev.name,
          at: rebaseToMain(ev.at, args.timeOrigin, mainEpoch),
          source: "renderer",
          ...(ev.meta ? { meta: ev.meta } : {}),
        };
      }
      const startedAt = rebaseToMain(ev.startedAt, args.timeOrigin, mainEpoch);
      const endedAt = rebaseToMain(ev.endedAt, args.timeOrigin, mainEpoch);
      return {
        kind: "span",
        name: ev.name,
        startedAt,
        endedAt,
        durationMs: ev.durationMs,
        parent: ev.parent,
        source: "renderer",
        ...(ev.meta ? { meta: ev.meta } : {}),
      };
    });

    bootTrace.addEvents(rebased, "renderer");
  }

  /** Trigger an out-of-band flame print + JSON write. */
  flush(args: { reason?: string } = {}): void {
    bootTrace.flush({ reason: args.reason ?? "renderer-requested" });
  }
}

runtime.register(BootTraceService, import.meta);

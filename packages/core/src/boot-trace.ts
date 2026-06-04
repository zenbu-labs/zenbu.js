/**
 * Boot-trace — opt-in startup tracer (`ZENBU_BOOT_TRACE=1`). Records spans and
 * marks across the main process; `flush()` prints an ASCII flame graph and
 * writes JSON to `<project>/traces/boot/`. Anchored to process start via
 * `process.uptime()` so the pre-JS Electron spin-up gap is visible.
 *
 * Stored on `globalThis.__zenbu_boot_trace__` so HMR and the tsx loader worker
 * (separate module graph) share one buffer.
 */
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

export type TraceSource = "main" | "renderer" | "user";

export interface TraceSpan {
  kind: "span";
  name: string;
  /** ms since process start */
  startedAt: number;
  /** ms since process start */
  endedAt: number;
  durationMs: number;
  parent: string | null;
  source: TraceSource;
  error?: string;
  meta?: Record<string, unknown>;
}

export interface TraceMark {
  kind: "mark";
  name: string;
  /** ms since process start */
  at: number;
  source: TraceSource;
  meta?: Record<string, unknown>;
}

export type TraceEvent = TraceSpan | TraceMark;

interface OpenSpan {
  /** Stable handle returned by pushSpan; popSpan(handle) matches against it. */
  id: number;
  name: string;
  startedAt: number;
  parent: string | null;
  source: TraceSource;
  meta?: Record<string, unknown>;
}

interface BootTraceState {
  /** wall-clock at process start (ms epoch), used for the JSON timestamps. */
  processStartedAtEpoch: number;
  /** `performance.now()` value at process start. Subtract from later
   * `performance.now()` values to get ms-since-process-start. */
  perfOriginMs: number;
  events: TraceEvent[];
  /**
   * In-flight spans, keyed by handle id. Async / concurrent spans
   * cannot share a LIFO stack — popping the top would frequently match
   * the wrong logical span. Every `pushSpan` returns a numeric handle
   * and `popSpan(handle)` removes that specific entry.
   */
  openSpansById: Map<number, OpenSpan>;
  /** Stack used solely to compute `parent` at push-time. Best-effort. */
  parentStack: OpenSpan[];
  nextHandleId: number;
  /** Where to write the JSON file. Set late by the framework once it
   * knows the project root. */
  projectRoot: string | null;
  flushed: boolean;
  enabled: boolean;
}

const SLOT_KEY = "__zenbu_boot_trace__" as const;

function init(): BootTraceState {
  const slot = globalThis as unknown as { [SLOT_KEY]?: BootTraceState };
  if (slot[SLOT_KEY]) return slot[SLOT_KEY];

  // `process.uptime()` returns seconds since process start. Subtracting
  // from `Date.now()` gives us the absolute epoch of process start. We
  // anchor `performance.now()` (which starts at 0 at module load, not at
  // process start) to that same origin.
  const nowEpoch = Date.now();
  const uptimeMs = Math.round(process.uptime() * 1000);
  const processStartedAtEpoch = nowEpoch - uptimeMs;
  // Align perf clock so `perfNow() - perfOriginMs === ms since process start`.
  const perfOriginMs = performance.now() - uptimeMs;

  const state: BootTraceState = {
    processStartedAtEpoch,
    perfOriginMs,
    events: [],
    openSpansById: new Map(),
    parentStack: [],
    nextHandleId: 1,
    projectRoot: null,
    flushed: false,
    enabled: process.env.ZENBU_BOOT_TRACE === "1",
  };
  slot[SLOT_KEY] = state;

  // Always seed a "process-start" mark at t=0 so the timeline anchors visibly.
  if (state.enabled) {
    state.events.push({
      kind: "mark",
      name: "process-start",
      at: 0,
      source: "main",
    });
  }

  return state;
}

const state = init();

// Event-loop lag sampler & CPU usage tracking — distinguishes "slow because of
// other work" from "slow intrinsically".

interface LagBlock {
  /** When the block started (ms since process start). */
  startedAt: number;
  /** How long the JS thread was blocked (ms). */
  durationMs: number;
}
interface LagState {
  /** Cumulative wall-clock blocked above 50ms threshold (ms). */
  blockedMs: number;
  /** Single longest contiguous block observed (ms). */
  maxBlockMs: number;
  /** Total samples taken. */
  samples: number;
  /** Tick of last sample (perf-clock). */
  lastTick: number;
  /** Top long-block instances, sorted by duration desc. */
  topBlocks: LagBlock[];
  /** Stop function. */
  stop?: () => void;
}
const lagState: LagState = {
  blockedMs: 0,
  maxBlockMs: 0,
  samples: 0,
  lastTick: 0,
  topBlocks: [],
};

/** Poll the event loop every 5ms; lag beyond ~50ms over the expected interval
 * means the JS thread was blocked. `blockedMs` proxies boot saturation. */
function startLagSampler(): void {
  if (lagState.stop) return;
  const intervalMs = 5;
  lagState.lastTick = performance.now();
  const id = setInterval(() => {
    const now = performance.now();
    const delta = now - lagState.lastTick;
    lagState.lastTick = now;
    lagState.samples++;
    const lag = Math.max(0, delta - intervalMs);
    // 50ms is a generous threshold; below that timers fire roughly on
    // schedule. Above it the event loop was actively blocked.
    if (lag > 50) {
      lagState.blockedMs += lag;
      if (lag > lagState.maxBlockMs) lagState.maxBlockMs = lag;
      // Keep top 10 blocks for the flame summary so we can attribute
      // the longest synchronous tasks to a wall-clock window.
      const blockStart = now - lag - intervalMs - state.perfOriginMs;
      lagState.topBlocks.push({
        startedAt: blockStart,
        durationMs: lag,
      });
      lagState.topBlocks.sort((a, b) => b.durationMs - a.durationMs);
      if (lagState.topBlocks.length > 10) lagState.topBlocks.length = 10;
    }
  }, intervalMs);
  // Don't keep the process alive just for the sampler.
  id.unref?.();
  lagState.stop = () => clearInterval(id);
}

if (state.enabled) startLagSampler();

function captureCpuSnapshot(): { userMs: number; systemMs: number; totalMs: number } | null {
  if (typeof process === "undefined" || typeof process.cpuUsage !== "function") {
    return null;
  }
  const u = process.cpuUsage();
  return {
    userMs: u.user / 1000,
    systemMs: u.system / 1000,
    totalMs: (u.user + u.system) / 1000,
  };
}

function now(): number {
  return performance.now() - state.perfOriginMs;
}

export function isEnabled(): boolean {
  return state.enabled;
}

export function setProjectRoot(projectRoot: string): void {
  state.projectRoot = projectRoot;
}

export function getProjectRoot(): string | null {
  return state.projectRoot;
}

export function mark(name: string, meta?: Record<string, unknown>): void {
  if (!state.enabled) return;
  const ev: TraceMark = {
    kind: "mark",
    name,
    at: now(),
    source: "main",
    ...(meta ? { meta } : {}),
  };
  state.events.push(ev);
}

/**
 * Begin a manually-managed span. Pair with `popSpan(handle)`. Returns a
 * numeric handle that identifies *this exact* span — popping by handle
 * avoids the LIFO-mismatch problem you get when many async spans run
 * concurrently and pops arrive out of push-order.
 */
export function pushSpan(
  name: string,
  meta?: Record<string, unknown>,
): number {
  if (!state.enabled) return 0;
  const id = state.nextHandleId++;
  const open: OpenSpan = {
    id,
    name,
    startedAt: now(),
    parent:
      state.parentStack[state.parentStack.length - 1]?.name ?? null,
    source: "main",
    ...(meta ? { meta } : {}),
  };
  state.openSpansById.set(id, open);
  state.parentStack.push(open);
  return id;
}

export function popSpan(handle: number, error?: unknown): void {
  if (!state.enabled || handle === 0) return;
  const open = state.openSpansById.get(handle);
  if (!open) return;
  state.openSpansById.delete(handle);
  // Remove from the parent stack too — it may not be on top because the
  // pop arrived out of LIFO order (async concurrent spans). Walking the
  // stack is fine; depths stay small (typically <10).
  const idx = state.parentStack.lastIndexOf(open);
  if (idx >= 0) state.parentStack.splice(idx, 1);
  const endedAt = now();
  const span: TraceSpan = {
    kind: "span",
    name: open.name,
    startedAt: open.startedAt,
    endedAt,
    durationMs: endedAt - open.startedAt,
    parent: open.parent,
    source: open.source,
    ...(open.meta ? { meta: open.meta } : {}),
    ...(error
      ? { error: error instanceof Error ? error.message : String(error) }
      : {}),
  };
  state.events.push(span);
}

export async function span<T>(
  name: string,
  fn: () => T | Promise<T>,
  meta?: Record<string, unknown>,
): Promise<T> {
  if (!state.enabled) return await fn();
  const handle = pushSpan(name, meta);
  try {
    const out = await fn();
    popSpan(handle);
    return out;
  } catch (e) {
    popSpan(handle, e);
    throw e;
  }
}

export function spanSync<T>(
  name: string,
  fn: () => T,
  meta?: Record<string, unknown>,
): T {
  if (!state.enabled) return fn();
  const handle = pushSpan(name, meta);
  try {
    const out = fn();
    popSpan(handle);
    return out;
  } catch (e) {
    popSpan(handle, e);
    throw e;
  }
}

/** Bulk-ingest events from another source (e.g. renderer). */
export function addEvents(
  events: ReadonlyArray<TraceEvent>,
  source: TraceSource,
): void {
  if (!state.enabled) return;
  for (const ev of events) {
    // Stamp the source if missing (renderer omits it on the wire).
    const stamped: TraceEvent =
      ev.source === source
        ? ev
        : ({ ...ev, source } as TraceEvent);
    state.events.push(stamped);
  }
}

export function getEvents(): readonly TraceEvent[] {
  return state.events;
}

export function getTotalMs(): number {
  let maxEnd = 0;
  for (const ev of state.events) {
    const t = ev.kind === "span" ? ev.endedAt : ev.at;
    if (t > maxEnd) maxEnd = t;
  }
  return maxEnd;
}

interface FlushOptions {
  /** Free-form reason string included in the printed header. */
  reason?: string;
  /** Whether to log the ASCII flame. Default true. */
  log?: boolean;
  /** Whether to write the JSON snapshot. Default true. */
  write?: boolean;
}

export function flush(options: FlushOptions = {}): void {
  if (!state.enabled) return;
  const { reason = "ready", log = true, write = true } = options;
  state.flushed = true;

  if (log) {
    try {
      const flame = renderFlame(reason);
      // One big block, write to stdout via process.stdout to keep ordering.
      process.stdout.write(flame + "\n");
    } catch (err) {
      console.error("[boot-trace] flame render failed:", err);
    }
  }

  if (write) {
    try {
      writeJson();
    } catch (err) {
      console.error("[boot-trace] json write failed:", err);
    }
  }
}

function writeJson(): void {
  if (!state.projectRoot) return;
  const dir = path.join(state.projectRoot, "traces", "boot");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  const tsLabel = new Date(state.processStartedAtEpoch)
    .toISOString()
    .replace(/[:.]/g, "-");
  const payload = {
    processStartedAtEpoch: state.processStartedAtEpoch,
    totalMs: getTotalMs(),
    events: state.events,
  };
  const json = JSON.stringify(payload, null, 2);
  const filePath = path.join(dir, `boot-${tsLabel}.json`);
  fs.writeFileSync(filePath, json);
  fs.writeFileSync(path.join(dir, "latest.json"), json);
}

// ---------------------------------------------------------------------------
// ASCII flame rendering
// ---------------------------------------------------------------------------

interface Row {
  label: string;
  indent: number;
  startedAt: number;
  durationMs: number;
  error?: string;
}

function renderFlame(reason: string, barWidth = 60): string {
  const total = getTotalMs();
  const scale = total > 0 ? barWidth / total : 0;

  const spans: TraceSpan[] = [];
  const marks: TraceMark[] = [];
  for (const ev of state.events) {
    if (ev.kind === "span") spans.push(ev);
    else marks.push(ev);
  }
  spans.sort((a, b) => a.startedAt - b.startedAt);
  marks.sort((a, b) => a.at - b.at);

  const lines: string[] = [];
  lines.push("");
  lines.push(
    `╭─ [boot-trace] ${reason} — total ${fmtMs(total)} (${spans.length} spans, ${marks.length} marks)`,
  );

  // Marks section first — point-in-time milestones across the whole timeline.
  if (marks.length > 0) {
    const maxMarkLen = marks.reduce(
      (m, k) => Math.max(m, k.name.length + 6),
      10,
    );
    for (const mk of marks) {
      const offset = mk.at;
      const pos = Math.min(barWidth - 1, Math.max(0, Math.round(offset * scale)));
      const bar =
        " ".repeat(pos) +
        "▲" +
        " ".repeat(Math.max(0, barWidth - pos - 1));
      const label = `mark: ${mk.name}`.padEnd(maxMarkLen);
      lines.push(`│ ${label}  │${bar}│ t+${fmtMs(offset)}`);
    }
    lines.push("│");
  }

  // Build span rows. Each span is rendered as a single row, sorted by
  // start time, indented by its containment depth in the timeline (a span
  // whose [start, end] is fully inside another's is its child). This
  // doesn't require accurate `parent` linkage from the recorder — useful
  // because async spans frequently lose their parent context across
  // promise boundaries.
  type SpanNode = TraceSpan & { children: SpanNode[]; depth: number };
  const nodes: SpanNode[] = spans.map((s) => ({ ...s, children: [], depth: 0 }));
  // Sort: earlier start first, then longer duration first (so parents come
  // before children).
  nodes.sort(
    (a, b) => a.startedAt - b.startedAt || b.durationMs - a.durationMs,
  );
  const stack: SpanNode[] = [];
  for (const node of nodes) {
    // Pop anything that ended before this span started.
    while (stack.length && stack[stack.length - 1]!.endedAt <= node.startedAt) {
      stack.pop();
    }
    node.depth = stack.length;
    stack.push(node);
  }

  const rows: Row[] = nodes.map((n) => ({
    label: n.name,
    indent: n.depth * 2,
    startedAt: n.startedAt,
    durationMs: n.durationMs,
    error: n.error,
  }));

  const maxLabelLen = rows.reduce(
    (m, r) => Math.max(m, r.indent + r.label.length),
    10,
  );

  for (const row of rows) {
    const startCell = Math.max(0, Math.round(row.startedAt * scale));
    const widthCell = Math.max(1, Math.round(row.durationMs * scale));
    const clampedStart = Math.min(startCell, barWidth - 1);
    const clampedWidth = Math.min(widthCell, barWidth - clampedStart);
    const rightPad = Math.max(0, barWidth - clampedStart - clampedWidth);
    const bar =
      " ".repeat(clampedStart) +
      "█".repeat(clampedWidth) +
      " ".repeat(rightPad);
    const label =
      " ".repeat(row.indent) + row.label.padEnd(maxLabelLen - row.indent);
    const timing = `${fmtMs(row.durationMs).padStart(6)}  t+${fmtMs(row.startedAt).padStart(6)}`;
    const suffix = row.error ? `  ✗ ${row.error}` : "";
    lines.push(`│ ${label}  │${bar}│ ${timing}${suffix}`);
  }

  // Slowest leaders table.
  const allDurations: { label: string; durationMs: number }[] = [];
  for (const s of spans) {
    allDurations.push({ label: s.name, durationMs: s.durationMs });
  }
  allDurations.sort((a, b) => b.durationMs - a.durationMs);
  const top = allDurations.slice(0, 8);
  if (top.length > 0) {
    lines.push("│");
    lines.push(`│ slowest: ${top
      .map((s) => `${s.label} (${fmtMs(s.durationMs)})`)
      .join(", ")}`);
  }

  // Advice Babel plugin stats. Each Vite root gets a row showing how
  // many files went through `transformSync` and how much wall-clock
  // they consumed cumulatively. If this row is large relative to
  // total boot, the advice transform is a top candidate for migration
  // to SWC / esbuild.
  const adviceStats = (globalThis as any).__zenbu_advice_stats__ as
    | Map<string, { files: number; totalMs: number; maxMs: number }>
    | undefined;
  if (adviceStats && adviceStats.size > 0) {
    lines.push("│");
    lines.push("│ advice babel transform:");
    for (const [root, s] of adviceStats) {
      const shortRoot = root.replace(/^.*\/packages\//, "packages/");
      lines.push(
        `│   ${shortRoot.padEnd(40)} ${String(s.files).padStart(4)} files  total ${fmtMs(s.totalMs).padStart(7)}  max ${fmtMs(s.maxMs).padStart(7)}`,
      );
    }
  }

  // CPU utilization & event-loop lag. If `userMs` divided by `totalMs`
  // wall-clock is close to 1.0, the JS thread is CPU-saturated — we'd
  // win by moving work off-thread (workers, SWC, esbuild). If well
  // below 1.0, the bottleneck is I/O or async waits and parallelism
  // won't help much. `blockedMs` shows total wall-clock spent in long
  // synchronous tasks (> 50ms each) which never yielded to other work.
  const cpu = captureCpuSnapshot();
  if (cpu) {
    const wallMs = total;
    const cpuUtilization = wallMs > 0 ? cpu.totalMs / wallMs : 0;
    const userPct = wallMs > 0 ? (cpu.userMs / wallMs) * 100 : 0;
    const sysPct = wallMs > 0 ? (cpu.systemMs / wallMs) * 100 : 0;
    lines.push("│");
    lines.push(
      `│ main-thread CPU: ${fmtMs(cpu.totalMs)} / ${fmtMs(wallMs)} wall  (${cpuUtilization.toFixed(2)}x core, user=${userPct.toFixed(0)}% sys=${sysPct.toFixed(0)}%)`,
    );
    lines.push(
      `│ event-loop lag: ${fmtMs(lagState.blockedMs)} blocked >50ms across ${lagState.samples} ticks, longest block ${fmtMs(lagState.maxBlockMs)}`,
    );
    if (lagState.topBlocks.length > 0) {
      lines.push("│ top blocks (sync work that never yielded):");
      // Sort the top-N by start time for readability against the timeline above.
      const inOrder = [...lagState.topBlocks].sort(
        (a, b) => a.startedAt - b.startedAt,
      );
      for (const b of inOrder.slice(0, 8)) {
        lines.push(
          `│   t+${fmtMs(b.startedAt).padStart(7)} blocked ${fmtMs(b.durationMs).padStart(7)}`,
        );
      }
    }
  }

  // Per-Vite-server request stats: how many HTTP requests Vite served
  // during boot and where the wall-clock went. A high request count
  // with low avg means "chatty module waterfall"; a few big requests
  // means a fat transform somewhere.
  const viteStats = (globalThis as any).__zenbu_vite_stats__ as
    | Map<string, {
        requests: {
          count: number;
          totalMs: number;
          maxMs: number;
          maxId: string;
          top: Array<{ url: string; ms: number }>;
        };
      }>
    | undefined;
  if (viteStats && viteStats.size > 0) {
    lines.push("│");
    lines.push("│ vite dev-server requests:");
    for (const [id, s] of viteStats) {
      const r = s.requests;
      const avg = r.count ? r.totalMs / r.count : 0;
      lines.push(
        `│   ${id.padEnd(16)} ${String(r.count).padStart(4)} reqs  total ${fmtMs(r.totalMs).padStart(7)}  avg ${fmtMs(avg).padStart(6)}  max ${fmtMs(r.maxMs).padStart(6)}`,
      );
      for (const entry of r.top.slice(0, 8)) {
        const path = entry.url.length > 180 ? entry.url.slice(0, 180) + "…" : entry.url;
        lines.push(`│     ${fmtMs(entry.ms).padStart(7)}  ${path}`);
      }
    }
  }

  lines.push(`╰─ window: started ${new Date(state.processStartedAtEpoch).toISOString()}`);
  return lines.join("\n");
}

function fmtMs(ms: number): string {
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms)}ms`;
}

// Convenience aggregate export — call sites tend to grab the whole module.
export const bootTrace = {
  mark,
  span,
  spanSync,
  pushSpan,
  popSpan,
  addEvents,
  getEvents,
  getTotalMs,
  flush,
  setProjectRoot,
  isEnabled,
};

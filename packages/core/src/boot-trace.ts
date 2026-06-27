
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

export type TraceSource = "main" | "renderer" | "user";

export interface TraceSpan {
  kind: "span";
  name: string;
  
  startedAt: number;
  
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
  
  at: number;
  source: TraceSource;
  meta?: Record<string, unknown>;
}

export type TraceEvent = TraceSpan | TraceMark;

interface OpenSpan {
  
  id: number;
  name: string;
  startedAt: number;
  parent: string | null;
  source: TraceSource;
  meta?: Record<string, unknown>;
}

interface BootTraceState {
  
  processStartedAtEpoch: number;
  
  perfOriginMs: number;
  events: TraceEvent[];
  
  openSpansById: Map<number, OpenSpan>;
  
  parentStack: OpenSpan[];
  nextHandleId: number;
  
  projectRoot: string | null;
  flushed: boolean;
  enabled: boolean;
}

const SLOT_KEY = "__zenbu_boot_trace__" as const;

function init(): BootTraceState {
  const slot = globalThis as unknown as { [SLOT_KEY]?: BootTraceState };
  if (slot[SLOT_KEY]) return slot[SLOT_KEY];

  
  const nowEpoch = Date.now();
  const uptimeMs = Math.round(process.uptime() * 1000);
  const processStartedAtEpoch = nowEpoch - uptimeMs;
  
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



interface LagBlock {
  
  startedAt: number;
  
  durationMs: number;
}
interface LagState {
  
  blockedMs: number;
  
  maxBlockMs: number;
  
  samples: number;
  
  lastTick: number;
  
  topBlocks: LagBlock[];
  
  stop?: () => void;
}
const lagState: LagState = {
  blockedMs: 0,
  maxBlockMs: 0,
  samples: 0,
  lastTick: 0,
  topBlocks: [],
};


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
    
    if (lag > 50) {
      lagState.blockedMs += lag;
      if (lag > lagState.maxBlockMs) lagState.maxBlockMs = lag;
      
      const blockStart = now - lag - intervalMs - state.perfOriginMs;
      lagState.topBlocks.push({
        startedAt: blockStart,
        durationMs: lag,
      });
      lagState.topBlocks.sort((a, b) => b.durationMs - a.durationMs);
      if (lagState.topBlocks.length > 10) lagState.topBlocks.length = 10;
    }
  }, intervalMs);
  
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


export function addEvents(
  events: ReadonlyArray<TraceEvent>,
  source: TraceSource,
): void {
  if (!state.enabled) return;
  for (const ev of events) {
    
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
  
  reason?: string;
  
  log?: boolean;
  
  write?: boolean;
}

export function flush(options: FlushOptions = {}): void {
  if (!state.enabled) return;
  const { reason = "ready", log = true, write = true } = options;
  state.flushed = true;

  if (log) {
    try {
      const flame = renderFlame(reason);
      
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

  
  type SpanNode = TraceSpan & { children: SpanNode[]; depth: number };
  const nodes: SpanNode[] = spans.map((s) => ({ ...s, children: [], depth: 0 }));
  
  nodes.sort(
    (a, b) => a.startedAt - b.startedAt || b.durationMs - a.durationMs,
  );
  const stack: SpanNode[] = [];
  for (const node of nodes) {
    
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

import { describe, it, expect } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { once } from "node:events";
import { AddressInfo } from "node:net";
import {
  ServiceRuntime,
  Service,
  state,
  type ServiceState,
} from "../src/runtime";
import {
  ClientStateStore,
  STATE_WIRE_CHANNEL,
  type StateSnapshotMessage,
  type StateUpdateMessage,
} from "../src/state";

/**
 * End-to-end round trip across a real WebSocket:
 *
 *   ServiceRuntime  →  subscribeStateChanges (sender mirrors StateService.evaluate)
 *      ↓ JSON.stringify({ch:"state", data:{t:"snapshot"|"update", ...}})
 *   ws.Server → ws.Client
 *      ↓ JSON.parse + filter ch==="state" (mirrors ZenbuProvider)
 *   ClientStateStore.apply()
 *
 * Proves the wire envelope is symmetric and that snapshot+update
 * messages survive a real socket. The in-memory test in `state.test.ts`
 * skips JSON.stringify and the TCP/WS layer — this one exercises both.
 */
describe("state wire — real WebSocket round trip", () => {
  it("snapshot on connect + per-cell updates reach a real client", async () => {
    const wss = new WebSocketServer({ port: 0 });
    await once(wss, "listening");
    const port = (wss.address() as AddressInfo).port;

    const rt = new ServiceRuntime();

    class Demo extends Service.create({ key: "demo" }) {
      status = state<"idle" | "running">("idle");
      port = state<number | null>(null);
    }
    rt.register(Demo as any);
    await rt.whenIdle();

    const sockets = new Set<WebSocket>();
    const sendTo = (
      ws: WebSocket,
      payload: StateSnapshotMessage | StateUpdateMessage,
    ) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify({ ch: STATE_WIRE_CHANNEL, data: payload }));
    };

    wss.on("connection", (ws) => {
      sockets.add(ws);
      sendTo(ws, { t: "snapshot", values: rt.getStateEntries() });
      ws.on("close", () => sockets.delete(ws));
    });

    const unsubBroadcast = rt.subscribeStateChanges((msg) => {
      for (const ws of sockets) sendTo(ws, msg);
    });

    // ---- Client side ----
    const client = new ClientStateStore();
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    // Register the message handler BEFORE the socket opens — the
    // server sends the initial snapshot inside its `connection`
    // listener, which can fire before the client's `open` event
    // resolves and the message would be lost.
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg?.ch !== STATE_WIRE_CHANNEL) return;
        client.apply(msg.data);
      } catch {
        // ignore
      }
    });
    await once(ws, "open");

    // Wait for initial snapshot to land.
    await waitFor(() => client.getValueAt("core.demo.status") === "idle");
    expect(client.getEntries()).toEqual({
      "core.demo.status": "idle",
      "core.demo.port": null,
    });

    // Mutate server-side and wait for the update.
    const inst = rt.getSlot("demo")!.instance as unknown as {
      status: ServiceState<string>;
      port: ServiceState<number | null>;
    };
    inst.status.set("running");
    inst.port.set(4242);

    await waitFor(
      () =>
        client.getValueAt("core.demo.status") === "running" &&
        client.getValueAt("core.demo.port") === 4242,
    );
    expect(client.getTree()).toEqual({
      core: { demo: { status: "running", port: 4242 } },
    });

    // Path subscriber fires for the specific field that changed.
    const cb = vitestSpy<() => void>();
    client.subscribePath("core.demo.status", cb);
    inst.status.set("idle");
    await waitFor(() => client.getValueAt("core.demo.status") === "idle");
    expect(cb.calls).toBe(1);

    // Teardown propagates: shutdown the runtime, client sees undefined
    // updates (which the store treats as removals).
    await rt.shutdown();
    await waitFor(
      () =>
        client.getValueAt("core.demo.status") === undefined &&
        client.getValueAt("core.demo.port") === undefined,
    );
    expect(client.getEntries()).toEqual({});

    unsubBroadcast();
    ws.close();
    await new Promise<void>((resolve) =>
      wss.close(() => {
        resolve();
      }),
    );
  });
});

// --- tiny test helpers (avoid leaning on vi.fn here so the file is
// self-contained and easy to read) ---

function vitestSpy<F extends (...args: any[]) => any>() {
  let calls = 0;
  const fn = ((...args: any[]) => {
    calls++;
    return undefined as any;
  }) as F & { calls: number };
  Object.defineProperty(fn, "calls", {
    get: () => calls,
  });
  return fn as { (...args: Parameters<F>): ReturnType<F>; calls: number };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: predicate not satisfied within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

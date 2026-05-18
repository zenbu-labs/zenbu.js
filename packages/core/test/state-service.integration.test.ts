import { describe, it, expect } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  ServiceRuntime,
  Service,
  state,
  type ServiceState,
} from "../src/runtime";
import {
  ClientStateStore,
  STATE_WIRE_CHANNEL,
} from "../src/state";
import os from "node:os";
import { registerAppEntrypoint } from "../src/runtime";
import type {
  wireStateBroadcast as WireStateBroadcastFn,
  StateWireHttpHost,
} from "../src/services/state";

// `services/state.ts` imports `HttpService` → `RendererHostService`,
// whose top-level `runtime.register(...)` evaluates against the global
// runtime singleton. ESM imports are hoisted, so we cannot satisfy
// `uiEntrypoint` BEFORE a static `import { wireStateBroadcast } from
// "../src/services/state"`. Defer the import to inside the test via
// `await import(...)` after `registerAppEntrypoint` runs. Global
// runtime state is irrelevant — the test uses a fresh `ServiceRuntime`.
registerAppEntrypoint(os.tmpdir());

/**
 * Drives the literal pump function `StateService.evaluate` invokes
 * (`wireStateBroadcast`) against a fresh `ServiceRuntime`, a real
 * `ws.Server` + `ws.Client`, and a tiny `StateWireHttpHost` that
 * mimics the surface `HttpService` exposes. Isolated from the global
 * singleton so the renderer-host / vite / electron cascade never runs.
 *
 * Catches regressions in:
 *   - snapshot computed at send time (mutations between subscribe and
 *     a client's connection are reflected)
 *   - per-client tracking + broadcast fan-out (two clients, both see
 *     the same updates)
 *   - pull-in of pre-existing `http.activeConnections` on evaluate
 *     (the hot-reload-of-state.ts path)
 *   - cleanup unsubscribes everything
 */
describe("StateService wire — real WebSocket integration", () => {
  it("snapshots, broadcasts, and pulls in pre-existing connections", async () => {
    // Deferred import so registerAppEntrypoint above runs first.
    const { wireStateBroadcast } = (await import("../src/services/state")) as {
      wireStateBroadcast: typeof WireStateBroadcastFn;
    };
    const wss = new WebSocketServer({ port: 0 });
    await once(wss, "listening");
    const port = (wss.address() as AddressInfo).port;

    const rt = new ServiceRuntime();

    class Demo extends Service.create({ key: "state-integ-demo" }) {
      status = state<"idle" | "running">("idle");
      port = state<number | null>(null);
    }
    rt.register(Demo as any);
    await rt.whenIdle();

    // ---- Stub HttpService surface ----
    let nextId = 0;
    const connectedCbs: Array<(id: string, ws: WebSocket) => void> = [];
    const disconnectedCbs: Array<(id: string) => void> = [];
    const activeConnections = new Map<string, WebSocket>();
    const http: StateWireHttpHost = {
      onConnected(cb) {
        connectedCbs.push(cb);
        return () => {
          const i = connectedCbs.indexOf(cb);
          if (i >= 0) connectedCbs.splice(i, 1);
        };
      },
      onDisconnected(cb) {
        disconnectedCbs.push(cb);
        return () => {
          const i = disconnectedCbs.indexOf(cb);
          if (i >= 0) disconnectedCbs.splice(i, 1);
        };
      },
      activeConnections,
    };
    wss.on("connection", (ws) => {
      const id = `c${nextId++}`;
      activeConnections.set(id, ws);
      for (const cb of [...connectedCbs]) cb(id, ws);
      ws.on("close", () => {
        activeConnections.delete(id);
        for (const cb of [...disconnectedCbs]) cb(id);
      });
    });

    // ---- Bring up a pre-existing client BEFORE wireStateBroadcast.
    // This is the hot-reload-of-state.ts path: state-wiring is set
    // up while a renderer is already connected.
    const earlyClient = new ClientStateStore();
    const earlyWs = await openClient(port, earlyClient);

    // The pre-existing socket landed in `activeConnections` but no
    // snapshot fired yet (no subscriber). After we wire, it should
    // receive one.
    const cleanup = wireStateBroadcast({ http, runtime: rt });
    await waitFor(
      () => earlyClient.getValueAt("core.state-integ-demo.status") === "idle",
    );
    expect(earlyClient.getEntries()).toMatchObject({
      "core.state-integ-demo.status": "idle",
      "core.state-integ-demo.port": null,
    });

    // Mutate. The early client should observe.
    const demo = rt.getSlot("state-integ-demo")!.instance as unknown as {
      status: ServiceState<string>;
      port: ServiceState<number | null>;
    };
    demo.status.set("running");
    demo.port.set(4242);
    await waitFor(
      () =>
        earlyClient.getValueAt("core.state-integ-demo.status") === "running" &&
        earlyClient.getValueAt("core.state-integ-demo.port") === 4242,
    );

    // A second client connecting after the mutations should see the
    // fresh values in its snapshot — proving snapshot is computed at
    // send time, not cached at wire time.
    const lateClient = new ClientStateStore();
    const lateWs = await openClient(port, lateClient);
    await waitFor(
      () =>
        lateClient.getValueAt("core.state-integ-demo.status") === "running",
    );
    expect(lateClient.getValueAt("core.state-integ-demo.port")).toBe(4242);

    // Further mutation reaches both.
    demo.status.set("idle");
    await waitFor(
      () =>
        earlyClient.getValueAt("core.state-integ-demo.status") === "idle" &&
        lateClient.getValueAt("core.state-integ-demo.status") === "idle",
    );

    // Cleanup unsubscribes — further mutations do NOT reach clients.
    cleanup();
    demo.status.set("running");
    // give the network a tick; nothing should have changed
    await new Promise((r) => setTimeout(r, 50));
    expect(earlyClient.getValueAt("core.state-integ-demo.status")).toBe("idle");
    expect(lateClient.getValueAt("core.state-integ-demo.status")).toBe("idle");

    earlyWs.close();
    lateWs.close();
    await new Promise<void>((resolve) =>
      wss.close(() => resolve()),
    );
  });
});

// --- helpers ---

async function openClient(port: number, store: ClientStateStore): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  // Register message handler BEFORE open so the snapshot the server
  // sends synchronously inside its `connection` listener doesn't get
  // dropped on the floor.
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg?.ch !== STATE_WIRE_CHANNEL) return;
      store.apply(msg.data);
    } catch {
      /* ignore */
    }
  });
  await once(ws, "open");
  return ws;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: predicate not satisfied within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

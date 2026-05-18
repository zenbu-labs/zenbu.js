import type { WebSocket } from "ws";
import { Service, runtime } from "../runtime";
import {
  STATE_WIRE_CHANNEL,
  type StateUpdateMessage,
  type StateSnapshotMessage,
} from "../state";
import { HttpService } from "./http";
import { createLogger } from "../shared/log";

const log = createLogger("state");

/**
 * Minimum surface `wireStateBroadcast` consumes from `HttpService`.
 * Broken out so tests can plug in a stub without importing the full
 * HTTP/Server/Reloader/Vite cascade.
 */
export interface StateWireHttpHost {
  onConnected(cb: (id: string, ws: WebSocket) => void): () => void;
  onDisconnected(cb: (id: string) => void): () => void;
  activeConnections: Map<string, WebSocket>;
}

/**
 * Minimum surface `wireStateBroadcast` consumes from the runtime.
 * Mirrors the methods `ServiceRuntime` exposes for the registry; a
 * test can pass a fresh `ServiceRuntime` instance here directly.
 */
export interface StateWireRuntimeHost {
  getStateEntries(): Record<string, unknown>;
  subscribeStateChanges(cb: (msg: StateUpdateMessage) => void): () => void;
}

/**
 * Pure wiring: subscribe to `http`'s connection lifecycle and
 * `runtime`'s state changes, fan everything out as `STATE_WIRE_CHANNEL`
 * messages on the underlying WebSockets. Returns a cleanup that
 * unsubscribes everything and drops references to live sockets.
 *
 * Idempotent w.r.t. existing connections — invoked with `http.activeConnections`
 * already populated (hot-reload of `state.ts` while the renderer is up).
 *
 * Extracted from `StateService.evaluate` so the full wire path is
 * unit-testable without booting Electron / Vite / the renderer host.
 */
export function wireStateBroadcast(deps: {
  http: StateWireHttpHost;
  runtime: StateWireRuntimeHost;
}): () => void {
  const { http, runtime: rt } = deps;
  const clients = new Map<string, WebSocket>();

  const sendTo = (
    ws: WebSocket,
    payload: StateSnapshotMessage | StateUpdateMessage,
  ) => {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify({ ch: STATE_WIRE_CHANNEL, data: payload }));
    } catch (err) {
      log.verbose("ws send failed:", err);
    }
  };

  const onConnected = (id: string, ws: WebSocket) => {
    clients.set(id, ws);
    const snapshot: StateSnapshotMessage = {
      t: "snapshot",
      // Read at send time so the snapshot reflects whatever changes
      // landed between subscribe and the actual call.
      values: rt.getStateEntries(),
    };
    sendTo(ws, snapshot);
  };

  const onDisconnected = (id: string) => {
    clients.delete(id);
  };

  const unsubConnected = http.onConnected(onConnected);
  const unsubDisconnected = http.onDisconnected(onDisconnected);

  // Pull existing clients into the registry — `evaluate()` may run
  // after some sockets have already established (hot reload of this
  // file while the renderer is up).
  for (const [id, ws] of http.activeConnections) {
    onConnected(id, ws);
  }

  const unsubChanges = rt.subscribeStateChanges((msg) => {
    for (const ws of clients.values()) {
      sendTo(ws, msg);
    }
  });

  return () => {
    unsubConnected();
    unsubDisconnected();
    unsubChanges();
    clients.clear();
  };
}

/**
 * Pump service in-memory state to connected renderer clients over the
 * shared WebSocket. Mirrors `RpcService`: depends on `HttpService` for
 * the WS lifecycle, plugs into `onConnected` / `onDisconnected`, and
 * fans updates from the runtime's state registry.
 *
 * Wire envelope (multiplexed alongside `rpc` and `db`):
 *
 *   { ch: "state", data: { t: "snapshot", values: { "<plugin>.<svc>.<f>": <T>, ... } } }
 *   { ch: "state", data: { t: "update",   path: "<plugin>.<svc>.<f>", value: <T> } }
 *
 * `undefined` `value` on an update means the field is gone (service
 * torn down). The renderer drops it from its store.
 */
export class StateService extends Service.create({
  key: "state",
  deps: { http: HttpService },
}) {
  evaluate() {
    const http = this.ctx.http;
    this.setup("state-wiring", () =>
      wireStateBroadcast({ http, runtime }),
    );
    log.verbose("service ready");
  }
}

runtime.register(StateService, import.meta);

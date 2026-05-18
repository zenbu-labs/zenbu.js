import type { WebSocket } from "ws";
import { Service, runtime } from "../runtime";
import type { StateUpdateMessage, StateSnapshotMessage } from "../state";
import { HttpService } from "./http";
import { createLogger } from "../shared/log";

const log = createLogger("state");

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
    const { http } = this.ctx;

    this.setup("state-wiring", () => {
      const clients = new Map<string, WebSocket>();

      const sendTo = (
        ws: WebSocket,
        payload: StateSnapshotMessage | StateUpdateMessage,
      ) => {
        if (ws.readyState !== ws.OPEN) return;
        try {
          ws.send(JSON.stringify({ ch: "state", data: payload }));
        } catch (err) {
          log.verbose("ws send failed:", err);
        }
      };

      const onConnected = (id: string, ws: WebSocket) => {
        clients.set(id, ws);
        const snapshot: StateSnapshotMessage = {
          t: "snapshot",
          values: runtime.getStateEntries(),
        };
        sendTo(ws, snapshot);
      };

      const onDisconnected = (id: string) => {
        clients.delete(id);
      };

      const unsubConnected = http.onConnected(onConnected);
      const unsubDisconnected = http.onDisconnected(onDisconnected);

      // Pull existing clients into the registry — `evaluate()` may run
      // after some sockets have already established (hot reload of
      // this file while the renderer is up).
      for (const [id, ws] of http.activeConnections) {
        onConnected(id, ws);
      }

      const unsubChanges = runtime.subscribeStateChanges((msg) => {
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
    });

    log.verbose("service ready");
  }
}

runtime.register(StateService, import.meta);

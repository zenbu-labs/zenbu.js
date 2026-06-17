import type { WebSocket } from "ws";
import { createServer, createRpcRouter } from "@zenbu/zenrpc";
import type { AnyRouter, UnifiedEventProxy } from "@zenbu/zenrpc";
import { Service, runtime } from "../runtime";
import { HttpService } from "./http";
import { createLogger } from "../shared/log";
import type { Events as CoreEventsRaw } from "../events";
import type { ResolvedEvents } from "../registry";

// Core's events are namespaced under `core` to mirror plugin-scoped
// events (`{ <pluginName>: { … } }`). The runtime `createServer` is
// parameterized by this shape so its `emit` proxy starts at the plugin
// boundary, matching the consumer-side `ResolvedEvents` produced by
// `zen link`.
type CoreEvents = { core: CoreEventsRaw };

const log = createLogger("rpc");

type EmitProxy<T> = {
  [K in keyof T]: T[K] extends Record<string, any>
    ? EmitProxy<T[K]> & ((data: T[K]) => void)
    : (data: T[K]) => void;
};

export class RpcService extends Service.create({
  key: "rpc",
  deps: { http: HttpService },
}) {
  // `ResolvedEvents` reads `ZenbuRegister["events"]` (populated by
  // `zen link`-generated `zenbu-register.ts`), falling back to `CoreEvents`.
  // This is what makes `service.ctx.rpc.emit.<plugin-namespace>.<event>(data)`
  // resolve in user-authored services without baking plugin types into core.
  private _emit: EmitProxy<ResolvedEvents> | null = null;
  private _events: UnifiedEventProxy<ResolvedEvents> | null = null;

  get emit(): EmitProxy<ResolvedEvents> {
    if (!this._emit) throw new Error("RpcService not yet evaluated");
    return this._emit;
  }

  get events(): UnifiedEventProxy<ResolvedEvents> {
    if (!this._events) throw new Error("RpcService not yet evaluated");
    return this._events;
  }

  evaluate() {
    const { http } = this.ctx;

    this.setup("rpc-wiring", () => {
      const rpcRouter = createRpcRouter();

      const rpcServer = createServer<CoreEvents>({
        router: () => runtime.buildRouter() as AnyRouter,
        version: "0",
        send: rpcRouter.send,
      });

      this._emit = rpcServer.emit as EmitProxy<ResolvedEvents>;
      this._events = rpcServer.events as unknown as UnifiedEventProxy<ResolvedEvents>;

      const wsRpcConnections = new Map<
        string,
        {
          rpcConn: { receive: (data: string) => void; close: () => void };
          ws: WebSocket;
        }
      >();

      const onConnected = (id: string, ws: WebSocket) => {
        const rpcConn = rpcRouter.connection({
          send: (data: string) => {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ ch: "rpc", data }));
            }
          },
          postMessage: rpcServer.postMessage,
          removeClient: rpcServer.removeClient,
        });
        wsRpcConnections.set(id, { rpcConn, ws });

        ws.on("message", (raw: Buffer) => {
          const msg = JSON.parse(String(raw));
          if (msg.ch === "rpc") {
            rpcConn.receive(msg.data);
          }
        });
      };

      const onDisconnected = (id: string) => {
        const entry = wsRpcConnections.get(id);
        if (entry) {
          entry.rpcConn.close();
          wsRpcConnections.delete(id);
        }
      };

      const unsubConnected = http.onConnected(onConnected);
      const unsubDisconnected = http.onDisconnected(onDisconnected);

      return () => {
        this._emit = null;
        this._events = null;
        unsubConnected();
        unsubDisconnected();
        for (const { rpcConn, ws } of wsRpcConnections.values()) {
          rpcConn.close();
          ws.close();
        }
        wsRpcConnections.clear();
      };
    });

    log.verbose("service ready");
  }
}

runtime.register(RpcService, import.meta);

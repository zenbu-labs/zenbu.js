import type { AnyRouter, AnyRouterFactory, RpcContext, ExtractRequirements } from "./types";
import { serialize, deserialize } from "./protocol";
import { resolveMethod, executeMethod } from "./execute";

type ClientEntry = {
  clientId: string;
};

type CreateServerOptions<R = never> = {
  router: AnyRouterFactory;
  version: string;
  send: (data: string, clientId: string) => void;
  runtime?: { runPromiseExit: (effect: any) => Promise<any> };
};

const createEmitProxy = (
  send: (path: string[], data: unknown) => void,
  currentPath: string[] = [],
): any =>
  new Proxy(() => {}, {
    get(_target, prop) {
      if (typeof prop === "symbol") return undefined;
      return createEmitProxy(send, [...currentPath, prop as string]);
    },
    apply(_target, _thisArg, args) {
      send(currentPath, args[0]);
    },
  });

export const createServer = <
  TEvents extends Record<string, any> = Record<string, never>,
>(
  options: CreateServerOptions,
) => {
  const clients = new Map<string, ClientEntry>();

  const sendTo = (clientId: string) => (data: string) =>
    options.send(data, clientId);

  const postMessage = (data: string, clientId: string) => {
    const msg = deserialize(data);

    switch (msg.type) {
      case "handshake": {
        if (msg.version !== options.version) {
          options.send(
            serialize({
              type: "handshake-ack",
              ok: false,
              error: `Version mismatch: expected ${options.version}, got ${msg.version}`,
            }),
            clientId,
          );
          return;
        }

        clients.set(clientId, { clientId });

        options.send(serialize({ type: "handshake-ack", ok: true }), clientId);
        break;
      }

      case "request": {
        const entry = clients.get(clientId);
        if (!entry) {
          options.send(
            serialize({
              type: "error-response",
              id: msg.id,
              error: { message: "Not connected" },
            }),
            clientId,
          );
          return;
        }

        try {
          const ctx: RpcContext = { clientId };
          const routerInstance = options.router(() => ctx);
          const method = resolveMethod(routerInstance, msg.path);
          void executeMethod({
            method,
            methodArgs: msg.args,
            id: msg.id,
            send: sendTo(clientId),
            runtime: options.runtime,
          });
        } catch (err) {
          // Workaround: swallow the expected "Method not found" race below.
          const message = err instanceof Error ? err.message : String(err);
          const isExpectedRace = /^Method not found:/.test(message);
          if (!isExpectedRace) {
            console.error(
              `[zenrpc] request handler failed for ${msg.path?.join(".")}:`,
              err,
            );
          }
          options.send(
            serialize({
              type: "error-response",
              id: msg.id,
              error: { message },
            }),
            clientId,
          );
        }
        break;
      }
    }
  };

  const removeClient = (clientId: string) => {
    clients.delete(clientId);
  };

  type EmitProxy<T> = {
    [K in keyof T]: T[K] extends Record<string, any>
      ? EmitProxy<T[K]> & ((data: T[K]) => void)
      : (data: T[K]) => void;
  };

  const emit: EmitProxy<TEvents> = createEmitProxy(
    (path: string[], data: unknown) => {
      const msg = serialize({ type: "event", path, data });
      for (const [clientId] of clients) {
        options.send(msg, clientId);
      }
    },
  );

  const emitTo = (clientId: string): EmitProxy<TEvents> =>
    createEmitProxy((path: string[], data: unknown) => {
      if (!clients.has(clientId)) return;
      options.send(serialize({ type: "event", path, data }), clientId);
    });

  return { postMessage, removeClient, emit, emitTo };
};

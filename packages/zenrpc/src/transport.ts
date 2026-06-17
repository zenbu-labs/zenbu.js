import { nanoid } from "nanoid";
import { createClient } from "./client";
import { createUnifiedEventProxy } from "./events";
import type { AnyRouter, RouterProxy, UnifiedEventProxy } from "./types";

export function createRpcRouter() {
  const routes = new Map<string, (data: string) => void>();

  return {
    send(data: string, clientId: string) {
      routes.get(clientId)?.(data);
    },

    connection(opts: {
      send: (data: string) => void;
      postMessage: (data: string, clientId: string) => void;
      removeClient: (clientId: string) => void;
    }) {
      const clientId = nanoid();
      routes.set(clientId, opts.send);

      return {
        clientId,
        receive(data: string) {
          opts.postMessage(data, clientId);
        },
        close() {
          routes.delete(clientId);
          opts.removeClient(clientId);
        },
      };
    },
  };
}

export async function connectRpc<
  TServerRouter extends AnyRouter,
  TEvents extends Record<string, any> = Record<string, never>,
>(opts: {
  version: string;
  clientId?: string;
  send: (data: string) => void;
  subscribe: (cb: (data: string) => void) => () => void;
}): Promise<{
  server: RouterProxy<TServerRouter>;
  events: UnifiedEventProxy<TEvents>;
  disconnect: () => void;
}> {
  const clientId = opts.clientId ?? nanoid();

  let postMessage: ((data: string) => void) | null = null;
  const buffer: string[] = [];

  const unsub = opts.subscribe((data) => {
    if (postMessage) postMessage(data);
    else buffer.push(data);
  });

  const rpc = createClient<TServerRouter>({
    version: opts.version,
    clientId,
    send: opts.send,
  });

  postMessage = rpc.postMessage;
  for (const data of buffer) rpc.postMessage(data);

  await rpc.ready;

  const events: UnifiedEventProxy<TEvents> = createUnifiedEventProxy<TEvents>(
    rpc.eventListeners,
    rpc.emitEvent,
  );

  return {
    server: rpc.server,
    events,
    disconnect: () => {
      unsub();
    },
  };
}

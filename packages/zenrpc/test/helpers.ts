import { createServer } from "../src/server";
import { createClient } from "../src/client";
import { createUnifiedEventProxy } from "../src/events";
import type { AnyRouter, AnyRouterFactory, UnifiedEventProxy } from "../src/types";

export const createTransportPair = <
  TServerRouter extends AnyRouter,
  TEvents extends Record<string, any> = Record<string, never>,
>(args: {
  serverRouter: AnyRouterFactory;
  version: string;
  clientId: string;
}) => {
  const clientPostMessages = new Map<string, (data: string) => void>();

  const server = createServer<TEvents>({
    router: args.serverRouter,
    version: args.version,
    send: (data, clientId) => {
      queueMicrotask(() => clientPostMessages.get(clientId)?.(data));
    },
  });

  const client = createClient<TServerRouter>({
    version: args.version,
    clientId: args.clientId,
    send: (data) => {
      queueMicrotask(() => server.postMessage(data, args.clientId));
    },
  });

  clientPostMessages.set(args.clientId, client.postMessage);

  const events: UnifiedEventProxy<TEvents> = createUnifiedEventProxy<TEvents>(
    client.eventListeners,
    client.emitEvent,
  );

  return { server, client, events };
};

export const createMultiClientTransportPair = <
  TServerRouter extends AnyRouter,
  TEvents extends Record<string, any> = Record<string, never>,
>(args: {
  serverRouter: AnyRouterFactory;
  version: string;
  clientIds: string[];
}) => {
  const clientPostMessages = new Map<string, (data: string) => void>();

  const server = createServer<TEvents>({
    router: args.serverRouter,
    version: args.version,
    send: (data, clientId) => {
      queueMicrotask(() => clientPostMessages.get(clientId)?.(data));
    },
  });

  const clients = args.clientIds.map((clientId) => {
    const client = createClient<TServerRouter>({
      version: args.version,
      clientId,
      send: (data) => {
        queueMicrotask(() => server.postMessage(data, clientId));
      },
    });

    clientPostMessages.set(clientId, client.postMessage);

    const events: UnifiedEventProxy<TEvents> = createUnifiedEventProxy<TEvents>(
      client.eventListeners,
      client.emitEvent,
    );

    return { client, events, clientId };
  });

  return { server, clients };
};

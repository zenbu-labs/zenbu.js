import type { AnyRouter, RouterProxy } from "./types";
import { serialize, deserialize } from "./protocol";
import { createPendingRequests } from "./pending";
import { createProxy } from "./proxy";

type CreateClientOptions = {
  version: string;
  clientId: string;
  send: (data: string) => void;
};

export type EventListeners = {
  add: (path: string, cb: (data: unknown) => void) => () => void;
  dispatch: (path: string, data: unknown) => void;
};

export const createEventListeners = (): EventListeners => {
  const listeners = new Map<string, Set<(data: unknown) => void>>();

  return {
    add(path, cb) {
      let set = listeners.get(path);
      if (!set) {
        set = new Set();
        listeners.set(path, set);
      }
      set.add(cb);
      return () => {
        set!.delete(cb);
        if (set!.size === 0) listeners.delete(path);
      };
    },
    dispatch(path, data) {
      listeners.get(path)?.forEach((cb) => cb(data));
    },
  };
};

export const createClient = <TServerRouter extends AnyRouter = AnyRouter>(
  options: CreateClientOptions,
) => {
  const pending = createPendingRequests();
  const eventListeners = createEventListeners();
  let connected = false;
  let handshakeResolve: (() => void) | null = null;
  let handshakeReject: ((err: Error) => void) | null = null;

  const handshakePromise = new Promise<void>((resolve, reject) => {
    handshakeResolve = resolve;
    handshakeReject = reject;
  });

  options.send(
    serialize({
      type: "handshake",
      clientId: options.clientId,
      version: options.version,
    }),
  );

  const emitEvent = (path: string[], data: unknown) => {
    eventListeners.dispatch(path.join("."), data);
    options.send(serialize({ type: "event", path, data }));
  };

  const postMessage = (data: string) => {
    let msg: any;
    try {
      msg = deserialize(data);
    } catch (e) {
      console.error("[zenrpc] failed to deserialize:", data, e);
      return;
    }

    switch (msg.type) {
      case "handshake-ack": {
        if (msg.ok) {
          connected = true;
          handshakeResolve?.();
        } else {
          handshakeReject?.(new Error(msg.error ?? "Handshake rejected"));
        }
        break;
      }

      case "response": {
        pending.resolve(msg.id, msg.result);
        break;
      }

      case "error-response": {
        const errMsg = msg.error?.message ?? JSON.stringify(msg);
        pending.reject(msg.id, new Error(errMsg));
        break;
      }

      case "event": {
        eventListeners.dispatch(msg.path.join("."), msg.data);
        break;
      }
    }
  };

  const server: RouterProxy<TServerRouter> = createProxy<TServerRouter>({
    send: options.send,
    pending,
  });

  return {
    postMessage,
    server,
    eventListeners,
    emitEvent,
    ready: handshakePromise,
    get connected() {
      return connected;
    },
  };
};

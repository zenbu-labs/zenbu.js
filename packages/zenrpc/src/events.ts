import type { EventListeners } from "./client";

export const createEventProxy = <T extends Record<string, any>>(
  listeners: EventListeners,
  currentPath: string[] = [],
): any =>
  new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === "symbol") return undefined;
        if (prop === "subscribe") {
          const key = currentPath.join(".");
          return (cb: (data: unknown) => void) => listeners.add(key, cb);
        }
        return createEventProxy(listeners, [...currentPath, prop as string]);
      },
    },
  );

/**
 * Creates a unified event proxy where each node is both callable (emit)
 * and subscribable. Calling `proxy.path.to.event(data)` invokes `onEmit`;
 * `proxy.path.to.event.subscribe(cb)` registers a listener.
 */
export const createUnifiedEventProxy = <T extends Record<string, any>>(
  listeners: EventListeners,
  onEmit: (path: string[], data: unknown) => void,
  currentPath: string[] = [],
): any =>
  new Proxy(() => {}, {
    get(_target, prop) {
      if (typeof prop === "symbol") return undefined;
      if (prop === "subscribe") {
        const key = currentPath.join(".");
        return (cb: (data: unknown) => void) => listeners.add(key, cb);
      }
      return createUnifiedEventProxy(listeners, onEmit, [
        ...currentPath,
        prop as string,
      ]);
    },
    apply(_target, _thisArg, args) {
      onEmit(currentPath, args[0]);
    },
  });

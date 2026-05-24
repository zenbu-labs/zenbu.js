import type { KyjuJSON } from "../shared";

/**
 * Recorded mutation captured by `createRecordingProxy`. `set` ops
 * carry the new value; `delete` ops carry no value because the
 * intent is "unset this path" — not "set it to `undefined`/`null`".
 *
 * The downstream batcher in `client.ts` maps these onto wire-level
 * `root.set` / `root.delete` write ops; the replica + db reducers
 * fold them into the canonical root.
 */
export type RecordedOp =
  | { kind: "set"; path: string[]; value: KyjuJSON }
  | { kind: "delete"; path: string[] };

/**
 * 
 * we are recording the set of operations performed on a proxy object,
 * so that we can later play them over and convert them into events
 * to the kyju db
 * 
 */
export const createRecordingProxy = <T extends Record<string, any>>(
  target: T,
): {
  proxy: T;
  getOperations: () => RecordedOp[];
  snapshot: T;
} => {
  const operations: RecordedOp[] = [];
  const dirtyArrayPaths = new Map<string, { path: string[]; arr: any[] }>();

  const markArrayDirty = (arrayPath: string[], arr: any[]) => {
    const key = arrayPath.join("\0");
    if (!dirtyArrayPaths.has(key)) {
      dirtyArrayPaths.set(key, { path: arrayPath, arr });
    }
  };


  /**
   * invariant for a bug we encoutnered and are optimistically fixing
   */
  let warnedDeep = false;
  const warnDeep = (path: string[]) => {
    if (warnedDeep) return;
    warnedDeep = true;
    // eslint-disable-next-line no-console
    console.warn("[kyju] recording proxy navigated suspiciously deep", {
      length: path.length,
      head: path.slice(0, 10),
      tail: path.slice(-10),
    });
  };

  const makeProxy = (obj: any, currentPath: string[]): any => {
    if (currentPath.length > 64) warnDeep(currentPath);
    return new Proxy(obj, {
      get(t, prop, receiver) {
        if (typeof prop === "symbol") return Reflect.get(t, prop, receiver);
        const value = t[prop];
        if (value !== null && typeof value === "object") {
          return makeProxy(value, [...currentPath, prop as string]);
        }
        return value;
      },
      set(t, prop, value) {
        if (typeof prop === "symbol") {
          t[prop] = value;
          return true;
        }
        t[prop] = value;
        if (Array.isArray(t)) {
          markArrayDirty(currentPath, t);
        } else {
          const opPath = [...currentPath, prop as string];
          if (opPath.length > 64) warnDeep(opPath);
          operations.push({
            kind: "set",
            path: opPath,
            value: value as KyjuJSON,
          });
        }
        return true;
      },
      deleteProperty(t, prop) {
        // Skip symbol-keyed deletes and no-op deletes of properties
        // that aren't present: no observable mutation happened, so
        // there's nothing to ship to the replica.
        if (typeof prop === "symbol") {
          return Reflect.deleteProperty(t, prop);
        }
        const had = Object.prototype.hasOwnProperty.call(t, prop);
        const ok = delete t[prop];
        if (!ok || !had) return ok;
        if (Array.isArray(t)) {
          // Deleting an array index leaves a sparse hole; treat the
          // whole array as dirty so we replay it verbatim, same as
          // `set` on an array element.
          markArrayDirty(currentPath, t);
        } else {
          const opPath = [...currentPath, prop as string];
          if (opPath.length > 64) warnDeep(opPath);
          operations.push({ kind: "delete", path: opPath });
        }
        return true;
      },
    });
  };

  const snapshot = JSON.parse(JSON.stringify(target));
  return {
    proxy: makeProxy(snapshot, []),
    getOperations: () => {
      const result: RecordedOp[] = [...operations];
      for (const { path, arr } of dirtyArrayPaths.values()) {
        result.push({ kind: "set", path, value: arr as KyjuJSON });
      }
      return result;
    },
    snapshot,
  };
};

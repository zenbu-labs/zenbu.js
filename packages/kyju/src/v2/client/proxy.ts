import type { KyjuJSON } from "../shared";

export type RecordedOp = { path: string[]; value: KyjuJSON };

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
            path: opPath,
            value: value as KyjuJSON,
          });
        }
        return true;
      },
    });
  };

  const snapshot = JSON.parse(JSON.stringify(target));
  return {
    proxy: makeProxy(snapshot, []),
    getOperations: () => {
      const result = [...operations];
      for (const { path, arr } of dirtyArrayPaths.values()) {
        result.push({ path, value: arr as KyjuJSON });
      }
      return result;
    },
    snapshot,
  };
};

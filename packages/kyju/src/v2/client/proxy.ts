import type { KyjuJSON } from "../shared";

/**
 * Recorded mutation captured by `createRecordingProxy`. `set` ops
 * carry the new value; `delete` ops carry no value because the
 * intent is "unset this path" — not "set it to `undefined`/`null`".
 */
export type RecordedOp =
  | { kind: "set"; path: string[]; value: KyjuJSON }
  | { kind: "delete"; path: string[] };

/**
 * Records mutations performed against a proxy of `target`. Uses
 * Immer-style copy-on-write drafts: each proxy owns a Draft with a
 * `base` (live, never mutated) and a lazy `copy` (shallow-cloned on
 * first write). Traps read from `copy ?? base` locally — no global
 * path traversal — so reads/writes only cost what the caller touches.
 *
 * Object writes record individual set/delete ops. Array writes mark
 * the array dirty and flush the whole materialized array as one
 * `root.set` at `getOperations()` time.
 */
type Draft = {
  base: any;
  /** Shallow clone of `base`, allocated on first write. */
  copy: any | null;
  /** True if this draft or any descendant has been written to. */
  modified: boolean;
  parent: Draft | null;
  /** Key under which this draft sits inside `parent`. `null` for root. */
  parentKey: string | null;
  /** Cached child drafts — keeps `===` stable across repeated reads. */
  childDrafts: Map<string, Draft>;
  proxy: any;
  isArray: boolean;
  arrayDirty: boolean;
};

export const createRecordingProxy = <T extends Record<string, any>>(
  target: T,
): {
  proxy: T;
  getOperations: () => RecordedOp[];
  snapshot: T;
  isOwnedProxy: (value: unknown) => boolean;
  materialize: (value: unknown) => unknown;
} => {
  const operations: RecordedOp[] = [];
  const dirtyArrays = new Set<Draft>();
  const ownProxies = new WeakSet<object>();
  const proxyToDraft = new WeakMap<object, Draft>();

  let warnedDeep = false;
  const warnDeep = (depth: number) => {
    if (warnedDeep) return;
    warnedDeep = true;
    // eslint-disable-next-line no-console
    console.warn("[kyju] recording proxy navigated suspiciously deep", {
      depth,
    });
  };

  const pathOf = (draft: Draft): string[] => {
    const path: string[] = [];
    for (let d: Draft | null = draft; d && d.parent; d = d.parent) {
      path.unshift(d.parentKey!);
    }
    return path;
  };

  const ensureCopy = (draft: Draft) => {
    if (!draft.copy) {
      draft.copy = draft.isArray ? draft.base.slice() : { ...draft.base };
    }
    draft.modified = true;
    for (let p = draft.parent; p && !p.modified; p = p.parent) {
      p.modified = true;
    }
  };

  /**
   * Plain-JSON view of a draft. Unmodified ⇒ `base` (structural
   * sharing). Modified ⇒ shallow copy with modified children resolved.
   */
  const materializeDraft = (draft: Draft): any => {
    if (!draft.modified) return draft.base;
    const source = draft.copy ?? draft.base;
    const out: any = draft.isArray ? source.slice() : { ...source };
    for (const [k, child] of draft.childDrafts) {
      if (child.modified) out[k] = materializeDraft(child);
    }
    return out;
  };

  /**
   * Dereference our own proxies to plain JSON so stored values + emitted
   * ops never contain proxies (they don't structured-clone over the wire).
   *
   * Recurses into plain arrays/objects: a write like
   *   node.list = node.list.filter(...)        // elements are proxies
   *   node.x    = { ...readFromRoot, id: nextId } // nested fields are proxies
   * hands us a plain container whose *contents* are proxies the caller
   * read back out of the draft. If we only peeled the top level those
   * proxies would land in the stored state, and the next read+rewrite
   * would wrap them in a fresh proxy layer — nesting deeper on every
   * such write until reads/serialization of that branch stall. We
   * copy-on-write: branches with no proxy inside are returned as-is
   * (no allocation, identity preserved for structural sharing).
   *
   * `onPath` tracks the current DFS path so a circular reference
   * can't recurse forever. Kyju state is JSON (acyclic by contract);
   * a cycle is illegal input that would be rejected at serialization
   * regardless, so on a back-edge we just stop descending and return
   * the offending node as-is rather than stack-overflowing here.
   */
  const peelInner = (value: any, onPath: Set<object>): any => {
    if (value === null || typeof value !== "object") return value;
    const d = proxyToDraft.get(value);
    if (d) return materializeDraft(d);
    if (onPath.has(value)) return value;
    onPath.add(value);
    try {
      if (Array.isArray(value)) {
        let copy: any[] | null = null;
        for (let i = 0; i < value.length; i++) {
          const peeled = peelInner(value[i], onPath);
          if (peeled !== value[i]) {
            const next: any[] = copy ?? value.slice();
            next[i] = peeled;
            copy = next;
          }
        }
        return copy ?? value;
      }
      let copy: Record<string, any> | null = null;
      for (const k of Object.keys(value)) {
        const peeled = peelInner(value[k], onPath);
        if (peeled !== value[k]) {
          const next: Record<string, any> = copy ?? { ...value };
          next[k] = peeled;
          copy = next;
        }
      }
      return copy ?? value;
    } finally {
      onPath.delete(value);
    }
  };

  const peel = (value: any): any => {
    // Skip the Set allocation for the common primitive-value write.
    if (value === null || typeof value !== "object") return value;
    return peelInner(value, new Set());
  };

  const makeDraft = (
    base: any,
    parent: Draft | null,
    parentKey: string | null,
  ): Draft => {
    const draft: Draft = {
      base,
      copy: null,
      modified: false,
      parent,
      parentKey,
      childDrafts: new Map(),
      proxy: null!,
      isArray: Array.isArray(base),
      arrayDirty: false,
    };

    let depth = 0;
    for (let p = parent; p; p = p.parent) depth++;
    if (depth > 64) warnDeep(depth);

    draft.proxy = new Proxy(base, {
      get(_t, prop, receiver) {
        const source = draft.copy ?? draft.base;
        if (typeof prop === "symbol") {
          // `receiver` so iterators route their indexed reads back
          // through this proxy and see the overlay state.
          return Reflect.get(source, prop, receiver);
        }
        if (source === null || typeof source !== "object") return undefined;
        if (!(prop in source)) return undefined;
        const value = source[prop];
        if (value === null || typeof value !== "object") return value;
        let child = draft.childDrafts.get(prop);
        // If `child.base !== value`, the parent's slot was replaced
        // and the cached child is stale.
        if (!child || child.base !== value) {
          child = makeDraft(value, draft, prop);
          draft.childDrafts.set(prop, child);
        }
        return child.proxy;
      },

      set(_t, prop, value) {
        // Symbols aren't part of JSON state; no-op so we don't mutate base.
        if (typeof prop === "symbol") return true;
        const peeled = peel(value);
        ensureCopy(draft);
        draft.copy[prop] = peeled;
        draft.childDrafts.delete(prop);
        if (draft.isArray) {
          if (!draft.arrayDirty) {
            draft.arrayDirty = true;
            dirtyArrays.add(draft);
          }
        } else {
          const path = [...pathOf(draft), prop];
          if (path.length > 64) warnDeep(path.length);
          operations.push({ kind: "set", path, value: peeled as KyjuJSON });
        }
        return true;
      },

      deleteProperty(_t, prop) {
        if (typeof prop === "symbol") return true;
        const source = draft.copy ?? draft.base;
        if (!Object.prototype.hasOwnProperty.call(source, prop)) return true;
        ensureCopy(draft);
        delete draft.copy[prop];
        draft.childDrafts.delete(prop);
        if (draft.isArray) {
          if (!draft.arrayDirty) {
            draft.arrayDirty = true;
            dirtyArrays.add(draft);
          }
        } else {
          const path = [...pathOf(draft), prop];
          if (path.length > 64) warnDeep(path.length);
          operations.push({ kind: "delete", path });
        }
        return true;
      },

      has(_t, prop) {
        const source = draft.copy ?? draft.base;
        return source !== null && typeof source === "object" && prop in source;
      },

      ownKeys() {
        const source = draft.copy ?? draft.base;
        return source !== null && typeof source === "object"
          ? Reflect.ownKeys(source)
          : [];
      },

      getOwnPropertyDescriptor(_t, prop) {
        const source = draft.copy ?? draft.base;
        if (source === null || typeof source !== "object") return undefined;
        const desc = Reflect.getOwnPropertyDescriptor(source, prop);
        if (!desc) return undefined;
        // Mirror configurable/enumerable from the target when target has
        // a non-configurable own prop (proxy invariant). Arrays' `length`
        // is the case that hits in practice.
        const targetDesc = Reflect.getOwnPropertyDescriptor(_t, prop);
        if (targetDesc && !targetDesc.configurable) {
          desc.configurable = false;
          desc.enumerable = targetDesc.enumerable;
        } else {
          desc.configurable = true;
        }
        return desc;
      },
    });

    ownProxies.add(draft.proxy);
    proxyToDraft.set(draft.proxy, draft);
    return draft;
  };

  const rootDraft = makeDraft(target, null, null);

  return {
    proxy: rootDraft.proxy as T,
    snapshot: rootDraft.proxy as T,
    isOwnedProxy: (value) =>
      typeof value === "object" &&
      value !== null &&
      ownProxies.has(value as object),
    materialize: (value) => {
      if (typeof value !== "object" || value === null) return value;
      const d = proxyToDraft.get(value as object);
      return d ? materializeDraft(d) : value;
    },
    getOperations: () => {
      const result: RecordedOp[] = [...operations];
      for (const draft of dirtyArrays) {
        result.push({
          kind: "set",
          path: pathOf(draft),
          value: materializeDraft(draft) as KyjuJSON,
        });
      }
      return result;
    },
  };
};

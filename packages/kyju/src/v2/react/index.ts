import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { CollectionState, ClientState, ClientEvent, KyjuJSON } from "../shared";
import type { SchemaShape, InferRoot, CollectionRefBrand, InferCollectionItem } from "../db/schema";
import type { ClientProxy } from "../client/client";

export type CollectionResult<Item> = {
  items: Item[];
  totalCount: number;
  collection: CollectionState | null;
  concat: (items: Item[]) => void;
};

type Replica = {
  getState: () => ClientState;
  subscribe: (cb: (state: ClientState) => void) => () => void;
  postMessage: (event: ClientEvent) => Promise<void>;
  onCollectionConcat: (collectionId: string, cb: (data: { collection: CollectionState; newItems: unknown[] }) => void) => void;
  offCollectionConcat: (collectionId: string, cb: (data: { collection: CollectionState; newItems: unknown[] }) => void) => void;
};

type KyjuContextValue<TShape extends SchemaShape> = {
  client: ClientProxy<TShape>;
  replica: Replica;
};

export function createKyjuReact<
  TShape extends SchemaShape = SchemaShape,
  TRoot = InferRoot<TShape>,
>() {
  const KyjuContext = createContext<KyjuContextValue<TShape> | null>(null);

  type ProviderProps = {
    client: ClientProxy<TShape>;
    replica: Replica;
    children: ReactNode;
  };

  function KyjuProvider({ client, replica, children }: ProviderProps) {
    const value = useMemo<KyjuContextValue<TShape>>(
      () => ({ client, replica }),
      [client, replica],
    );
    return createElement(KyjuContext.Provider, { value }, children);
  }

  function useKyjuContext() {
    const ctx = useContext(KyjuContext);
    if (!ctx)
      throw new Error("useDb/useCollection must be used inside KyjuProvider");
    return ctx;
  }

  type Root = TRoot;

  function useDb(): Root;
  function useDb<T>(
    selector: (root: Root) => T,
    isEqual?: (a: T, b: T) => boolean,
  ): T;
  function useDb<T>(
    selector?: (root: Root) => T,
    isEqual?: (a: T, b: T) => boolean,
  ): T | Root {
    const { replica } = useKyjuContext();
    const selectorRef = useRef(selector);
    selectorRef.current = selector;
    const isEqualRef = useRef<((a: T, b: T) => boolean) | undefined>(isEqual);
    isEqualRef.current = isEqual;

    const cacheRef = useRef<{ output: T } | null>(null);
    const lastDbStateRef = useRef<ClientState | null>(null);

    const subscribe = useCallback(
      (cb: () => void) => replica.subscribe(() => cb()),
      [replica],
    );

    const getSnapshot = useCallback((): T | Root | undefined => {
      const state = replica.getState();
      if (state.kind !== "connected") return undefined;
      const root = state.root as Root;
      const sel = selectorRef.current;
      if (!sel) return root;
      const next = sel(root);
      const cache = cacheRef.current;
      if (cache != null) {
        const eq = isEqualRef.current ?? shallowEqual;
        if (eq(cache.output, next)) {
          lastDbStateRef.current = state;
          return cache.output;
        }
        if (process.env.NODE_ENV !== "production") {
          if (lastDbStateRef.current === state) {
            console.warn(
              `[zenbu] useDb selector returned a new value or reference even though the database state did not change. ` +
                `This will trigger an infinite re-render loop in React. ` +
                `Ensure the selector returns values owned by the database, or use useMemo to project the data outside useDb.\n\n` +
                `Selector: ${sel.toString()}`
            );
          }
        }
      }
      cacheRef.current = { output: next };
      lastDbStateRef.current = state;
      return next;
    }, [replica]);

    return useSyncExternalStore(subscribe, getSnapshot) as T | Root;
  }

  function useCollection<T extends { collectionId: string } & CollectionRefBrand<unknown>>(
    ref: T | null | undefined,
  ): CollectionResult<InferCollectionItem<T>> {
    type Item = InferCollectionItem<T>;
    const { client, replica } = useKyjuContext();
    const collectionId = ref?.collectionId || null;

    // Subscribe via `client.subscribeCollection` (not raw replica messages)
    // so the client refcount is honored: two consumers of the same collection
    // (e.g. one chat in two split panes) must not unsubscribe each other.
    useEffect(() => {
      if (!collectionId) return;
      return client.subscribeCollection(collectionId);
    }, [collectionId, client]);

    // getSnapshot must be `Object.is`-stable when nothing changed, so cache
    // keyed on `collectionId` + the `CollectionState` reference.
    type Snapshot = {
      items: Item[];
      totalCount: number;
      collection: CollectionState | null;
    };
    const cacheRef = useRef<{
      id: string | null;
      collection: CollectionState | null;
      out: Snapshot;
    } | null>(null);

    const subscribe = useCallback(
      (cb: () => void) => replica.subscribe(() => cb()),
      [replica],
    );

    // Read collection state synchronously from the replica every render.
    // Mirroring into React state instead caused a one-frame flicker of the
    // previous collection's items when `collectionId` flipped.
    const getSnapshot = useCallback((): Snapshot => {
      if (!collectionId) {
        const cached = cacheRef.current;
        if (cached && cached.id === null) return cached.out;
        const out: Snapshot = { items: [], totalCount: 0, collection: null };
        cacheRef.current = { id: null, collection: null, out };
        return out;
      }
      const s = replica.getState();
      const col =
        s.kind === "connected"
          ? s.collections.find((c) => c.id === collectionId) ?? null
          : null;
      const cached = cacheRef.current;
      if (
        cached &&
        cached.id === collectionId &&
        cached.collection === col
      ) {
        return cached.out;
      }
      const out: Snapshot = {
        items: (col?.items ?? []) as Item[],
        totalCount: col?.totalCount ?? 0,
        collection: col,
      };
      cacheRef.current = { id: collectionId, collection: col, out };
      return out;
    }, [replica, collectionId]);

    const snapshot = useSyncExternalStore(subscribe, getSnapshot);

    const concat = useMemo(() => {
      if (!collectionId) return (_items: Item[]) => {};
      return (items: Item[]) => {
        replica.postMessage({
          kind: "write",
          op: { type: "collection.concat", collectionId, data: items as KyjuJSON[] },
        });
      };
    }, [collectionId, replica]);

    return useMemo(
      () => ({
        items: snapshot.items,
        totalCount: snapshot.totalCount,
        collection: snapshot.collection,
        concat,
      }),
      [snapshot, concat],
    );
  }

  return { KyjuProvider, useDb, useCollection };
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    a === null ||
    typeof b !== "object" ||
    b === null
  )
    return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], (b as unknown[])[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ka = Object.keys(ao);
  const kb = Object.keys(bo);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!Object.is(ao[k], bo[k])) return false;
  }
  return true;
}

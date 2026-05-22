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
        if (eq(cache.output, next)) return cache.output;
      }
      cacheRef.current = { output: next };
      return next;
    }, [replica]);

    return useSyncExternalStore(subscribe, getSnapshot) as T | Root;
  }

  function useCollection<T extends { collectionId: string } & CollectionRefBrand<unknown>>(
    ref: T | null | undefined,
  ): CollectionResult<InferCollectionItem<T>> {
    type Item = InferCollectionItem<T>;
    const { replica } = useKyjuContext();
    const collectionId = ref?.collectionId || null;

    // Drive subscription lifecycle from an effect (post-render so we
    // don't side-effect the replica during render). The actual
    // displayed data is read directly off the replica via
    // useSyncExternalStore below — see the comment on `getSnapshot`
    // for why mirroring into React state isn't safe here.
    useEffect(() => {
      if (!collectionId) return;
      replica.postMessage({ kind: "subscribe-collection", collectionId });
      return () => {
        replica
          .postMessage({ kind: "unsubscribe-collection", collectionId })
          .catch(() => {});
      };
    }, [collectionId, replica]);

    // Cache for useSyncExternalStore: getSnapshot must return
    // `Object.is`-stable values across calls when nothing changed, or
    // React will warn and re-render forever. We key the cache on
    // `collectionId` + the underlying `CollectionState` reference so
    // we hand out the same wrapper object until either changes.
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

    // Read the current collection state synchronously from the replica
    // on every render. The previous implementation mirrored the
    // collection's items into React state via setState in an effect:
    // when `collectionId` flipped (e.g. switching between two chats'
    // event logs), the stale items from the previous collection
    // remained in state until the new subscribe-collection ack landed,
    // which renderers painted as a one-frame flicker of the wrong
    // collection's data. Reading directly from the replica's state
    // closes that window — a `collectionId` change shows the new
    // collection's data (or empty, if it isn't loaded yet) on the
    // very same render.
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

import * as Effect from "effect/Effect";
import { nanoid } from "nanoid";
import type {
  CollectionWindow,
  ClientState,
  ClientEvent,
  KyjuJSON,
  KyjuError,
  WriteOp,
} from "../shared";
import type { CollectionConcatCallback } from "../replica/replica";
import type zod from "zod";
import type {
  SchemaShape,
  Field,
  CollectionRefBrand,
  BlobRef,
  InferRoot,
  InferFieldType,
} from "../db/schema";
import { createRecordingProxy } from "./proxy";
import { traceKyju } from "../trace";

type ConnectedState = Extract<ClientState, { kind: "connected" }>;

export type EffectCollectionNode<Item> = {
  concat(items: Item[]): Effect.Effect<void, KyjuError>;
  read(range?: { start: number; end: number }): Effect.Effect<void, KyjuError>;
  create(data?: Item[]): Effect.Effect<void, KyjuError>;
  delete(): Effect.Effect<void, KyjuError>;
  subscribe(
    cb: (value: { collectionId: string; debugName: string }) => void,
  ): () => void;
  subscribeData(
    cb: (data: { collection: CollectionWindow; newItems: Item[] }) => void,
  ): () => void;
};

export type EffectBlobNode = {
  read(): Effect.Effect<void, KyjuError>;
  set(data: Uint8Array): Effect.Effect<void, KyjuError>;
  create(data: Uint8Array, hot?: boolean): Effect.Effect<void, KyjuError>;
  delete(): Effect.Effect<void, KyjuError>;
};

export type EffectFieldNode<T> = T extends CollectionRefBrand<infer Item>
  ? EffectCollectionNode<Item>
  : T extends Array<infer E>
    ? EffectArrayFieldNode<T, E>
    : {
        read(): T;
        set(value: T): Effect.Effect<void, KyjuError>;
        subscribe(cb: (value: T) => void): () => void;
      } & (T extends Record<string, any>
        ? { [K in keyof T]: EffectFieldNode<T[K]> }
        : {});

export type EffectArrayFieldNode<T extends Array<any>, E> = {
  read(): T;
  set(value: T): Effect.Effect<void, KyjuError>;
  subscribe(cb: (value: T) => void): () => void;
  length: number;
  find(predicate: (item: E, index: number, arr: E[]) => boolean): EffectFieldNode<E> | undefined;
  findIndex(predicate: (item: E, index: number, arr: E[]) => boolean): number;
  at(index: number): EffectFieldNode<E> | undefined;
  map<U>(fn: (item: E, index: number, arr: E[]) => U): U[];
  filter(predicate: (item: E, index: number, arr: E[]) => boolean): E[];
  some(predicate: (item: E, index: number, arr: E[]) => boolean): boolean;
  every(predicate: (item: E, index: number, arr: E[]) => boolean): boolean;
  forEach(fn: (item: E, index: number, arr: E[]) => void): void;
  reduce<U>(fn: (acc: U, item: E, index: number, arr: E[]) => U, initial: U): U;
  indexOf(item: E, fromIndex?: number): number;
  includes(item: E, fromIndex?: number): boolean;
  slice(start?: number, end?: number): E[];
  flatMap<U>(fn: (item: E, index: number, arr: E[]) => U | U[]): U[];
  join(separator?: string): string;
  [Symbol.iterator](): IterableIterator<E>;
  [index: number]: EffectFieldNode<E>;
};

export type CollectionNode<Item> = {
  concat(items: Item[]): Promise<void>;
  read(range?: { start: number; end: number }): Promise<void>;
  create(data?: Item[]): Promise<void>;
  delete(): Promise<void>;
  subscribe(
    cb: (value: { collectionId: string; debugName: string }) => void,
  ): () => void;
  subscribeData(
    cb: (data: { collection: CollectionWindow; newItems: Item[] }) => void,
  ): () => void;
};

export type BlobNode = {
  read(): Promise<void>;
  set(data: Uint8Array): Promise<void>;
  create(data: Uint8Array, hot?: boolean): Promise<void>;
  delete(): Promise<void>;
};

export type FieldNode<T> = T extends CollectionRefBrand<infer Item>
  ? CollectionNode<Item>
  : T extends Array<infer E>
    ? ArrayFieldNode<T, E>
    : {
        read(): T;
        set(value: T): Promise<void>;
        subscribe(cb: (value: T) => void): () => void;
      } & (T extends Record<string, any>
        ? { [K in keyof T]: FieldNode<T[K]> }
        : {});

export type ArrayFieldNode<T extends Array<any>, E> = {
  read(): T;
  set(value: T): Promise<void>;
  subscribe(cb: (value: T) => void): () => void;
  length: number;
  find(predicate: (item: E, index: number, arr: E[]) => boolean): FieldNode<E> | undefined;
  findIndex(predicate: (item: E, index: number, arr: E[]) => boolean): number;
  at(index: number): FieldNode<E> | undefined;
  map<U>(fn: (item: E, index: number, arr: E[]) => U): U[];
  filter(predicate: (item: E, index: number, arr: E[]) => boolean): E[];
  some(predicate: (item: E, index: number, arr: E[]) => boolean): boolean;
  every(predicate: (item: E, index: number, arr: E[]) => boolean): boolean;
  forEach(fn: (item: E, index: number, arr: E[]) => void): void;
  reduce<U>(fn: (acc: U, item: E, index: number, arr: E[]) => U, initial: U): U;
  indexOf(item: E, fromIndex?: number): number;
  includes(item: E, fromIndex?: number): boolean;
  slice(start?: number, end?: number): E[];
  flatMap<U>(fn: (item: E, index: number, arr: E[]) => U | U[]): U[];
  join(separator?: string): string;
  [Symbol.iterator](): IterableIterator<E>;
  [index: number]: FieldNode<E>;
};

type ResolveField<V> = V extends Field<infer S, boolean>
  ? InferFieldType<S>
  : V extends zod.ZodType<infer O>
  ? O
  : never;

export type EffectClientProxy<Shape extends SchemaShape> = {
  [K in keyof Shape]: Shape[K] extends Field<BlobRef, boolean>
    ? EffectBlobNode
    : EffectFieldNode<ResolveField<Shape[K]>>;
} & {
  readRoot(): InferRoot<Shape>;
  update(
    fn: (root: InferRoot<Shape>) => void | InferRoot<Shape>,
  ): Effect.Effect<void, KyjuError>;
  createBlob(
    data: Uint8Array,
    opts?: { contentType?: string; hot?: boolean } | boolean,
  ): Effect.Effect<string, KyjuError>;
  deleteBlob(blobId: string): Effect.Effect<void, KyjuError>;
  getBlobData(blobId: string): Effect.Effect<Uint8Array | null, KyjuError>;
  getBlobMetadata(blobId: string): Effect.Effect<{ fileSize: number; contentType: string | null } | null, never>;
  /**
   * Refcounted subscription to a collection by its id.
   *
   * Increments an internal counter scoped to this client. Sends
   * `subscribe-collection` to the replica only on the 0→N transition
   * and `unsubscribe-collection` only on the N→0 transition, so that
   * multiple independent callers (e.g. two React components on the
   * same `useCollection(ref)`, or a hook + a manual `subscribeData`)
   * can share one logical subscription without one tearing down the
   * other's data.
   *
   * Returns an idempotent unsubscribe function. Calling it more than
   * once is a no-op.
   */
  subscribeCollection(collectionId: string): () => void;
};

export type ClientProxy<Shape extends SchemaShape> = {
  [K in keyof Shape]: Shape[K] extends Field<BlobRef, boolean>
    ? BlobNode
    : FieldNode<ResolveField<Shape[K]>>;
} & {
  readRoot(): InferRoot<Shape>;
  update(
    fn: (root: InferRoot<Shape>) => void | InferRoot<Shape>,
  ): Promise<void>;
  createBlob(
    data: Uint8Array,
    opts?: { contentType?: string; hot?: boolean } | boolean,
  ): Promise<string>;
  deleteBlob(blobId: string): Promise<void>;
  getBlobData(blobId: string): Promise<Uint8Array | null>;
  getBlobMetadata(blobId: string): Promise<{ fileSize: number; contentType: string | null } | null>;
  /** See `EffectClientProxy.subscribeCollection`. */
  subscribeCollection(collectionId: string): () => void;
};

type EffectReplica = {
  postMessageEffect: (event: ClientEvent) => Effect.Effect<void, KyjuError>;
  getState: () => ClientState;
  subscribe: (cb: (state: ClientState) => void) => () => void;
  onCollectionConcat: (
    collectionId: string,
    cb: CollectionConcatCallback,
  ) => void;
  offCollectionConcat: (
    collectionId: string,
    cb: CollectionConcatCallback,
  ) => void;
};

type PromiseReplica = {
  postMessage: (event: ClientEvent) => Promise<void>;
  getState: () => ClientState;
  subscribe: (cb: (state: ClientState) => void) => () => void;
  onCollectionConcat: (
    collectionId: string,
    cb: CollectionConcatCallback,
  ) => void;
  offCollectionConcat: (
    collectionId: string,
    cb: CollectionConcatCallback,
  ) => void;
};

function createClientCore<TShape extends SchemaShape>(
  send: (event: ClientEvent) => Effect.Effect<void, KyjuError>,
  replica: {
    getState: () => ClientState;
    subscribe: (cb: (state: ClientState) => void) => () => void;
    onCollectionConcat: (
      collectionId: string,
      cb: CollectionConcatCallback,
    ) => void;
    offCollectionConcat: (
      collectionId: string,
      cb: CollectionConcatCallback,
    ) => void;
  },
): EffectClientProxy<TShape> {
  // Per-client refcount of active collection subscriptions, keyed by
  // collectionId. Shared by both `subscribeData(cb)` (path-bound,
  // delivers concat events) and `subscribeCollection(id)` (id-bound,
  // just keeps the data alive). Sharing matters: with two separate
  // counters the second consumer's teardown could unsubscribe a
  // collection the first is still using, and the replica drops its
  // local copy on every `unsubscribe-collection` it receives.
  const subscriberCounts = new Map<string, number>();
  const subscribePromises = new Map<string, Promise<void>>();

  /**
   * Refcounted subscribe by collectionId. Returns:
   *   - `ready`: resolves once the subscribe ack has landed (or
   *     immediately, if another caller already subscribed).
   *   - `unsubscribe`: idempotent. Drops the refcount and only
   *     posts `unsubscribe-collection` when the last subscriber leaves.
   */
  const subscribeCollectionRefcounted = (
    collectionId: string,
  ): { ready: Promise<void>; unsubscribe: () => void } => {
    const count = subscriberCounts.get(collectionId) ?? 0;
    subscriberCounts.set(collectionId, count + 1);

    let ready: Promise<void>;
    if (count === 0) {
      ready = Effect.runPromise(
        send({ kind: "subscribe-collection", collectionId }).pipe(
          Effect.catchAll(() => Effect.void),
        ),
      );
      subscribePromises.set(collectionId, ready);
    } else {
      ready = subscribePromises.get(collectionId) ?? Promise.resolve();
    }

    let unsubscribed = false;
    return {
      ready,
      unsubscribe: () => {
        if (unsubscribed) return;
        unsubscribed = true;
        const current = subscriberCounts.get(collectionId) ?? 1;
        if (current <= 1) {
          subscriberCounts.delete(collectionId);
          subscribePromises.delete(collectionId);
          Effect.runPromise(
            send({ kind: "unsubscribe-collection", collectionId }).pipe(
              Effect.catchAll(() => Effect.void),
            ),
          );
        } else {
          subscriberCounts.set(collectionId, current - 1);
        }
      },
    };
  };

  const subscribeCollectionFn = (collectionId: string): (() => void) => {
    const { unsubscribe } = subscribeCollectionRefcounted(collectionId);
    return unsubscribe;
  };

  const getConnectedState = (): ConnectedState => {
    const state = replica.getState();
    if (state.kind === "disconnected") {
      throw new Error("Cannot read state: not connected");
    }
    return state;
  };

  const getRoot = () => getConnectedState().root as Record<string, any>;

  const getAtPath = (obj: any, path: string[]): any => {
    let current = obj;
    for (const key of path) {
      if (current == null) return undefined;
      current = current[key];
    }
    return current;
  };

  const isCollectionValue = (val: any): boolean =>
    val != null && typeof val === "object" && "collectionId" in val;

  const isBlobValue = (val: any): boolean =>
    val != null && typeof val === "object" && "blobId" in val;

  const subscribeToPath = (
    path: string[],
    cb: (value: any) => void,
  ): (() => void) => {
    let prev: any;
    let initialized = false;

    return replica.subscribe((state) => {
      if (state.kind === "disconnected") return;
      const value = getAtPath(state.root, path);
      if (!initialized || !Object.is(prev, value)) {
        prev = value;
        initialized = true;
        cb(value);
      }
    });
  };

  const makeCollectionNode = (fieldKey: string): EffectCollectionNode<any> => {
    const getCollectionId = () => {
      const ref = getAtPath(getRoot(), [fieldKey]);
      return ref?.collectionId as string;
    };

    return {
      concat: (items) => {
        const sendData = {
          kind: "write",
          op: {
            type: "collection.concat",
            collectionId: getCollectionId(),
            data: items as KyjuJSON[],
          },
        } as const;

        return send(sendData);
      },
      read: (range) =>
        send({
          kind: "read",
          op: {
            type: "collection.fetch-range",
            collectionId: getCollectionId(),
            range: range ?? { start: 0, end: Number.MAX_SAFE_INTEGER },
          },
        }),
      create: (data) =>
        Effect.gen(function* () {
          const collectionId = nanoid();
          yield* send({
            kind: "write",
            op: {
              type: "collection.create",
              collectionId,
              data: data as KyjuJSON[] | undefined,
            },
          });
          yield* send({
            kind: "write",
            op: {
              type: "root.set",
              path: [fieldKey],
              value: { collectionId, debugName: fieldKey },
            },
          });
        }),
      delete: () =>
        send({
          kind: "write",
          op: {
            type: "collection.delete",
            collectionId: getCollectionId(),
          },
        }),
      subscribe: (cb) => subscribeToPath([fieldKey], cb),
      subscribeData: (cb) =>
        makeCollectionNodeAtPath([fieldKey]).subscribeData(cb),
    };
  };

  const makeCollectionNodeAtPath = (
    path: string[],
  ): EffectCollectionNode<any> => {
    const getCollectionId = () => {
      const ref = getAtPath(getRoot(), path);
      return ref?.collectionId as string;
    };

    return {
      concat: (items) =>
        send({
          kind: "write",
          op: {
            type: "collection.concat",
            collectionId: getCollectionId(),
            data: items as KyjuJSON[],
          },
        }),
      read: (range) =>
        send({
          kind: "read",
          op: {
            type: "collection.fetch-range",
            collectionId: getCollectionId(),
            range: range ?? { start: 0, end: Number.MAX_SAFE_INTEGER },
          },
        }),
      create: (data) =>
        Effect.gen(function* () {
          const collectionId = nanoid();
          yield* send({
            kind: "write",
            op: {
              type: "collection.create",
              collectionId,
              data: data as KyjuJSON[] | undefined,
            },
          });
          yield* send({
            kind: "write",
            op: {
              type: "root.set",
              path,
              value: { collectionId, debugName: path[path.length - 1] ?? "" },
            },
          });
        }),
      delete: () =>
        send({
          kind: "write",
          op: {
            type: "collection.delete",
            collectionId: getCollectionId(),
          },
        }),
      subscribe: (cb) => subscribeToPath(path, cb),
      subscribeData: (cb) => {
        const collectionId = getCollectionId();

        const wrappedCb: CollectionConcatCallback = (data) => {
          cb({ collection: data.collection, newItems: data.newItems as any[] });
        };
        replica.onCollectionConcat(collectionId, wrappedCb);

        const { ready, unsubscribe } =
          subscribeCollectionRefcounted(collectionId);

        const deliverInitial = () => {
          const state = replica.getState();
          if (state.kind === "connected") {
            const col = state.collections.find((c) => c.id === collectionId);
            if (col) {
              cb({ collection: col, newItems: col.items as any[] });
            }
          }
        };
        ready.then(deliverInitial);

        let unsubscribed = false;
        return () => {
          if (unsubscribed) return;
          unsubscribed = true;
          replica.offCollectionConcat(collectionId, wrappedCb);
          unsubscribe();
        };
      },
    };
  };

  const makeBlobNode = (fieldKey: string): EffectBlobNode => {
    const getBlobId = () => {
      const ref = getAtPath(getRoot(), [fieldKey]);
      return ref?.blobId as string;
    };

    return {
      read: () =>
        send({
          kind: "read",
          op: { type: "blob.read", blobId: getBlobId() },
        }),
      set: (data) =>
        send({
          kind: "write",
          op: { type: "blob.set", blobId: getBlobId(), data },
        }),
      create: (data, hot) =>
        Effect.gen(function* () {
          const blobId = nanoid();
          yield* send({
            kind: "write",
            op: { type: "blob.create", blobId, data, hot },
          });
          yield* send({
            kind: "write",
            op: {
              type: "root.set",
              path: [fieldKey],
              value: { blobId, debugName: fieldKey },
            },
          });
        }),
      delete: () =>
        send({
          kind: "write",
          op: { type: "blob.delete", blobId: getBlobId() },
        }),
    };
  };

  const ARRAY_READ_METHODS = new Set([
    "map", "filter", "slice", "flatMap", "reduce", "reduceRight",
    "forEach", "some", "every", "indexOf", "includes", "join",
    "findIndex", "keys", "values", "entries", "flat", "toString",
  ]);

  const makeFieldNode = (path: string[]): any =>
    new Proxy(
      {},
      {
        get(_, prop) {
          if (typeof prop === "symbol") {
            const val = getAtPath(getRoot(), path);
            if (Array.isArray(val) && prop === Symbol.iterator) {
              return val[Symbol.iterator].bind(val);
            }
            return undefined;
          }

          const val = getAtPath(getRoot(), path);
          if (isCollectionValue(val)) {
            const node = makeCollectionNodeAtPath(path);
            if (
              prop in node ||
              prop === "concat" ||
              prop === "subscribeData" ||
              prop === "read" ||
              prop === "create" ||
              prop === "delete" ||
              prop === "subscribe"
            ) {
              return (node as any)[prop];
            }
          }

          if (Array.isArray(val)) {
            switch (prop) {
              case "read":
                return () => val;
              case "set":
                return (value: any) =>
                  send({
                    kind: "write",
                    op: { type: "root.set", path, value },
                  });
              case "subscribe":
                return (cb: (value: any) => void) =>
                  subscribeToPath(path, cb);
              case "length":
                return val.length;
              case "find":
                return (predicate: (item: any, index: number, arr: any[]) => boolean) => {
                  const index = val.findIndex(predicate);
                  if (index < 0) return undefined;
                  return makeFieldNode([...path, String(index)]);
                };
              case "at":
                return (i: number) => {
                  const resolved = i < 0 ? val.length + i : i;
                  if (resolved < 0 || resolved >= val.length) return undefined;
                  return makeFieldNode([...path, String(resolved)]);
                };
              default:
                if (ARRAY_READ_METHODS.has(prop)) {
                  return (Array.prototype as any)[prop].bind(val);
                }
                if (/^\d+$/.test(prop)) {
                  return makeFieldNode([...path, prop]);
                }
                return makeFieldNode([...path, prop]);
            }
          }

          switch (prop) {
            case "read":
              return () => val;
            case "set":
              return (value: any) =>
                send({
                  kind: "write",
                  op: { type: "root.set", path, value },
                });
            case "subscribe":
              return (cb: (value: any) => void) => subscribeToPath(path, cb);
            default:
              return makeFieldNode([...path, prop as string]);
          }
        },
      },
    );

  const readRootFn = () => getRoot();

  const updateFn = (fn: (root: any) => any) =>
    traceKyju(
      "kyju:client.update",
      Effect.gen(function* () {
        const root = getRoot();
        const { proxy, getOperations, materialize, isOwnedProxy } =
          createRecordingProxy(root);
        const result = fn(proxy);

        if (result !== undefined) {
          // Returning a value from the updater replaces the whole root,
          // which is already a single op. If the user returned our proxy
          // (or any node from it), materialize it into a plain JSON copy
          // before sending — the proxy isn't structured-cloneable and
          // would otherwise serialize as its empty live target.
          const value = isOwnedProxy(result) ? materialize(result) : result;
          yield* send({
            kind: "write",
            op: { type: "root.set", path: [], value: value as any },
          });
          return;
        }

        const recorded = getOperations();
        if (recorded.length === 0) return;

        const ops: WriteOp[] = recorded.map((op) =>
          op.kind === "delete"
            ? ({ type: "root.delete" as const, path: op.path })
            : ({
                type: "root.set" as const,
                path: op.path,
                value: op.value,
              }),
        );

        if (ops.length === 1) {
          // Fast path: no batching overhead for the common single-write
          // case, and behaviour is byte-identical to pre-batching builds.
          yield* send({ kind: "write", op: ops[0]! });
          return;
        }

        // Multiple ops produced by one `update(fn)` get shipped to the
        // replica as a single `write-batch` event. The replica folds
        // them with one `Ref.update` so every `useDb` / `subscribe`
        // caller observes exactly one new state per `update()` call,
        // not one per recorded op. Without this the renderer paints
        // intermediate states where some paths are written and others
        // are not yet, which surfaces as visible flicker on actions
        // the app author wrote as a single transaction.
        yield* send({ kind: "write-batch", ops });
      }),
    );

  const createBlobFn = (
    data: Uint8Array,
    opts?: { contentType?: string; hot?: boolean } | boolean,
  ) =>
    Effect.gen(function* () {
      const blobId = nanoid();
      const hot = typeof opts === "boolean" ? opts : opts?.hot;
      const contentType = typeof opts === "object" ? opts?.contentType : undefined;
      yield* send({
        kind: "write",
        op: { type: "blob.create", blobId, data, hot, contentType },
      });
      return blobId;
    });

  const getBlobMetadataFn = (blobId: string) =>
    Effect.sync(() => {
      const state = replica.getState();
      if (state.kind !== "connected") return null;
      const blob = state.blobs.find((b) => b.id === blobId);
      if (!blob) return null;
      return {
        fileSize: blob.fileSize,
        contentType: blob.contentType ?? null,
      };
    });

  const deleteBlobFn = (blobId: string) =>
    send({
      kind: "write",
      op: { type: "blob.delete" as const, blobId },
    });

  const getBlobDataFn = (blobId: string) =>
    Effect.gen(function* () {
      const state = replica.getState();
      if (state.kind !== "connected") return null;

      // Fast path: already hot
      const blob = state.blobs.find((b) => b.id === blobId);
      if (blob && blob.data.kind === "hot") return blob.data.value;

      // Cold or missing from state — warm it from disk
      yield* send({
        kind: "read",
        op: { type: "blob.read" as const, blobId },
      }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

      const newState = replica.getState();
      if (newState.kind !== "connected") return null;
      const warmed = newState.blobs.find((b) => b.id === blobId);
      if (!warmed || warmed.data.kind !== "hot") return null;
      return warmed.data.value;
    });

  return new Proxy({} as EffectClientProxy<TShape>, {
    get(_, prop) {
      if (typeof prop === "symbol") return undefined;
      if (prop === "readRoot") return readRootFn;
      if (prop === "update") return updateFn;
      if (prop === "createBlob") return createBlobFn;
      if (prop === "deleteBlob") return deleteBlobFn;
      if (prop === "getBlobData") return getBlobDataFn;
      if (prop === "getBlobMetadata") return getBlobMetadataFn;
      if (prop === "subscribeCollection") return subscribeCollectionFn;

      const rootVal = getAtPath(getRoot(), [prop as string]);
      if (isCollectionValue(rootVal)) return makeCollectionNode(prop as string);
      if (isBlobValue(rootVal)) return makeBlobNode(prop as string);

      return makeFieldNode([prop as string]);
    },
  });
}

export const createEffectClient = <TShape extends SchemaShape>(
  replica: EffectReplica,
): EffectClientProxy<TShape> =>
  createClientCore<TShape>(replica.postMessageEffect, replica);

function wrapEffectProxy(target: any): any {
  return new Proxy(target, {
    get(t, prop) {
      if (typeof prop === "symbol") return Reflect.get(t, prop);
      const val = t[prop];
      if (typeof val === "function") {
        return (...args: any[]) => {
          const result = val(...args);
          if (Effect.isEffect(result)) {
            return Effect.runPromise(
              (result as Effect.Effect<any, any, never>).pipe(
                Effect.catchAll(() => Effect.void),
              ),
            );
          }
          if (result != null && typeof result === "object" && !Array.isArray(result)) {
            return wrapEffectProxy(result);
          }
          return result;
        };
      }
      if (val != null && typeof val === "object" && !Array.isArray(val)) {
        return wrapEffectProxy(val);
      }
      return val;
    },
  });
}

export const createClient = <TShape extends SchemaShape>(
  replica: PromiseReplica | EffectReplica,
): ClientProxy<TShape> => {
  const effectReplica: EffectReplica =
    "postMessageEffect" in replica
      ? replica
      : {
          ...replica,
          postMessageEffect: (event: ClientEvent) =>
            Effect.promise(() =>
              (replica as PromiseReplica).postMessage(event),
            ),
        };
  const effectClient = createEffectClient<TShape>(effectReplica);
  return wrapEffectProxy(effectClient) as ClientProxy<TShape>;
};

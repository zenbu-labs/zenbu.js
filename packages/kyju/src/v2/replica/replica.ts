import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { nanoid } from "nanoid";
import {
  type Ack,
  type ClientBlob,
  type ClientEvent,
  type ClientState,
  type CollectionFetchRangeAck,
  type CollectionState,
  type ConnectAck,
  type SubscribeAck,
  type BlobReadAck,
  type KyjuJSON,
  type ServerEvent,
  type WriteOp,
  ClientStateRef,
  MaxPageSizeContext,
  SendContext,
  VERSION,
} from "../shared";
import {
  applyState,
  deleteAtPath,
  makeRequestAwaiter,
  requireConnected,
  setAtPath,
  type ConnectedState,
} from "./helpers";
import { traceKyju } from "../trace";

const concatToCollection = (
  col: CollectionState,
  items: KyjuJSON[],
): CollectionState => {
  if (items.length === 0) return col;
  return {
    ...col,
    items: [...col.items, ...items],
    totalCount: col.totalCount + items.length,
  };
};

/**
 * Pure reducer: fold a single write op into a connected client state
 * snapshot. Used both for one-shot writes (`applyWrite`) and for batched
 * writes (`applyWriteBatch`), which fold N ops in a single `Ref.update`
 * so subscribers see one transition for the whole batch.
 */
const reduceWrite = (state: ConnectedState, op: WriteOp): ConnectedState => {
  switch (op.type) {
    case "root.set":
      return {
        ...state,
        root: setAtPath({ root: state.root, path: op.path, value: op.value }),
      };
    case "root.delete":
      return {
        ...state,
        root: deleteAtPath({ root: state.root, path: op.path }),
      };
    case "collection.create": {
      const collection: CollectionState = {
        id: op.collectionId,
        totalCount: op.data?.length ?? 0,
        items: op.data ?? [],
      };
      return { ...state, collections: [...state.collections, collection] };
    }
    case "collection.concat":
      return {
        ...state,
        collections: state.collections.map((col) =>
          col.id === op.collectionId
            ? concatToCollection(col, op.data)
            : col,
        ),
      };
    case "collection.delete":
      return {
        ...state,
        collections: state.collections.filter(
          (col) => col.id !== op.collectionId,
        ),
      };
    case "blob.create": {
      const blob: ClientBlob = {
        id: op.blobId,
        data: op.hot
          ? { kind: "hot", value: op.data }
          : { kind: "cold" },
        fileSize: 0,
        ...(op.contentType !== undefined && { contentType: op.contentType }),
      };
      return { ...state, blobs: [...state.blobs, blob] };
    }
    case "blob.set":
      return {
        ...state,
        blobs: state.blobs.map((blob) => {
          if (blob.id !== op.blobId) return blob;
          if (blob.data.kind === "hot") {
            return {
              ...blob,
              data: { kind: "hot" as const, value: op.data },
            };
          }
          return blob;
        }),
      };
    case "blob.delete":
      return {
        ...state,
        blobs: state.blobs.filter((blob) => blob.id !== op.blobId),
      };
  }
  op satisfies never;
  return state;
};

const applyWrite = ({
  stateRef,
  op,
}: {
  stateRef: Ref.Ref<ClientState>;
  op: WriteOp;
}) =>
  applyState({
    ref: stateRef,
    fn: (state) => reduceWrite(state, op),
  });

/**
 * Apply a whole batch in a single `Ref.update`. Subscribers see exactly
 * one state transition for the batch, even though the wire-side replication
 * still ships one server event per op.
 */
const applyWriteBatch = ({
  stateRef,
  ops,
}: {
  stateRef: Ref.Ref<ClientState>;
  ops: WriteOp[];
}) =>
  applyState({
    ref: stateRef,
    fn: (state) => ops.reduce(reduceWrite, state),
  });

// Replicated writes (events arriving from the server / other replicas)
// go through the same reducer.
const applyReplicatedWrite = applyWrite;

export type CollectionConcatCallback = (data: {
  collectionId: string;
  newItems: KyjuJSON[];
  collection: CollectionState;
}) => void;

const createReplicaEffect = (
  replicaId: string,
  collectionCallbacks: Map<string, Set<CollectionConcatCallback>>,
) =>
  Effect.gen(function* () {
    const awaiter = makeRequestAwaiter();
    const stateRef = yield* ClientStateRef;
    const sendToServer = <T extends Ack<any, any>>(
      event: ServerEvent,
      requestId: string,
    ) =>
      Effect.gen(function* () {
        const { send } = yield* SendContext;
        const promise = awaiter.await<T>(requestId);
        send(event);
        return yield* Effect.promise(() => promise);
      });

    const mergeSubscribeAck = (ack: SubscribeAck, collectionId: string) =>
      applyState({
        ref: stateRef,
        fn: (state) => {
          const entry: CollectionState = {
            id: collectionId,
            totalCount: ack.totalCount,
            items: ack.items,
          };
          const exists = state.collections.some((col) => col.id === collectionId);
          return {
            ...state,
            collections: exists
              ? state.collections.map((col) =>
                  col.id === collectionId ? entry : col,
                )
              : [...state.collections, entry],
          };
        },
      });

    const notifyConcatCallbacks = (op: WriteOp) =>
      Effect.gen(function* () {
        if (op.type !== "collection.concat") return;
        const cbs = collectionCallbacks.get(op.collectionId);
        if (!cbs || cbs.size === 0) return;
        const currentState = yield* Ref.get(stateRef);
        if (currentState.kind !== "connected") return;
        const col = currentState.collections.find(
          (c) => c.id === op.collectionId,
        );
        if (!col) return;
        for (const cb of cbs) {
          cb({
            collectionId: op.collectionId,
            newItems: op.data,
            collection: col,
          });
        }
      });

    const postMessage = (event: ClientEvent) =>
      Effect.gen(function* () {
        switch (event.kind) {
          case "connect": {
            const requestId = nanoid();
            const ack = yield* sendToServer<ConnectAck>(
              {
                kind: "connect",
                message: {
                  type: "connect",
                  version: event.version,
                  requestId,
                  replicaId,
                },
              },
              requestId,
            );
            if (ack.error) return yield* Effect.fail(ack.error);

            yield* Ref.set(stateRef, {
              kind: "connected" as const,
              sessionId: ack.sessionId,
              root: ack.root,
              collections: [],
              blobs: [],
            });
            return;
          }

          case "disconnect": {
            const state = yield* requireConnected({ ref: stateRef });
            const requestId = nanoid();
            const ack = yield* sendToServer<Ack<any, any>>(
              {
                kind: "disconnect",
                replicaId,
                message: {
                  type: "disconnect",
                  sessionId: state.sessionId,
                  requestId,
                },
              },
              requestId,
            );
            if (ack.error) return yield* Effect.fail(ack.error);

            yield* Ref.set(stateRef, { kind: "disconnected" as const });
            return;
          }

          case "subscribe-collection": {
            const state = yield* requireConnected({ ref: stateRef });
            const requestId = nanoid();
            const ack = yield* sendToServer<SubscribeAck>(
              {
                kind: "subscribe-collection",
                collectionId: event.collectionId,
                sessionId: state.sessionId,
                requestId,
                replicaId,
              },
              requestId,
            );
            if (ack.error) return yield* Effect.fail(ack.error);

            yield* mergeSubscribeAck(ack, event.collectionId);
            return;
          }

          case "unsubscribe-collection": {
            const state = yield* requireConnected({ ref: stateRef });
            const requestId = nanoid();
            yield* sendToServer<Ack<any, any>>(
              {
                kind: "unsubscribe-collection",
                collectionId: event.collectionId,
                sessionId: state.sessionId,
                requestId,
                replicaId,
              },
              requestId,
            );

            yield* applyState({
              ref: stateRef,
              fn: (s) => ({
                ...s,
                collections: s.collections.filter(
                  (col) => col.id !== event.collectionId,
                ),
              }),
            });
            return;
          }

          case "write": {
            const state = yield* requireConnected({ ref: stateRef });
            yield* traceKyju(
              "kyju:replica.applyWrite",
              applyWrite({ stateRef, op: event.op }),
              { op: event.op.type },
            );
            yield* notifyConcatCallbacks(event.op);
            const writeRequestId = nanoid();
            const writeAck = yield* traceKyju(
              "kyju:replica.sendToServer",
              sendToServer<Ack>(
                {
                  kind: "write",
                  op: event.op,
                  sessionId: state.sessionId,
                  requestId: writeRequestId,
                  replicaId,
                },
                writeRequestId,
              ),
              { op: event.op.type },
            );
            if (writeAck.error) return yield* Effect.fail(writeAck.error);
            return;
          }

          case "write-batch": {
            const state = yield* requireConnected({ ref: stateRef });
            if (event.ops.length === 0) return;

            // ONE Ref.update for the whole batch — subscribers see one
            // transition for the entire `client.update(fn)` call, so
            // renderers can't paint partially-applied intermediate states.
            yield* traceKyju(
              "kyju:replica.applyWriteBatch",
              applyWriteBatch({ stateRef, ops: event.ops }),
              { count: event.ops.length },
            );

            // Concat callbacks (used by collection subscribers) are
            // observed once per concat op, in batch order.
            for (const op of event.ops) {
              yield* notifyConcatCallbacks(op);
            }

            // Replicate to server op-by-op so the wire protocol stays
            // unchanged. If an ack errors we surface it; earlier ops in
            // the batch are already applied locally — same loss-of-atomicity
            // contract as the single-op `kind: "write"` path on failure.
            for (const op of event.ops) {
              const writeRequestId = nanoid();
              const writeAck = yield* traceKyju(
                "kyju:replica.sendToServer",
                sendToServer<Ack>(
                  {
                    kind: "write",
                    op,
                    sessionId: state.sessionId,
                    requestId: writeRequestId,
                    replicaId,
                  },
                  writeRequestId,
                ),
                { op: op.type },
              );
              if (writeAck.error) return yield* Effect.fail(writeAck.error);
            }
            return;
          }

          case "replicated-write": {
            yield* requireConnected({ ref: stateRef });
            yield* applyReplicatedWrite({ stateRef, op: event.op });
            yield* notifyConcatCallbacks(event.op);
            return;
          }

          case "read": {
            const readState = yield* requireConnected({ ref: stateRef });
            const readRequestId = nanoid();
            const readOp = event.op;

            switch (readOp.type) {
              case "collection.fetch-range": {
                yield* sendToServer<CollectionFetchRangeAck>(
                  {
                    kind: "read",
                    op: readOp,
                    sessionId: readState.sessionId,
                    requestId: readRequestId,
                    replicaId,
                  },
                  readRequestId,
                );
                return;
              }

              case "blob.read": {
                const ack = yield* sendToServer<BlobReadAck>(
                  {
                    kind: "read",
                    op: readOp,
                    sessionId: readState.sessionId,
                    requestId: readRequestId,
                    replicaId,
                  },
                  readRequestId,
                );
                if (ack.error) return yield* Effect.fail(ack.error);

                yield* applyState({
                  ref: stateRef,
                  fn: (state) => {
                    const entry: ClientBlob = {
                      id: readOp.blobId,
                      data: { kind: "hot" as const, value: ack.data },
                      fileSize: 0,
                    };
                    const exists = state.blobs.some(
                      (b) => b.id === readOp.blobId,
                    );
                    return {
                      ...state,
                      blobs: exists
                        ? state.blobs.map((b) =>
                            b.id === readOp.blobId ? entry : b,
                          )
                        : [...state.blobs, entry],
                    };
                  },
                });
                return;
              }
            }
            readOp satisfies never;
          }

          case "db-update": {
            const msg = event.message;

            if (msg.type === "ack") {
              awaiter.resolve(msg);
              return;
            }

            yield* requireConnected({ ref: stateRef });

            switch (msg.type) {
              case "blob.metadataUpdate": {
                yield* applyState({
                  ref: stateRef,
                  fn: (state) => ({
                    ...state,
                    blobs: state.blobs.map((blob) =>
                      blob.id === msg.blobId
                        ? {
                            ...blob,
                            fileSize: msg.fileSize,
                            ...(msg.contentType !== undefined && { contentType: msg.contentType }),
                          }
                        : blob,
                    ),
                  }),
                });
                return;
              }

              case "reconnect": {
                const reconState = yield* requireConnected({ ref: stateRef });
                const disconnectId = nanoid();
                const disconnectAck = yield* sendToServer<Ack<any, any>>(
                  {
                    kind: "disconnect",
                    replicaId,
                    message: {
                      type: "disconnect",
                      sessionId: reconState.sessionId,
                      requestId: disconnectId,
                    },
                  },
                  disconnectId,
                );
                if (disconnectAck.error)
                  return yield* Effect.fail(disconnectAck.error);

                yield* Ref.set(stateRef, { kind: "disconnected" as const });

                const connectId = nanoid();
                const connectAck = yield* sendToServer<ConnectAck>(
                  {
                    kind: "connect",
                    message: {
                      type: "connect",
                      version: VERSION,
                      requestId: connectId,
                      replicaId,
                    },
                  },
                  connectId,
                );
                if (connectAck.error)
                  return yield* Effect.fail(connectAck.error);

                yield* Ref.set(stateRef, {
                  kind: "connected" as const,
                  sessionId: connectAck.sessionId,
                  root: connectAck.root,
                  collections: [],
                  blobs: [],
                });
                return;
              }
            }
            msg satisfies never;
          }
        }
        event satisfies never;
      });

    return { postMessage };
  });

export type CreateReplicaArgs = {
  send: (event: ServerEvent) => void;
  maxPageSizeBytes: number;
  replicaId?: string;
};

export const createReplica = (args: CreateReplicaArgs) => {
  const replicaId = args.replicaId ?? nanoid();
  const stateRef = Effect.runSync(
    SubscriptionRef.make<ClientState>({ kind: "disconnected" }),
  );
  const collectionCallbacks = new Map<string, Set<CollectionConcatCallback>>();

  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(SendContext, { send: args.send }),
      Effect.provideService(ClientStateRef, stateRef),
      Effect.provideService(MaxPageSizeContext, {
        maxPageSizeBytes: args.maxPageSizeBytes,
      }),
    );

  const { postMessage: rawPostMessageEffect } = Effect.runSync(
    provide(createReplicaEffect(replicaId, collectionCallbacks)),
  );

  const postMessageEffect = (event: ClientEvent) =>
    provide(rawPostMessageEffect(event));

  const postMessage = (event: ClientEvent): Promise<void> =>
    Effect.runPromise(postMessageEffect(event).pipe(Effect.catchAll(() => Effect.void)));

  const onCollectionConcat = (collectionId: string, cb: CollectionConcatCallback) => {
    let cbs = collectionCallbacks.get(collectionId);
    if (!cbs) {
      cbs = new Set();
      collectionCallbacks.set(collectionId, cbs);
    }
    cbs.add(cb);
  };

  const offCollectionConcat = (collectionId: string, cb: CollectionConcatCallback) => {
    const cbs = collectionCallbacks.get(collectionId);
    if (cbs) {
      cbs.delete(cb);
      if (cbs.size === 0) collectionCallbacks.delete(collectionId);
    }
  };

  const getState = (): ClientState => Effect.runSync(Ref.get(stateRef));

  const _forceState = (state: ClientState) => {
    Effect.runSync(Ref.set(stateRef, state));
  };

  // One shared listener set + one long-lived fiber draining
  // `stateRef.changes`, instead of forking a fiber per subscriber. Every
  // reactive read (`useDb`, `useCollection`, `client.*.subscribe`) routes
  // through here; a fiber-per-subscriber meant O(subscribers) scheduler
  // overhead per write plus async teardown that leaked under mount churn.
  const listeners = new Set<(state: ClientState) => void>();
  Effect.runFork(
    Stream.runForEach(stateRef.changes, (state) =>
      // Snapshot the set so a listener that (un)subscribes mid-notify
      // can't perturb the iteration, and isolate listener throws.
      Effect.sync(() => {
        for (const l of Array.from(listeners)) {
          try {
            l(state);
          } catch {}
        }
      }),
    ),
  );

  const subscribe = (cb: (state: ClientState) => void): (() => void) => {
    listeners.add(cb);
    // Replay the current value once — mirrors `SubscriptionRef.changes`'
    // emit-current-then-changes contract that lazy-init callers rely on.
    cb(Effect.runSync(Ref.get(stateRef)));
    return () => {
      listeners.delete(cb);
    };
  };

  return { postMessage, postMessageEffect, getState, _forceState, subscribe, replicaId, onCollectionConcat, offCollectionConcat };
};

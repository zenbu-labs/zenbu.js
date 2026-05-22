import * as Context from "effect/Context";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
export const VERSION = 0;

export type KyjuJSON =
  | string
  | number
  | boolean
  | null
  | KyjuJSON[]
  | { [key: string]: KyjuJSON };

export type InvalidSessionError = {
  readonly _tag: "InvalidSessionError";
  readonly message: string;
};

export type VersionMismatchError = {
  readonly _tag: "VersionMismatchError";
  readonly message: string;
};

export type NotFoundError = {
  readonly _tag: "NotFoundError";
  readonly message: string;
};

export type ReferenceExistsError = {
  readonly _tag: "ReferenceExistsError";
  readonly message: string;
};

export type WriteFailedError = {
  readonly _tag: "WriteFailedError";
  readonly message: string;
};

export type KyjuError =
  | InvalidSessionError
  | VersionMismatchError
  | NotFoundError
  | ReferenceExistsError
  | WriteFailedError;

export type ErrorTag = KyjuError["_tag"];

export type Ack<T extends {} = {}, E extends ErrorTag = never> = {
  type: "ack";
  requestId: string;
  sessionId: string;
  error?: Extract<KyjuError, { _tag: E }>;
} & T;

export type RootSetOp = {
  type: "root.set";
  path: string[];
  value: KyjuJSON;
};

export type CollectionCreateOp = {
  type: "collection.create";
  collectionId: string;
  data?: KyjuJSON[];
};

export type CollectionConcatOp = {
  type: "collection.concat";
  collectionId: string;
  data: KyjuJSON[];
  authority?: { startIndex: number; totalCount: number };
};

export type CollectionDeleteOp = {
  type: "collection.delete";
  collectionId: string;
};

export type BlobCreateOp = {
  type: "blob.create";
  blobId: string;
  data: Uint8Array;
  hot?: boolean;
};

export type BlobSetOp = {
  type: "blob.set";
  blobId: string;
  data: Uint8Array;
};

export type BlobDeleteOp = {
  type: "blob.delete";
  blobId: string;
};

export type WriteOp =
  | RootSetOp
  | CollectionCreateOp
  | CollectionConcatOp
  | CollectionDeleteOp
  | BlobCreateOp
  | BlobSetOp
  | BlobDeleteOp;

export type CollectionFetchRangeOp = {
  type: "collection.fetch-range";
  collectionId: string;
  range: { start: number; end: number };
};

export type BlobReadOp = {
  type: "blob.read";
  blobId: string;
};

export type ReadOp = CollectionFetchRangeOp | BlobReadOp;

export type BlobMetadataUpdate = {
  type: "blob.metadataUpdate";
  blobId: string;
  fileSize: number;
};

export type ReconnectUpdate = {
  type: "reconnect";
};

export type DbUpdateMessage =
  | Ack
  | BlobMetadataUpdate
  | ReconnectUpdate;

export type ConnectAck = Ack<{ root: KyjuJSON }, "VersionMismatchError">;
export type CollectionFetchRangeAck = Ack<
  { items: KyjuJSON[]; totalCount: number },
  "NotFoundError"
>;
export type SubscribeAck = Ack<
  { items: KyjuJSON[]; totalCount: number },
  "NotFoundError"
>;
export type BlobReadAck = Ack<{ data: Uint8Array }, "NotFoundError">;

export type ClientEvent =
  | { kind: "connect"; version: number }
  | { kind: "disconnect" }
  | { kind: "subscribe-collection"; collectionId: string }
  | { kind: "unsubscribe-collection"; collectionId: string }
  | { kind: "write"; op: WriteOp }
  /**
   * Apply multiple write ops as a single local transition: subscribers
   * see one state change for the whole batch, not one per op. The wire
   * protocol is unchanged — ops still ship to the server as individual
   * `kind: "write"` events.
   */
  | { kind: "write-batch"; ops: WriteOp[] }
  | { kind: "replicated-write"; op: WriteOp }
  | { kind: "read"; op: ReadOp }
  | { kind: "db-update"; message: DbUpdateMessage };

export type DbSendEvent = ClientEvent & { replicaId: string };

export type ServerEvent =
  | {
      kind: "connect";
      message: {
        type: "connect";
        version: number;
        requestId: string;
        replicaId: string;
      };
    }
  | {
      kind: "disconnect";
      message: { type: "disconnect"; sessionId: string; requestId: string };
      replicaId: string;
    }
  | {
      kind: "subscribe-collection";
      collectionId: string;
      sessionId: string;
      requestId: string;
      replicaId: string;
    }
  | {
      kind: "unsubscribe-collection";
      collectionId: string;
      sessionId: string;
      requestId: string;
      replicaId: string;
    }
  | {
      kind: "write";
      op: WriteOp;
      sessionId: string;
      requestId: string;
      replicaId: string;
    }
  | {
      kind: "read";
      op: ReadOp;
      sessionId: string;
      requestId: string;
      replicaId: string;
    };

/**
 * Replica-side collection state. The replica holds the full item set;
 * paging is an internal storage concern of the database.
 */
export type CollectionState = {
  id: string;
  totalCount: number;
  items: KyjuJSON[];
};

export type BlobData = { kind: "hot"; value: Uint8Array } | { kind: "cold" };

export type ClientBlob = {
  id: string;
  data: BlobData;
  fileSize: number;
};

export type ClientState =
  | {
      kind: "connected";
      sessionId: string;
      root: KyjuJSON;
      collections: CollectionState[];
      blobs: ClientBlob[];
    }
  | { kind: "disconnected" };

export const SendContext = Context.GenericTag<{
  send: (event: ServerEvent) => void;
}>("SendContext");

export const ClientStateRef =
  Context.GenericTag<SubscriptionRef.SubscriptionRef<ClientState>>("ClientStateRef");

export const MaxPageSizeContext = Context.GenericTag<{
  maxPageSizeBytes: number;
}>("MaxPageSizeContext");

/** @deprecated Use CollectionState */
export type CollectionWindow = CollectionState;
/** @deprecated Use CollectionState */
export type ClientCollection = CollectionState;

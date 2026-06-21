import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { nanoid } from "nanoid";
import type { ServerEvent } from "../../shared";
import {
  type CollectionIndex,
  type PageIndex,
  type BlobIndex,
  broadcastCollectionWrite,
  broadcastDbUpdate,
  broadcastWrite,
  createBlob,
  createCollection,
  deleteAtPath,
  makeAck,
  makeErrorAck,
  paths,
  readJsonFile,
  sendAck,
  setAtPath,
  writeJsonFile,
} from "../helpers";
import { type DbHandlerContext, validateSession } from "../helpers";
import { traceKyju, traceKyjuSync } from "../../trace";

type WriteEvent = Extract<ServerEvent, { kind: "write" }>;

export const handleWrite = (ctx: DbHandlerContext, event: WriteEvent) =>
  traceKyju(
    `kyju:db.handleWrite`,
    handleWriteImpl(ctx, event),
    { op: event.op.type },
  );

const handleWriteImpl = (ctx: DbHandlerContext, event: WriteEvent) =>
  Effect.gen(function* () {
    const session = yield* validateSession(ctx, event.sessionId, event.requestId, event.replicaId);

    switch (event.op.type) {
      case "root.set": {
        const typedOp = event.op;

        // Defensive instrumentation: anything beyond a couple dozen
        // segments is almost certainly a bug in the caller (e.g. a
        // recording proxy walking a cyclic/non-plain object). Log
        // enough context to identify the culprit before we attempt
        // the write.
        if (typedOp.path.length > 64) {
          let valuePreview = "<unserializable>";
          try {
            const s = JSON.stringify(typedOp.value);
            valuePreview = s == null ? String(typedOp.value) : s.slice(0, 200);
          } catch (e) {
            valuePreview = `<unserializable: ${(e as Error).message}>`;
          }
          // eslint-disable-next-line no-console
          console.error("[kyju] suspicious root.set path", {
            length: typedOp.path.length,
            head: typedOp.path.slice(0, 10),
            tail: typedOp.path.slice(-10),
            valueType: typeof typedOp.value,
            valuePreview,
            sessionId: event.sessionId,
            requestId: event.requestId,
          });
        }

        // Use Effect.exit so we catch both typed errors AND defects
        // (synchronous throws from setAtPath surface as defects).
        const writeExit = yield* Effect.exit(
          traceKyju(
            "kyju:db.root.mutex+cache",
            ctx.rootMutex.withPermits(1)(
              Effect.gen(function* () {
                const root = yield* ctx.rootCache.read();
                const updated = yield* Effect.try({
                  try: () =>
                    setAtPath({
                      root,
                      path: typedOp.path,
                      value: typedOp.value,
                    }),
                  catch: (e) =>
                    e instanceof Error ? e : new Error(String(e)),
                });
                yield* ctx.rootCache.set(updated);
              }),
            ),
          ),
        );

        if (writeExit._tag === "Failure") {
          const cause = writeExit.cause;
          const message = (() => {
            // Cause may be a Fail (typed) or Die (defect). Both have
            // a useful string form.
            try {
              // @ts-ignore — runtime shape check
              if (cause && typeof cause === "object" && "defect" in cause) {
                const d = (cause as { defect: unknown }).defect;
                return d instanceof Error ? d.message : String(d);
              }
              // @ts-ignore — runtime shape check
              if (cause && typeof cause === "object" && "error" in cause) {
                const er = (cause as { error: unknown }).error;
                return er instanceof Error ? er.message : String(er);
              }
            } catch {}
            return String(cause);
          })();
          // eslint-disable-next-line no-console
          console.error("[kyju] root.set failed", {
            message,
            pathLength: typedOp.path.length,
            head: typedOp.path.slice(0, 10),
            tail: typedOp.path.slice(-10),
            sessionId: event.sessionId,
            requestId: event.requestId,
          });
          sendAck({
            session,
            ack: makeErrorAck({
              requestId: event.requestId,
              sessionId: event.sessionId,
              _tag: "WriteFailedError",
              message,
            }),
          });
          return;
        }

        sendAck({
          session,
          ack: makeAck({
            requestId: event.requestId,
            sessionId: event.sessionId,
          }),
        });

        const sessions = yield* Ref.get(ctx.sessionsRef);
        traceKyjuSync("kyju:db.root.broadcast", () =>
          broadcastWrite({
            sessions,
            excludeSessionId: event.sessionId,
            op: event.op,
          }),
        );
        return;
      }

      case "root.delete": {
        // Mirror image of `root.set`: walk the canonical root under
        // the mutex, unset the leaf at `path`, persist, broadcast.
        // Empty path is a no-op (caller would have meant
        // "clear the root", which they should express as a
        // `root.set` to `{}`/`[]`).
        const typedOp = event.op;
        if (typedOp.path.length === 0) {
          sendAck({
            session,
            ack: makeAck({
              requestId: event.requestId,
              sessionId: event.sessionId,
            }),
          });
          return;
        }

        const writeExit = yield* Effect.exit(
          traceKyju(
            "kyju:db.root.mutex+cache",
            ctx.rootMutex.withPermits(1)(
              Effect.gen(function* () {
                const root = yield* ctx.rootCache.read();
                const updated = yield* Effect.try({
                  try: () =>
                    deleteAtPath({
                      root,
                      path: typedOp.path,
                    }),
                  catch: (e) =>
                    e instanceof Error ? e : new Error(String(e)),
                });
                yield* ctx.rootCache.set(updated);
              }),
            ),
          ),
        );

        if (writeExit._tag === "Failure") {
          const cause = writeExit.cause;
          const message = (() => {
            try {
              // @ts-ignore — runtime shape check
              if (cause && typeof cause === "object" && "defect" in cause) {
                const d = (cause as { defect: unknown }).defect;
                return d instanceof Error ? d.message : String(d);
              }
              // @ts-ignore — runtime shape check
              if (cause && typeof cause === "object" && "error" in cause) {
                const er = (cause as { error: unknown }).error;
                return er instanceof Error ? er.message : String(er);
              }
            } catch {}
            return String(cause);
          })();
          // eslint-disable-next-line no-console
          console.error("[kyju] root.delete failed", {
            message,
            path: typedOp.path,
            sessionId: event.sessionId,
            requestId: event.requestId,
          });
          sendAck({
            session,
            ack: makeErrorAck({
              requestId: event.requestId,
              sessionId: event.sessionId,
              _tag: "WriteFailedError",
              message,
            }),
          });
          return;
        }

        sendAck({
          session,
          ack: makeAck({
            requestId: event.requestId,
            sessionId: event.sessionId,
          }),
        });

        const sessions = yield* Ref.get(ctx.sessionsRef);
        traceKyjuSync("kyju:db.root.broadcast", () =>
          broadcastWrite({
            sessions,
            excludeSessionId: event.sessionId,
            op: event.op,
          }),
        );
        return;
      }

      case "collection.create": {
        yield* createCollection({
          fs: ctx.fs,
          config: ctx.config,
          collectionId: event.op.collectionId,
          data: event.op.data,
        });

        sendAck({
          session,
          ack: makeAck({
            requestId: event.requestId,
            sessionId: event.sessionId,
          }),
        });

        const sessions = yield* Ref.get(ctx.sessionsRef);
        broadcastCollectionWrite({
          sessions,
          excludeSessionId: event.sessionId,
          collectionId: event.op.collectionId,
          op: event.op,
        });
        return;
      }

      case "collection.concat": {
        const typedOp = event.op;
        yield* ctx.collectionMutex.withPermits(1)(
          Effect.gen(function* () {
            if (typedOp.data.length === 0) {
              sendAck({
                session,
                ack: makeAck({
                  requestId: event.requestId,
                  sessionId: event.sessionId,
                }),
              });
              return;
            }

            const collectionDir = paths.collection({
              config: ctx.config,
              collectionId: typedOp.collectionId,
            });
            const collectionExists = yield* ctx.fs.exists(collectionDir);
            if (!collectionExists) {
              yield* createCollection({
                fs: ctx.fs,
                config: ctx.config,
                collectionId: typedOp.collectionId,
              });
            }

            const collectionIndexPath = paths.collectionIndex({
              config: ctx.config,
              collectionId: typedOp.collectionId,
            });
            const collectionIndex = JSON.parse(
              yield* ctx.fs.readFileString(collectionIndexPath),
            ) as CollectionIndex;
            let activePageId = collectionIndex.activePageId;

            const activeDataPath = paths.pageData({
              config: ctx.config,
              collectionId: typedOp.collectionId,
              pageId: activePageId,
            });
            const stats = yield* ctx.fs.stat(activeDataPath);
            const currentSize = Number(stats.size);

            const jsonlContent =
              typedOp.data
                .map((item) => JSON.stringify(item))
                .join("\n") + "\n";

            if (currentSize >= ctx.config.maxPageSize) {
              const newPageId = nanoid();
              yield* ctx.fs.makeDirectory(
                paths.page({
                  config: ctx.config,
                  collectionId: typedOp.collectionId,
                  pageId: newPageId,
                }),
                { recursive: true },
              );

              const pIndex: PageIndex = {
                pageId: newPageId,
                order: collectionIndex.totalPages,
              };
              yield* Effect.all([
                writeJsonFile({
                  fs: ctx.fs,
                  config: ctx.config,
                  path: paths.pageIndex({
                    config: ctx.config,
                    collectionId: typedOp.collectionId,
                    pageId: newPageId,
                  }),
                  data: pIndex,
                }),
                ctx.fs.writeFileString(
                  paths.pageData({
                    config: ctx.config,
                    collectionId: typedOp.collectionId,
                    pageId: newPageId,
                  }),
                  jsonlContent,
                ),
              ]);

              collectionIndex.activePageId = newPageId;
              collectionIndex.totalPages += 1;
              activePageId = newPageId;
            } else {
              yield* Effect.scoped(
                Effect.gen(function* () {
                  const file = yield* ctx.fs.open(activeDataPath, { flag: "a" });
                  yield* file.write(new TextEncoder().encode(jsonlContent));
                }),
              );
            }

            const startIndex = collectionIndex.totalCount;
            collectionIndex.totalCount += typedOp.data.length;
            yield* writeJsonFile({
              fs: ctx.fs,
              config: ctx.config,
              path: collectionIndexPath,
              data: collectionIndex,
            });

            const newStats = yield* ctx.fs.stat(
              paths.pageData({
                config: ctx.config,
                collectionId: typedOp.collectionId,
                pageId: activePageId,
              }),
            );
            const newFileSize = Number(newStats.size);

            sendAck({
              session,
              ack: makeAck({
                requestId: event.requestId,
                sessionId: event.sessionId,
              }),
            });

            const sessions = yield* Ref.get(ctx.sessionsRef);
            broadcastCollectionWrite({
              sessions,
              excludeSessionId: event.sessionId,
              collectionId: typedOp.collectionId,
              op: {
                ...typedOp,
                authority: {
                  startIndex,
                  totalCount: collectionIndex.totalCount,
                },
              },
            });
          }),
        );
        return;
      }

      case "collection.delete": {
        const typedOp = event.op;
        yield* ctx.collectionMutex.withPermits(1)(
          Effect.gen(function* () {
            const collectionDir = paths.collection({
              config: ctx.config,
              collectionId: typedOp.collectionId,
            });
            const exists = yield* ctx.fs.exists(collectionDir);
            if (!exists) {
              sendAck({
                session,
                ack: makeErrorAck({
                  requestId: event.requestId,
                  sessionId: event.sessionId,
                  _tag: "NotFoundError",
                  message: `Collection ${typedOp.collectionId} not found`,
                }),
              });
              return;
            }

            if (ctx.config.checkReferences) {
              // Read from the in-memory cache, not disk: any in-flight writes
              // that haven't flushed yet must still count as live references.
              const root = yield* ctx.rootCache.read();
              const hasRef = JSON.stringify(root).includes(typedOp.collectionId);
              if (hasRef) {
                sendAck({
                  session,
                  ack: makeErrorAck({
                    requestId: event.requestId,
                    sessionId: event.sessionId,
                    _tag: "ReferenceExistsError",
                    message: `Collection ${typedOp.collectionId} still has references`,
                  }),
                });
                return;
              }
            }

            yield* ctx.fs.remove(collectionDir, { recursive: true });

            sendAck({
              session,
              ack: makeAck({
                requestId: event.requestId,
                sessionId: event.sessionId,
              }),
            });

            const sessions = yield* Ref.get(ctx.sessionsRef);
            broadcastCollectionWrite({
              sessions,
              excludeSessionId: event.sessionId,
              collectionId: typedOp.collectionId,
              op: event.op,
            });

            for (const [, s] of sessions) {
              s.subscriptions.delete(typedOp.collectionId);
            }
          }),
        );
        return;
      }

      case "blob.create": {
        const blobIndex = yield* createBlob({
          fs: ctx.fs,
          config: ctx.config,
          blobId: event.op.blobId,
          data: event.op.data,
          contentType: event.op.contentType,
        });

        sendAck({
          session,
          ack: makeAck({
            requestId: event.requestId,
            sessionId: event.sessionId,
          }),
        });

        const sessions = yield* Ref.get(ctx.sessionsRef);
        broadcastWrite({
          sessions,
          excludeSessionId: event.sessionId,
          op: event.op,
        });

        broadcastDbUpdate({
          sessions,
          message: {
            type: "blob.metadataUpdate",
            blobId: event.op.blobId,
            fileSize: blobIndex.fileSize,
            ...(blobIndex.contentType !== undefined && { contentType: blobIndex.contentType }),
          },
        });
        return;
      }

      case "blob.set": {
        const typedOp = event.op;
        yield* ctx.blobMutex.withPermits(1)(
          Effect.gen(function* () {
            const exists = yield* ctx.fs.exists(
              paths.blob({ config: ctx.config, blobId: typedOp.blobId }),
            );
            if (!exists) {
              sendAck({
                session,
                ack: makeErrorAck({
                  requestId: event.requestId,
                  sessionId: event.sessionId,
                  _tag: "NotFoundError",
                  message: `Blob ${typedOp.blobId} not found`,
                }),
              });
              return;
            }

            const dataPath = paths.blobData({
              config: ctx.config,
              blobId: typedOp.blobId,
            });
            yield* ctx.fs.writeFile(dataPath, typedOp.data);
            const blobStats = yield* ctx.fs.stat(dataPath);

            const existingIdx = yield* readJsonFile({
              fs: ctx.fs,
              path: paths.blobIndex({ config: ctx.config, blobId: typedOp.blobId }),
            }).pipe(Effect.catchAll(() => Effect.succeed(null)));
            const existingContentType =
              existingIdx != null &&
              typeof existingIdx === "object" &&
              !Array.isArray(existingIdx) &&
              "contentType" in existingIdx
                ? (existingIdx.contentType as string | undefined)
                : undefined;

            const bIdx: BlobIndex = {
              blobId: typedOp.blobId,
              fileSize: Number(blobStats.size),
              ...(existingContentType !== undefined && { contentType: existingContentType }),
            };
            yield* writeJsonFile({
              fs: ctx.fs,
              config: ctx.config,
              path: paths.blobIndex({ config: ctx.config, blobId: typedOp.blobId }),
              data: bIdx,
            });

            sendAck({
              session,
              ack: makeAck({
                requestId: event.requestId,
                sessionId: event.sessionId,
              }),
            });

            const sessions = yield* Ref.get(ctx.sessionsRef);
            broadcastWrite({
              sessions,
              excludeSessionId: event.sessionId,
              op: typedOp,
            });

            broadcastDbUpdate({
              sessions,
              message: {
                type: "blob.metadataUpdate",
                blobId: typedOp.blobId,
                fileSize: Number(blobStats.size),
                ...(existingContentType !== undefined && { contentType: existingContentType }),
              },
            });
          }),
        );
        return;
      }

      case "blob.delete": {
        const typedOp = event.op;
        yield* ctx.blobMutex.withPermits(1)(
          Effect.gen(function* () {
            const blobDir = paths.blob({
              config: ctx.config,
              blobId: typedOp.blobId,
            });
            const exists = yield* ctx.fs.exists(blobDir);
            if (!exists) {
              sendAck({
                session,
                ack: makeErrorAck({
                  requestId: event.requestId,
                  sessionId: event.sessionId,
                  _tag: "NotFoundError",
                  message: `Blob ${typedOp.blobId} not found`,
                }),
              });
              return;
            }

            if (ctx.config.checkReferences) {
              // Read from the in-memory cache, not disk: see collection.delete.
              const root = yield* ctx.rootCache.read();
              const hasRef = JSON.stringify(root).includes(typedOp.blobId);
              if (hasRef) {
                sendAck({
                  session,
                  ack: makeErrorAck({
                    requestId: event.requestId,
                    sessionId: event.sessionId,
                    _tag: "ReferenceExistsError",
                    message: `Blob ${typedOp.blobId} still has references`,
                  }),
                });
                return;
              }
            }

            yield* ctx.fs.remove(blobDir, { recursive: true });

            sendAck({
              session,
              ack: makeAck({
                requestId: event.requestId,
                sessionId: event.sessionId,
              }),
            });

            const sessions = yield* Ref.get(ctx.sessionsRef);
            broadcastWrite({
              sessions,
              excludeSessionId: event.sessionId,
              op: event.op,
            });
          }),
        );
        return;
      }
    }
  });

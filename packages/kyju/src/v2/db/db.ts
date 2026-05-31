import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as FileSystem from "@effect/platform/FileSystem";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { nanoid } from "nanoid";
import nodeFs from "node:fs";
import nodeOs from "node:os";
import nodePath from "node:path";
import type { DbSendEvent, KyjuJSON, ServerEvent } from "../shared";
import {
  type DbConfig,
  type Session,
  broadcastDbUpdate,
  cleanupStaleTmpFiles,
  createBlob,
  createCollection,
  paths,
  writeJsonFile,
} from "./helpers";
import { makeRootCache } from "./root-cache";
import { traceKyju } from "../trace";
import type { Schema, SchemaShape } from "./schema";
import { getZodDefault } from "./schema";
import type { KyjuMigration, SectionConfig } from "../migrations";
import type { DbHandlerContext } from "./helpers";
import { handleConnect } from "./handlers/connect";
import { handleDisconnect } from "./handlers/disconnect";
import { handleSubscribe } from "./handlers/subscribe";
import { handleUnsubscribe } from "./handlers/unsubscribe";
import { handleWrite } from "./handlers/write";
import { handleRead } from "./handlers/read";
import { runPlugins } from "./handlers/plugins";
import {
  createClient,
  createEffectClient,
  type ClientProxy,
  type EffectClientProxy,
} from "../client/client";
import {
  migrationPlugin,
  sectionMigrationPlugin,
  runSectionMigrations,
} from "../core-plugins/migration";

export type { DbPlugin, PluginContext } from "./handlers/plugins";
export type { DbHandlerContext } from "./helpers";
export type { SectionConfig } from "../migrations";

import type { DbPlugin } from "./handlers/plugins";

export type CreateDbConfig<TShape extends SchemaShape = SchemaShape> = {
  path: string;
  send: (event: DbSendEvent) => void;
  maxPageSize?: number;
  checkReferences?: boolean;
  plugins?: DbPlugin[];
  schema?: Schema<TShape>;
  migrations?: KyjuMigration[];
  sections?: SectionConfig[];
};

export type Db<TShape extends SchemaShape = SchemaShape> = {
  postMessage: (event: ServerEvent) => Promise<void>;
  reconnectClients: () => Promise<void>;
  addSection: (section: SectionConfig) => Promise<void>;
  removeSection: (
    name: string,
    opts?: { deleteData?: boolean },
  ) => Promise<void>;
  /** Snapshot of currently-registered section names. */
  listSections: () => string[];
  /**
   * Drain the lagged-persistence queue: writes that were applied to the
   * in-memory root cache but not yet committed to disk. Idempotent and
   * cheap when nothing is pending. Call before clean shutdown to ensure
   * durability of any writes that completed during this process's lifetime.
   */
  flush: () => Promise<void>;
  /**
   * Flush + release the cross-process lock at `<dbPath>/.lock`. Idempotent;
   * safe to call from a `process.on("exit")` handler. After `close()`
   * resolves, another process can open the same `dbPath` without conflict.
   */
  close: () => Promise<void>;
  client: ClientProxy<TShape>;
  effectClient: EffectClientProxy<TShape>;
};

/**
 * Cross-process exclusion. We hold one writer per `dbPath`; if a second
 * process tries to open the same path while the first is alive, kyju
 * throws so the developer kills/quits the first instead of silently
 * losing data to a flush race. Kept deliberately simple — synchronous fs
 * because this runs once at boot and once at close, never on a hot path.
 */
type LockPayload = {
  pid: number;
  hostname: string;
  startedAt: string;
  /**
   * Random per-Db-instance token. Multiple Db instances in the same
   * process are allowed (re-entry) but only the one that wrote the
   * current `nonce` is permitted to release the lock — otherwise an
   * abandoned old Db's `close()` (or exit handler) would yank the file
   * out from under a newer instance that still depends on it.
   */
  nonce: string;
};

class DbLockedError extends Error {
  constructor(dbPath: string, holder: LockPayload) {
    super(
      `Database at ${dbPath} is locked by pid ${holder.pid} on host ${holder.hostname} (started ${holder.startedAt}).\n` +
        `kyju refuses to open a second concurrent writer to avoid clobbering its flushes.\n` +
        `Quit the running process and try again, or remove ${nodePath.join(dbPath, ".lock")} if you're sure no process is using this DB.`,
    );
    this.name = "DbLockedError";
  }
}

function lockPath(dbPath: string): string {
  return nodePath.join(dbPath, ".lock");
}

function isPidAlive(pid: number): boolean {
  // Sending signal 0 doesn't actually deliver — it just probes for
  // existence. EPERM also implies the PID is alive (we just don't have
  // permission to signal it), which still means we shouldn't take over
  // the lock. ESRCH is the only "definitely dead" answer.
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readLock(dbPath: string): Promise<LockPayload | null> {
  try {
    const raw = await nodeFs.promises.readFile(lockPath(dbPath), "utf8");
    return JSON.parse(raw) as LockPayload;
  } catch {
    return null;
  }
}

async function acquireLock(dbPath: string): Promise<string> {
  await nodeFs.promises.mkdir(dbPath, { recursive: true });
  const existing = await readLock(dbPath);
  if (existing) {
    const sameHost = existing.hostname === nodeOs.hostname();
    const sameProcess = sameHost && existing.pid === process.pid;
    // Same-process re-entry is transparent. Real callers that hit this:
    //   - DbService.evaluate() running again because sectionsHash changed
    //     (it doesn't explicitly close the prior `this.db` reference).
    //   - Test suites that simulate "restart" by opening the same path
    //     twice within one node process.
    // The in-memory rootCache enforces single-writer-per-process anyway,
    // so the lock's job is purely cross-process exclusion.
    if (!sameProcess) {
      // Different host: can't probe the PID, conservatively treat as alive.
      // Different PID on same host: probe; only reclaim when ESRCH proves
      // the holder is dead.
      if (!sameHost || isPidAlive(existing.pid)) {
        throw new DbLockedError(dbPath, existing);
      }
      // Stale (dead PID on this host) — fall through and overwrite.
    }
  }
  const nonce = nanoid();
  const payload: LockPayload = {
    pid: process.pid,
    hostname: nodeOs.hostname(),
    startedAt: new Date().toISOString(),
    nonce,
  };
  await nodeFs.promises.writeFile(lockPath(dbPath), JSON.stringify(payload));
  return nonce;
}

async function releaseLock(dbPath: string, ourNonce: string): Promise<void> {
  // Only remove the lock if WE wrote it. Two Db instances may exist in
  // the same process at the same time (during a hot-reload re-init);
  // both write the same pid+hostname but different nonces. Without the
  // nonce check, the older instance's `close()` would unlink the lock
  // file the newer instance is still relying on.
  const current = await readLock(dbPath);
  if (!current || current.nonce !== ourNonce) return;
  try {
    await nodeFs.promises.unlink(lockPath(dbPath));
  } catch {
    // best-effort
  }
}

/**
 * Sync release for the `process.on("exit")` path. Async callbacks don't
 * run during process exit (the event loop is already torn down), so
 * we have no choice but to use sync fs here. Mirrors `releaseLock`'s
 * nonce check exactly.
 */
function releaseLockOnExit(dbPath: string, ourNonce: string): void {
  let current: LockPayload | null = null;
  try {
    current = JSON.parse(
      nodeFs.readFileSync(lockPath(dbPath), "utf8"),
    ) as LockPayload;
  } catch {
    return;
  }
  if (!current || current.nonce !== ourNonce) return;
  try {
    nodeFs.unlinkSync(lockPath(dbPath));
  } catch {
    // best-effort
  }
}

const DEFAULT_CONFIG: Omit<
  DbConfig,
  "dbPath" | "tmpDir" | "maxPageSize" | "checkReferences"
> = {
  rootName: "root",
  collectionsDirName: "collections",
  collectionIndexName: "index",
  pagesDirName: "pages",
  pageIndexName: "index",
  pageDataName: "data",
  blobsDirName: "blobs",
  blobIndexName: "index",
  blobDataName: "data",
};

const buildSchemaRoot = function* (
  fs: FileSystem.FileSystem,
  config: DbConfig,
  schema: Schema,
) {
  const root: Record<string, KyjuJSON> = {};

  for (const [key, entry] of Object.entries(schema.shape)) {
    // Field<T> wraps the actual schema in `.schema`; raw zod / BlobRef are the
    // entry itself. Either way `fieldSchema` is the thing we test markers on.
    const fieldSchema =
      entry && typeof entry === "object" && "schema" in entry
        ? (entry as { schema: unknown }).schema
        : entry;
    const fs_obj = fieldSchema as Record<string, unknown>;

    if (fs_obj.__kyjuCollectionRef) {
      const dn = fs_obj._debugName;
      root[key] = {
        collectionId: "",
        debugName: typeof dn === "string" ? dn : key,
      };
    } else if (
      fs_obj.type === "blob" ||
      (entry as Record<string, unknown>)?.type === "blob"
    ) {
      const blobId = nanoid();
      const debugName =
        (fs_obj.debugName as string | undefined) ??
        ((entry as Record<string, unknown>)?.debugName as string | undefined) ??
        key;
      root[key] = { blobId, debugName };
      yield* createBlob({ fs, config, blobId, data: new Uint8Array(0) });
    } else if ((entry as any)._hasDefault) {
      // Legacy `f.string().default(...)` Field wrapper.
      root[key] = (entry as any)._defaultValue as KyjuJSON;
    } else {
      // Raw zod schema — read default from `ZodDefault` if present.
      const def = getZodDefault(entry);
      if (def.hasDefault) root[key] = def.value as KyjuJSON;
    }
  }

  return root;
};

const finalizeAndWriteRoot = function* (
  fs: FileSystem.FileSystem,
  config: DbConfig,
  root: Record<string, KyjuJSON>,
) {
  const pendingCollections: Array<{ collectionId: string }> = [];
  const initNestedCollections = (obj: any): any => {
    if (obj == null || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(initNestedCollections);
    if (
      typeof obj.collectionId === "string" &&
      typeof obj.debugName === "string" &&
      !obj.collectionId
    ) {
      const collectionId = nanoid();
      pendingCollections.push({ collectionId });
      return { ...obj, collectionId };
    }
    const result: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = initNestedCollections(v);
    }
    return result;
  };

  const finalRoot = initNestedCollections(root);
  for (const { collectionId } of pendingCollections) {
    yield* createCollection({ fs, config, collectionId });
  }

  yield* writeJsonFile({
    fs,
    config,
    path: paths.root({ config }),
    data: finalRoot,
  });
};

const initializeDbIfNeeded = (
  fs: FileSystem.FileSystem,
  config: DbConfig,
  schema: Schema,
) =>
  Effect.gen(function* () {
    const rootPath = paths.root({ config });
    if (yield* fs.exists(rootPath)) return;
    yield* fs.makeDirectory(config.dbPath, { recursive: true });

    const root = yield* buildSchemaRoot(fs, config, schema);
    yield* finalizeAndWriteRoot(fs, config, root);
  });

const initializeSectionedDbIfNeeded = (
  fs: FileSystem.FileSystem,
  config: DbConfig,
  sections: SectionConfig[],
) =>
  Effect.gen(function* () {
    const rootPath = paths.root({ config });
    if (yield* fs.exists(rootPath)) return;
    yield* fs.makeDirectory(config.dbPath, { recursive: true });

    const sectionsData: Record<string, KyjuJSON> = {};
    for (const section of sections) {
      sectionsData[section.name] = yield* buildSchemaRoot(
        fs,
        config,
        section.schema,
      );
    }

    yield* finalizeAndWriteRoot(fs, config, sectionsData);
  });

const createDbEffect = <TShape extends SchemaShape>(
  userConfig: CreateDbConfig<TShape>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    const config: DbConfig = {
      ...DEFAULT_CONFIG,
      dbPath: userConfig.path,
      tmpDir: nodePath.join(userConfig.path, ".tmp"),
      maxPageSize: userConfig.maxPageSize ?? 1024 * 1024,
      checkReferences: userConfig.checkReferences ?? false,
    };

    // Acquire the writer lock before doing anything else. If a sibling
    // process owns this dbPath, throw immediately — every subsequent
    // step would be a flush race that silently loses one of the writers.
    const lockNonce = yield* Effect.tryPromise({
      try: () => acquireLock(config.dbPath),
      catch: (e) => e as Error,
    });

    // Ensure the dedicated tmp staging directory exists before anything else
    // can try to write. Every `writeJsonFile` stages through `config.tmpDir`
    // and then renames to its destination; the rename is only atomic when
    // both paths live on the same filesystem, which they do by construction
    // (both under `dbPath`).
    yield* fs.makeDirectory(config.tmpDir, { recursive: true });

    yield* traceKyju(
      "kyju:db.init.dir-setup",
      Effect.gen(function* () {
        if (userConfig.sections) {
          const names = userConfig.sections.map((s) => s.name);
          const dupes = names.filter((n, i) => names.indexOf(n) !== i);
          if (dupes.length > 0) {
            throw new Error(
              `Duplicate section names: ${[...new Set(dupes)].join(", ")}`,
            );
          }
          // Sections live at the top level of the root. `_plugins` is
          // kyju's own bookkeeping namespace (migration versions, etc.) so
          // a section can't be called that without clobbering it.
          const conflicts = names.filter((n) => n === "_plugins");
          if (conflicts.length > 0) {
            throw new Error(
              `Section names collide with reserved kyju keys: ${conflicts.join(", ")}`,
            );
          }
          yield* initializeSectionedDbIfNeeded(fs, config, userConfig.sections);
        } else if (userConfig.schema) {
          yield* initializeDbIfNeeded(fs, config, userConfig.schema);
        }
      }),
    );

    // Reclaim orphan tmp files from prior processes. Runs inline — it's a
    // single flat `readdir` on a directory that's empty in the common case,
    // so it costs nothing when there's nothing to clean. Safe because no
    // writer is active yet: every file currently in `tmpDir` is by
    // definition an orphan (successful writes were renamed away).
    yield* traceKyju(
      "kyju:db.init.tmp-cleanup",
      cleanupStaleTmpFiles(fs, config.tmpDir).pipe(
        Effect.catchAll((err) => {
          console.error("[kyju:db] tmp sweep failed (non-fatal):", err);
          return Effect.void;
        }),
      ),
    );

    const sessionsRef = yield* Ref.make(new Map<string, Session>());
    const rootMutex = yield* Effect.makeSemaphore(1);
    const collectionMutex = yield* Effect.makeSemaphore(1);
    const blobMutex = yield* Effect.makeSemaphore(1);
    const latch = yield* Effect.makeLatch(false);

    // Tracks which sections are currently registered. Populated at boot
    // from `userConfig.sections` and mutated by `addSection` /
    // `removeSection` at runtime. Read by `listSections` and used by
    // `addSection`'s idempotency check.
    const currentSections = yield* Ref.make(
      new Map<string, SectionConfig>(
        (userConfig.sections ?? []).map((s) => [s.name, s]),
      ),
    );

    // Hydrate the in-memory root cache from disk. Must run AFTER
    // `initializeDbIfNeeded` (which writes the initial root if missing) so
    // there's something to read; runs BEFORE `runPlugins` (which executes
    // migrations via client.update → handleWrite, which now reads/writes
    // through the cache).
    const rootCache = yield* traceKyju(
      "kyju:db.init.make-cache",
      makeRootCache(fs, config, rootMutex),
    );

    const ctx: DbHandlerContext = {
      fs,
      config,
      sessionsRef,
      rootMutex,
      collectionMutex,
      blobMutex,
      dbSend: userConfig.send,
      rootCache,
    };

    const postMessageEffect = (event: ServerEvent) =>
      Effect.gen(function* () {
        switch (event.kind) {
          case "connect":
            return yield* handleConnect(ctx, event, latch);
          case "disconnect":
            return yield* handleDisconnect(ctx, event);
          case "subscribe-collection":
            return yield* handleSubscribe(ctx, event);
          case "unsubscribe-collection":
            return yield* handleUnsubscribe(ctx, event);
          case "write":
            return yield* handleWrite(ctx, event);
          case "read":
            return yield* handleRead(ctx, event);
        }
      }).pipe(
        Effect.catchAll((err) => {
          console.error(
            "[kyju:db] unhandled error in postMessage handler:",
            err,
          );
          return Effect.void;
        }),
      );

    const reconnectClientsEffect = Effect.gen(function* () {
      const sessions = yield* Ref.get(sessionsRef);
      broadcastDbUpdate({
        sessions,
        message: { type: "reconnect" },
      });
    });

    let plugins: DbPlugin[];
    if (userConfig.sections) {
      plugins = [
        sectionMigrationPlugin(userConfig.sections),
        ...(userConfig.plugins ?? []),
      ];
    } else {
      plugins = [
        migrationPlugin(userConfig.migrations ?? []),
        ...(userConfig.plugins ?? []),
      ];
    }

    const localReplica = yield* traceKyju(
      "kyju:db.init.run-plugins",
      runPlugins(ctx, postMessageEffect, plugins),
    );
    yield* latch.open;

    // Migrations may have written to the root cache; drain to disk before
    // returning so the on-disk state reflects all pre-start work. If we
    // crashed between createDb resolving and the next flush, the next boot
    // would otherwise re-run migrations (since their effects live in cache).
    yield* traceKyju("kyju:db.init.final-flush", rootCache.flush());

    const client = createClient<TShape>(localReplica);
    const effectClient = createEffectClient<TShape>(localReplica);

    // -----------------------------------------------------------------
    //                  Runtime section add / remove
    // -----------------------------------------------------------------
    //
    // Concurrency model: addSection / removeSection serialize against
    // each other (one at a time per Db instance). Inside, each
    // sub-operation (schema init, individual migrations) goes through
    // `client.update` which acquires `rootMutex` per write — those are
    // the only writes that need to be atomic. We deliberately do NOT
    // hold rootMutex across the whole addSection because
    // `runSectionMigrations` itself issues many writes via
    // `client.update`, and holding the mutex outside would deadlock
    // each inner acquire.
    //
    // A simple promise-chain serializes section operations. Calls
    // queue behind the most recent in-flight op; same-name concurrent
    // calls thus naturally collapse to the idempotency check in turn.
    let sectionOpsChain: Promise<void> = Promise.resolve();
    const enqueueSectionOp = <T>(op: () => Promise<T>): Promise<T> => {
      const next = sectionOpsChain.then(op, op);
      sectionOpsChain = next.then(
        () => {},
        () => {},
      );
      return next;
    };

    const sectionsEqualByMigrations = (
      a: SectionConfig,
      b: SectionConfig,
    ): boolean => {
      if (a.migrations.length !== b.migrations.length) return false;
      for (let i = 0; i < a.migrations.length; i++) {
        if (
          (a.migrations[i] as { version?: unknown })?.version !==
          (b.migrations[i] as { version?: unknown })?.version
        ) {
          return false;
        }
      }
      return true;
    };

    /**
     * Initialize a section's slot in `root` from its schema. Uses the
     * same `buildSchemaRoot` + collection-bootstrap path the
     * construction-time initializer uses, then writes the result via
     * `client.update` so connected replicas observe a normal
     * `db-update` for the new top-level key.
     */
    const initSectionRootEffect = (section: SectionConfig) =>
      Effect.gen(function* () {
        const built = yield* buildSchemaRoot(fs, config, section.schema);
        // Walk the built object the same way `finalizeAndWriteRoot`
        // does so any nested collections get real ids + on-disk
        // bootstrap before we publish the section to clients.
        const pendingCollections: Array<{ collectionId: string }> = [];
        const initNestedCollections = (obj: any): any => {
          if (obj == null || typeof obj !== "object") return obj;
          if (Array.isArray(obj)) return obj.map(initNestedCollections);
          if (
            typeof obj.collectionId === "string" &&
            typeof obj.debugName === "string" &&
            !obj.collectionId
          ) {
            const collectionId = nanoid();
            pendingCollections.push({ collectionId });
            return { ...obj, collectionId };
          }
          const result: Record<string, any> = {};
          for (const [k, v] of Object.entries(obj)) {
            result[k] = initNestedCollections(v);
          }
          return result;
        };
        const finalBuilt = initNestedCollections(built);
        for (const { collectionId } of pendingCollections) {
          yield* createCollection({ fs, config, collectionId });
        }
        // Publish via the normal write path — client.update goes
        // through handleWrite, which acquires rootMutex internally
        // and broadcasts the change to every connected replica as
        // an ordinary `db-update` event. Replicas merge the new
        // top-level key into their local root with no special
        // protocol handling.
        yield* Effect.promise(() =>
          client.update((r: any) => {
            r[section.name] = finalBuilt;
          }),
        );
      });

    const addSectionEffect = (section: SectionConfig) =>
      Effect.gen(function* () {
        if (section.name === "_plugins") {
          throw new Error(
            `Section name "_plugins" is reserved by kyju (bookkeeping namespace).`,
          );
        }
        const current = yield* Ref.get(currentSections);
        const existing = current.get(section.name);
        if (existing) {
          if (sectionsEqualByMigrations(existing, section)) {
            // Idempotent no-op.
            return;
          }
          throw new Error(
            `Section "${section.name}" is already registered with different migrations. ` +
              `Call removeSection() first if you intend to replace it.`,
          );
        }

        // 1. Initialize the section's slot in root if it doesn't already
        //    exist. (It can already exist if the section was previously
        //    removed with `deleteData: false`, in which case data
        //    + migration bookkeeping should be preserved.)
        const rootSnapshot = yield* rootCache.read();
        const alreadyOnDisk =
          (rootSnapshot as Record<string, unknown>)[section.name] !== undefined;
        if (!alreadyOnDisk) {
          yield* initSectionRootEffect(section);
        }

        // 2. Run any pending migrations. Idempotent: if the section was
        //    already migrated to head (from a previous run that
        //    persisted bookkeeping), this returns immediately.
        yield* Effect.promise(() =>
          runSectionMigrations({
            section,
            client,
            pluginPath: ["_plugins", "sectionMigrator"],
          }),
        );

        // 3. Register in the in-memory section map.
        yield* Ref.update(currentSections, (m) =>
          new Map(m).set(section.name, section),
        );
      });

    const removeSectionEffect = (
      name: string,
      opts: { deleteData?: boolean } = {},
    ) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(currentSections);
        if (!current.has(name)) return; // unknown name — no-op

        if (opts.deleteData) {
          // Wipe both the section's data slot and its migration
          // bookkeeping so a future addSection re-runs from scratch.
          yield* Effect.promise(() =>
            client.update((r: any) => {
              delete r[name];
              if (
                r._plugins &&
                r._plugins.sectionMigrator &&
                r._plugins.sectionMigrator[name]
              ) {
                delete r._plugins.sectionMigrator[name];
              }
            }),
          );
        }
        // Always drop from the in-memory registry.
        yield* Ref.update(currentSections, (m) => {
          const next = new Map(m);
          next.delete(name);
          return next;
        });
      });

    // Best-effort lock release on hard process exit (Ctrl+C, kill -TERM,
    // unhandled exception). Won't run on `kill -9` — that's why the next
    // boot also tolerates a stale lock whose PID is dead. The exit hook
    // is sync-only because the event loop is already torn down by the
    // time it fires; everything else uses async fs.
    let closed = false;
    const onProcessExit = () => {
      if (closed) return;
      closed = true;
      releaseLockOnExit(config.dbPath, lockNonce);
    };
    process.once("exit", onProcessExit);

    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      try {
        await Effect.runPromise(rootCache.flush());
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[kyju:db.close] final flush failed:", err);
      }
      process.off("exit", onProcessExit);
      await releaseLock(config.dbPath, lockNonce);
    };

    return {
      postMessage: (event: ServerEvent): Promise<void> =>
        Effect.runPromise(postMessageEffect(event)),
      reconnectClients: (): Promise<void> =>
        Effect.runPromise(reconnectClientsEffect),
      addSection: (section: SectionConfig): Promise<void> =>
        enqueueSectionOp(() => Effect.runPromise(addSectionEffect(section))),
      removeSection: (
        name: string,
        opts?: { deleteData?: boolean },
      ): Promise<void> =>
        enqueueSectionOp(() =>
          Effect.runPromise(removeSectionEffect(name, opts)),
        ),
      listSections: (): string[] => {
        // Synchronous snapshot — a `Ref.unsafeGet` would be ideal but
        // we use the runPromise form for consistency. Cheap because
        // currentSections is a tiny Map.
        const snap = Effect.runSync(Ref.get(currentSections));
        return [...snap.keys()];
      },
      flush: (): Promise<void> => Effect.runPromise(rootCache.flush()),
      close,
      client,
      effectClient,
    };
  });

export const createDb = async <TShape extends SchemaShape>(
  config: CreateDbConfig<TShape>,
): Promise<Db<TShape>> => {
  return Effect.runPromise(
    createDbEffect(config).pipe(Effect.provide(NodeFileSystem.layer)),
  );
};

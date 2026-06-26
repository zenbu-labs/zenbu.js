import fs from "node:fs/promises";
import { createReadStream, statSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  subscribe as watcherSubscribe,
  type AsyncSubscription,
} from "@parcel/watcher";
import type { WebSocket } from "ws";
import { createDb, type Db, type SectionConfig } from "@zenbu/kyju";
import type {
  KyjuError,
  KyjuMigration,
  EffectFieldNode,
  FieldNode,
} from "@zenbu/kyju";
import type * as Effect from "effect/Effect";
import { createRouter } from "@zenbu/kyju/transport";
import { encodeFrame, decodeFrame } from "../transport/ws-frame";
import { loadMigrationsFromDir } from "@zenbu/kyju/loader";
import { Service, runtime, getPlugins, subscribeConfig } from "../runtime";
import type { ResolvedDbRoot } from "../registry";
import { schema as coreSchema } from "../schema";
import { addDb, resolveDbPath } from "../shared/db-registry";
import { HttpService } from "./http";
import { createLogger } from "../shared/log";

const log = createLogger("db");

/**
 * Walk up from this file's location until we hit the @zenbujs/core
 * package.json. Same trick as `loaders/zenbu.ts` and `vite-plugins.ts`;
 * worth deduping into a shared helper once we have a fourth caller.
 */
async function findCorePackageRoot(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  while (dir !== path.dirname(dir)) {
    const pkg = path.join(dir, "package.json");
    try {
      const parsed = JSON.parse(await fs.readFile(pkg, "utf8"));
      if (parsed.name === "@zenbujs/core") return dir;
    } catch {
      // missing/unparseable package.json on this level — keep climbing
    }
    dir = path.dirname(dir);
  }
  throw new Error(
    `[buildCoreSection] could not locate @zenbujs/core package root by walking up from ${here}`,
  );
}

/**
 * Build the core's DB section from the schema in this package + any
 * migrations shipped in `<core>/migrations/`. Loaded via tsx (registered
 * by setup-gate before the runtime services boot), so the source `.ts`
 * files in the published package are imported directly with no extra
 * compile step.
 *
 * If the migrations directory is missing (e.g. before the first
 * `npm run db:generate` runs in the core package), the section degrades
 * to `migrations: []` — same behavior as before this builder existed.
 */
async function buildCoreSection(): Promise<SectionConfig> {
  const corePackageRoot = await findCorePackageRoot();
  const migrationsDir = path.join(corePackageRoot, "migrations");
  let migrations: KyjuMigration[] = [];
  try {
    await fs.access(migrationsDir);
  } catch {
    // Missing dir is allowed: a brand-new core package without
    // `pnpm db:generate` having run yet. Emit an empty section.
    return { name: "core", schema: coreSchema, migrations };
  }
  // Once the dir exists, any load failure (missing file, bad TS, etc.)
  // is a real bug. Loud-fail rather than swallow — swallowing means
  // `sectionMigrationPlugin` sees `targetVersion = 0` and silently
  // leaves the section at its current state, which makes a "my new
  // field is undefined" symptom impossible to attribute.
  migrations = await loadMigrationsFromDir(migrationsDir);
  log.verbose(
    `core section: loaded ${migrations.length} migration(s) from ${migrationsDir}`,
  );
  return { name: "core", schema: coreSchema, migrations };
}

type EffectSectionProxy<S> = {
  [K in keyof S]: EffectFieldNode<S[K]>;
};

type SectionProxy<S> = {
  [K in keyof S]: FieldNode<S[K]>;
};

// `Root` is the resolved DB root: `ZenbuRegister["db"]` from the user's
// generated `zenbu-register.ts`, falling back to `{}` when no plugin has
// augmented the registry. Lets the same baked dts ship with core while
// consumer types flow in via module augmentation. Each top-level key on
// `Root` is a section (e.g. `core`, `app`); section names are the only
// namespace.
type Root = ResolvedDbRoot;

export type SectionedEffectClient = {
  readRoot(): Root;
  update(fn: (root: Root) => void | Root): Effect.Effect<void, KyjuError>;
  createBlob(data: Uint8Array, hot?: boolean, contentType?: string): Effect.Effect<string, KyjuError>;
  deleteBlob(blobId: string): Effect.Effect<void, KyjuError>;
  getBlobData(blobId: string): Effect.Effect<Uint8Array | null, KyjuError>;
} & {
  [K in keyof Root]: EffectSectionProxy<Root[K]>;
};

export type SectionedClient = {
  readRoot(): Root;
  update(fn: (root: Root) => void | Root): Promise<void>;
  createBlob(data: Uint8Array, hot?: boolean, contentType?: string): Promise<string>;
  deleteBlob(blobId: string): Promise<void>;
  getBlobData(blobId: string): Promise<Uint8Array | null>;
} & {
  [K in keyof Root]: SectionProxy<Root[K]>;
};

export async function resolveManifestModulePath(
  baseDir: string,
  specifier: string,
): Promise<string> {
  const resolved = path.resolve(baseDir, specifier);
  const candidates = path.extname(resolved)
    ? [resolved]
    : [
        resolved,
        `${resolved}.ts`,
        `${resolved}.js`,
        `${resolved}.mjs`,
        path.join(resolved, "index.ts"),
        path.join(resolved, "index.js"),
        path.join(resolved, "index.mjs"),
      ];

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile() || stat.isDirectory()) return candidate;
    } catch {
      // keep trying candidates
    }
  }

  throw new Error(
    `Could not resolve module entry for "${specifier}" from "${baseDir}"`,
  );
}

async function importFreshModule(modulePath: string): Promise<any> {
  // Plain `import()` so dynohot wraps the schema/migrations as live deps of
  // DbService. When these files change, dynohot's file watcher invalidates
  // them and propagates upward via `iterateWithDynamics`; DbService's
  // `runtime.register(..., import.meta)` accept handler re-runs
  // evaluate(), which re-discovers sections and calls createDb with the new
  // migrations array. Kyju's migration plugin then applies only the delta
  // against the existing on-disk DB.
  return import(pathToFileURL(modulePath).href);
}

function resolveConfigPath(): string {
  const fromEnv = process.env.ZENBU_CONFIG_PATH;
  if (!fromEnv) {
    throw new Error(
      "ZENBU_CONFIG_PATH is not set; setup-gate populates this before services boot.",
    );
  }
  return fromEnv;
}

/**
 * Load just the `db` field from the user's `zenbu.config.ts`. Used to feed
 * `resolveDbPath` (which expects a relative-or-absolute string). The full
 * plugin set comes from `runtime.getPlugins()` instead — populated by the
 * loader-emitted barrel before any service evaluates.
 */
async function loadAppDbField(configPath: string): Promise<string> {
  const { loadConfig } = await import("../cli/lib/load-config");
  const { resolved } = await loadConfig(path.dirname(configPath));
  return resolved.dbPath;
}

export async function discoverSections(): Promise<SectionConfig[]> {
  const plugins = getPlugins();

  const perPluginTimings: Array<{
    name: string;
    resolveSchemaMs: number;
    importSchemaMs: number;
    resolveMigrationsMs: number;
    importMigrationsMs: number;
    totalMs: number;
  }> = [];

  // Parallelize two axes:
  //   - Across plugins: all manifests process concurrently (outer Promise.all)
  //   - Within a plugin: schema chain and migrations chain overlap
  const tasks = plugins.map(
    async (plugin): Promise<SectionConfig | null> => {
      const pluginStart = Date.now();
      let resolveSchemaMs = 0;
      let importSchemaMs = 0;
      let resolveMigrationsMs = 0;
      let importMigrationsMs = 0;

      const finish = (result: SectionConfig | null) => {
        perPluginTimings.push({
          name: plugin.name,
          resolveSchemaMs,
          importSchemaMs,
          resolveMigrationsMs,
          importMigrationsMs,
          totalMs: Date.now() - pluginStart,
        });
        return result;
      };

      if (!plugin.schemaPath) return finish(null);

      try {
        const schemaChain = (async () => {
          const s0 = Date.now();
          const schemaPath = await resolveManifestModulePath(
            plugin.dir,
            plugin.schemaPath!,
          );
          resolveSchemaMs = Date.now() - s0;

          const s1 = Date.now();
          const schemaModule = await importFreshModule(schemaPath);
          importSchemaMs = Date.now() - s1;

          return { schemaPath, schemaModule };
        })();

        const migrationsChain = plugin.migrationsPath
          ? (async () => {
              try {
                const m0 = Date.now();
                const migrationsPath = await resolveManifestModulePath(
                  plugin.dir,
                  plugin.migrationsPath!,
                );
                resolveMigrationsMs = Date.now() - m0;

                const m1 = Date.now();
                const stat = await fs.stat(migrationsPath);
                let migrations: KyjuMigration[];
                if (stat.isDirectory()) {
                  migrations = await loadMigrationsFromDir(migrationsPath);
                } else {
                  const migModule = await importFreshModule(migrationsPath);
                  migrations =
                    migModule.migrations ?? migModule.default ?? [];
                }
                importMigrationsMs = Date.now() - m1;

                return { migrations, failed: false as const };
              } catch (error) {
                log.error(
                  `failed to load migrations for plugin "${plugin.name}": ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
                return { migrations: [] as KyjuMigration[], failed: true as const };
              }
            })()
          : Promise.resolve({
              migrations: [] as KyjuMigration[],
              failed: false as const,
            });

        const [schemaResult, migrationsResult] = await Promise.all([
          schemaChain,
          migrationsChain,
        ]);

        if (migrationsResult.failed) return finish(null);

        const schema =
          schemaResult.schemaModule.schema ?? schemaResult.schemaModule.default;
        if (!schema?.shape) {
          log.error(
            `schema module did not export a valid schema: ${schemaResult.schemaPath}`,
          );
          return finish(null);
        }

        return finish({
          name: plugin.name,
          schema,
          migrations: migrationsResult.migrations,
        });
      } catch (error) {
        log.error(
          `failed to load section for plugin "${plugin.name}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return finish(null);
      }
    },
  );

  const resolvedSections = await Promise.all(tasks);
  const sections: SectionConfig[] = resolvedSections.filter(
    (sec): sec is SectionConfig => sec !== null,
  );

  const sorted = [...perPluginTimings].sort((a, b) => b.totalMs - a.totalMs);
  log.verbose("per-plugin breakdown (ms, parallel):");
  for (const ptm of sorted) {
    log.verbose(
      `  ${ptm.name.padEnd(28)} total=${String(ptm.totalMs).padStart(6)} resS=${String(ptm.resolveSchemaMs).padStart(5)} impS=${String(ptm.importSchemaMs).padStart(6)} resM=${String(ptm.resolveMigrationsMs).padStart(5)} impM=${String(ptm.importMigrationsMs).padStart(6)}`,
    );
  }

  return sections;
}

export class DbService extends Service.create({
  key: "db",
  deps: { http: HttpService },
}) {
  db: Db | null = null;
  dbRouter: ReturnType<typeof createRouter> | null = null;
  private _dbPath: string | null = null;
  /**
   * Names of sections currently registered with kyju, mirrored from
   * the kyju Db. Used by `armPluginSetWatcher` to compute the
   * add/remove diff when the plugin set changes. Single source of
   * truth for the in-memory section set lives inside kyju
   * (`db.listSections()`); this Map is just the cached cross-snapshot
   * comparison input.
   */
  private knownSections = new Map<string, SectionConfig>();

  /**
   * Resolved DB path. Throws if accessed before `evaluate()` has run — the
   * service contract guarantees deps are evaluated before dependents, so any
   * access from a dependent service or RPC handler is safe.
   */
  get dbPath(): string {
    if (this._dbPath === null) {
      throw new Error("DbService.dbPath accessed before evaluate()");
    }
    return this._dbPath;
  }

  get client(): SectionedClient {
    return this.db!.client as unknown as SectionedClient;
  }

  get effectClient(): SectionedEffectClient {
    return this.db!.effectClient as unknown as SectionedEffectClient;
  }

  /**
   * Drain kyju's lagged-persistence queue. Safe to call anytime; idempotent
   * when nothing is pending. Used by service teardown (effect cleanup) so
   * shutdown / hot-reload don't lose in-memory writes.
   */
  async flush(): Promise<void> {
    if (!this.db) return;
    try {
      await this.db.flush();
    } catch (err) {
      log.error("flush failed:", err);
    }
  }

  /**
   * Flush + release the kyju cross-process lock at `<dbPath>/.lock`.
   * Called on service teardown so a subsequent process can open the DB
   * without seeing a stale lock. Idempotent.
   */
  async close(): Promise<void> {
    if (!this.db) return;
    try {
      await this.db.close();
    } catch (err) {
      log.error("close failed:", err);
    }
  }

  async evaluate() {
    await this.bootDb();
    this.armKyjuCloseOnCleanup();
    this.armMigrationsWatcher();
    this.armPluginSetWatcher();
    this.armWsTransport();
  }

  /**
   * Create the kyju `Db` instance once, with whatever sections the
   * plugin set currently declares. After this completes, the
   * instance is alive for the entire lifetime of this DbService
   * — plugin enable/disable mutates it in place via
   * `db.addSection` / `db.removeSection` rather than rebuilding,
   * so existing renderer sessions stay valid across toggles.
   *
   * Only the database path itself ever justifies a rebuild (a
   * different on-disk file is fundamentally a different db). The
   * dbPath is resolved here once and stashed; changes require a
   * full process restart, which is the right granularity for that
   * kind of change.
   */
  private async bootDb(): Promise<void> {
    const configPath = resolveConfigPath();
    const configDir = path.dirname(configPath);
    const configDbAbs = await loadAppDbField(configPath);
    const [coreSec, pluginSections, resolved] = await Promise.all([
      this.trace("build-core-section", () => buildCoreSection()),
      this.trace("discover-sections", () => discoverSections()),
      resolveDbPath(process.argv, {
        configDb: configDbAbs,
        configDir,
        configPath,
      }),
    ]);
    const sections = [coreSec, ...pluginSections];
    const dbPath = resolved.path;

    this.dbRouter = createRouter();
    this.db = await this.trace("create-db", () =>
      createDb({
        sections,
        path: dbPath,
        send: (event) => this.dbRouter!.send(event),
      }),
    );
    this._dbPath = dbPath;
    // Seed the section cache so the plugin-set-watcher's initial
    // "diff against last snapshot" produces an empty delta against
    // boot (everything in the boot snapshot is already installed).
    this.knownSections = new Map(sections.map((s) => [s.name, s]));
    addDb(dbPath).catch((err) => {
      log.error("failed to bump registry lastUsedAt:", err);
    });
    log.verbose(
      `ready at ${dbPath} (source: ${resolved.source}, sections: ${sections
        .map((s) => `${s.name}@v${s.migrations.length}`)
        .join(", ")})`,
    );
  }

  /**
   * On any teardown (hot-reload OR shutdown), drain kyju's lagged
   * writes AND release the cross-process lock. Without `close()`, in-
   * memory writes that haven't reached setImmediate's flush would
   * vanish, AND the next process attempting to open this DB would
   * either be blocked by a stale lock or (in the same-process re-init
   * case) would race against the abandoned writer.
   */
  private armKyjuCloseOnCleanup(): void {
    this.setup("kyju-close-on-cleanup", () => async () => {
      await this.close();
    });
  }

  /**
   * Watch each plugin's migrations directory so `zen db generate` —
   * which writes a fresh file plus updates `meta/_journal.json` —
   * picks up the newly-generated migration without a process
   * restart.
   *
   * Implementation: re-discover the current section list (which now
   * has the new migration in its `migrations` array) and re-call
   * `db.addSection(section)` for each. `addSection` is idempotent
   * — sections already at head version are a no-op, sections with
   * pending migrations get them applied in place. No kyju instance
   * is rebuilt, no sessions are touched, replicas see the migration
   * writes as ordinary `db-update` events.
   */
  private armMigrationsWatcher(): void {
    this.setup("migrations-watcher", () => {
      const subs: AsyncSubscription[] = [];
      let closed = false;
      let pendingTimer: ReturnType<typeof setTimeout> | null = null;
      let inFlight: Promise<void> | null = null;
      let queued = false;

      const triggerReload = async () => {
        if (closed) return;
        if (inFlight) {
          queued = true;
          return;
        }
        inFlight = (async () => {
          await this.applyCurrentSectionsToDb("migrations-watcher");
        })().catch((err) => {
          log.error("migrations-watcher reload failed:", err);
        });
        try {
          await inFlight;
        } finally {
          inFlight = null;
          if (queued && !closed) {
            queued = false;
            scheduleReload();
          }
        }
      };

      const scheduleReload = () => {
        if (closed) return;
        if (pendingTimer) clearTimeout(pendingTimer);
        pendingTimer = setTimeout(() => {
          pendingTimer = null;
          void triggerReload();
        }, 100);
      };

      void (async () => {
        for (const plugin of getPlugins()) {
          const migPath = plugin.migrationsPath;
          if (!migPath) continue;
          let isDir = false;
          try {
            isDir = (await fs.stat(migPath)).isDirectory();
          } catch {
            // Missing dir is fine — plugin hasn't generated migrations
            // yet. The first generate creates the dir; the next time
            // DbService re-evaluates (e.g. on a schema edit) this
            // watcher gets installed.
            continue;
          }
          if (!isDir) continue;

          const journalPath = path.join(migPath, "meta", "_journal.json");

          try {
            const sub = await watcherSubscribe(migPath, (err, events) => {
              if (err || closed) return;
              for (const event of events) {
                if (event.path === journalPath) {
                  scheduleReload();
                  return;
                }
                if (path.dirname(event.path) !== migPath) continue;
                if (event.type === "update") continue;
                const ext = path.extname(event.path);
                if (ext === ".ts" || ext === ".js" || ext === ".mjs") {
                  scheduleReload();
                  return;
                }
              }
            });
            if (closed) {
              await sub.unsubscribe().catch(() => {});
              return;
            }
            subs.push(sub);
          } catch (err) {
            log.error(
              `migrations-watcher subscribe failed for ${plugin.name}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
      })().catch((err) => {
        log.error("migrations-watcher setup failed:", err);
      });

      return async () => {
        closed = true;
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
        }
        const toClose = subs.splice(0);
        await Promise.all(
          toClose.map((s) => s.unsubscribe().catch(() => {})),
        );
      };
    });
  }

  /**
   * Pick up plugin-set changes from `zenbu.config.ts` (a plugin
   * added, removed, or its schema/migrations paths swapped) and
   * apply them as a delta against the live kyju Db.
   *
   * For each enabled plugin not already registered with kyju:
   * `db.addSection(...)` (idempotent; if its data slot already
   * exists on disk from a previous run, it's preserved and only
   * pending migrations run). For each previously-registered plugin
   * that disappeared from the snapshot: `db.removeSection(name)`
   * with the default `deleteData: false`, so the plugin's data
   * survives the toggle and re-enabling restores it instantly.
   *
   * No kyju instance is rebuilt. Renderer sessions stay valid.
   * Connected replicas observe the section-init writes + any
   * migration writes as ordinary `db-update` broadcasts.
   */
  private armPluginSetWatcher(): void {
    this.setup("plugin-set-watcher", () => {
      let initialFire = true;
      return subscribeConfig(() => {
        if (initialFire) {
          // First fire happens synchronously inside subscribeConfig;
          // boot has already loaded the initial section set.
          initialFire = false;
          return;
        }
        void this.applyCurrentSectionsToDb("plugin-set").catch((err) => {
          log.error("plugin-set-watcher apply failed:", err);
        });
      }, "db/plugin-set-watcher");
    });
  }

  /**
   * Re-discover the current section set (from the live
   * `runtime.getPlugins()` map) and apply the delta to kyju via
   * `addSection` / `removeSection`. Called by the plugin-set
   * watcher (when the config changes) and the migrations watcher
   * (when `zen db generate` lands a new migration file).
   *
   * Idempotent and reentrancy-safe: kyju's section ops are
   * serialized internally, and `addSection` against an already-
   * registered section with the same migrations is a no-op.
   */
  private async applyCurrentSectionsToDb(reason: string): Promise<void> {
    const db = this.db;
    if (!db) return;
    const [coreSec, pluginSections] = await Promise.all([
      buildCoreSection(),
      discoverSections(),
    ]);
    const next = new Map<string, SectionConfig>(
      [coreSec, ...pluginSections].map((s) => [s.name, s]),
    );

    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    for (const [name, section] of next) {
      const prev = this.knownSections.get(name);
      if (!prev) {
        added.push(name);
        continue;
      }
      if (prev.migrations.length !== section.migrations.length) {
        changed.push(name);
      }
    }
    for (const name of this.knownSections.keys()) {
      if (!next.has(name)) removed.push(name);
    }

    if (added.length === 0 && removed.length === 0 && changed.length === 0) {
      return;
    }
    log.verbose(
      `apply sections (${reason}): +[${added.join(",")}] -[${removed.join(",")}] ~[${changed.join(",")}]`,
    );

    // For changed migration sets (the same name with more migrations
    // than we last saw), we need to feed kyju the *new* section
    // config so its idempotency check uses the new migration list.
    // `addSection` rejects an already-registered name with different
    // migrations to catch caller mistakes — so first removeSection
    // (data-preserving), then addSection with the new config.
    for (const name of changed) {
      const section = next.get(name)!;
      try {
        await db.removeSection(name);
        await db.addSection(section);
      } catch (err) {
        log.error(`apply sections: re-add "${name}" failed:`, err);
      }
    }
    for (const name of added) {
      const section = next.get(name)!;
      try {
        await db.addSection(section);
      } catch (err) {
        log.error(`apply sections: addSection("${name}") failed:`, err);
      }
    }
    for (const name of removed) {
      try {
        await db.removeSection(name);
      } catch (err) {
        log.error(`apply sections: removeSection("${name}") failed:`, err);
      }
    }
    this.knownSections = next;
  }

  /**
   * Wire each ws connection up to the kyju replication router.
   *
   * One-shot setup — since kyju is no longer rebuilt on plugin
   * toggles (it grows/shrinks sections in place via
   * `addSection`/`removeSection`), the `dbRouter` is stable for the
   * service's lifetime and the transport never needs to re-arm.
   */
  private armWsTransport(): void {
    const http = this.ctx.http;

    // First-class blob URLs: stream a blob's bytes straight from disk over
    // the host's HTTP server so the browser can fetch/cache it by URL
    // (`useBlobUrl`), instead of marshalling megabytes through the DB
    // channel into a `Blob`/object URL on every render.
    this.setup("blob-http", () =>
      http.addRequestHandler("/__blob/", (req, res) => {
        try {
          const u = new URL(req.url ?? "/", "http://127.0.0.1");
          if (u.searchParams.get("token") !== http.authToken) {
            res.writeHead(403);
            res.end("forbidden");
            return;
          }
          const blobId = decodeURIComponent(
            u.pathname.slice("/__blob/".length),
          );
          if (!/^[A-Za-z0-9_-]+$/.test(blobId)) {
            res.writeHead(400);
            res.end("bad blob id");
            return;
          }
          const dir = path.join(this.dbPath, "blobs", blobId);
          const file = path.join(dir, "data");
          const stat = statSync(file, { throwIfNoEntry: false });
          if (!stat) {
            res.writeHead(404);
            res.end("not found");
            return;
          }
          // Prefer the content-type stored alongside the blob (zenbu.js#8);
          // fall back to an explicit `?type=` hint, then octet-stream.
          let storedType: string | undefined;
          try {
            const idx = JSON.parse(
              readFileSync(path.join(dir, "index.json"), "utf8"),
            );
            if (typeof idx?.contentType === "string") storedType = idx.contentType;
          } catch {}
          res.writeHead(200, {
            "Content-Type":
              storedType || u.searchParams.get("type") || "application/octet-stream",
            "Content-Length": String(stat.size),
            // blobIds are immutable, so the bytes for one never change.
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          if (req.method === "HEAD") {
            res.end();
            return;
          }
          createReadStream(file).pipe(res);
        } catch {
          if (!res.headersSent) res.writeHead(500);
          res.end("error");
        }
      }),
    );

    this.setup("ws-transport", () => {
      const wsDbConnections = new Map<
        string,
        { receive: (event: any) => Promise<void>; close: () => void }
      >();
      const onConnected = (id: string, ws: WebSocket) => {
        const dbConn = this.dbRouter!.connection({
          send: (event: any) => {
            if (ws.readyState === ws.OPEN) {
              ws.send(encodeFrame({ ch: "db", data: event }));
            }
          },
          postMessage: this.db!.postMessage,
        });
        wsDbConnections.set(id, dbConn);

        ws.on("message", async (raw: Buffer, isBinary: boolean) => {
          const msg = decodeFrame(isBinary ? raw : raw.toString(), isBinary);
          if (msg.ch === "db") {
            await dbConn.receive(msg.data);
          }
        });
      };

      const onDisconnected = (id: string) => {
        const conn = wsDbConnections.get(id);
        if (conn) {
          conn.close();
          wsDbConnections.delete(id);
        }
      };

      const unsubConnected = http.onConnected(onConnected);
      const unsubDisconnected = http.onDisconnected(onDisconnected);

      for (const [id, ws] of http.activeConnections) {
        onConnected(id, ws);
      }

      return () => {
        unsubConnected();
        unsubDisconnected();
        for (const conn of wsDbConnections.values()) conn.close();
        wsDbConnections.clear();
      };
    });
  }
}

runtime.register(DbService, import.meta);

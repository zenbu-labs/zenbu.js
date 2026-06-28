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
      
    }
  }

  throw new Error(
    `Could not resolve module entry for "${specifier}" from "${baseDir}"`,
  );
}

async function importFreshModule(modulePath: string): Promise<any> {
  
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
  
  private knownSections = new Map<string, SectionConfig>();

  
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

  
  async flush(): Promise<void> {
    if (!this.db) return;
    try {
      await this.db.flush();
    } catch (err) {
      log.error("flush failed:", err);
    }
  }

  
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

  
  private armKyjuCloseOnCleanup(): void {
    this.setup("kyju-close-on-cleanup", () => async () => {
      await this.close();
    });
  }

  
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

  
  private armPluginSetWatcher(): void {
    this.setup("plugin-set-watcher", () => {
      let initialFire = true;
      return subscribeConfig(() => {
        if (initialFire) {
          
          initialFire = false;
          return;
        }
        void this.applyCurrentSectionsToDb("plugin-set").catch((err) => {
          log.error("plugin-set-watcher apply failed:", err);
        });
      }, "db/plugin-set-watcher");
    });
  }

  
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

  
  private armWsTransport(): void {
    const http = this.ctx.http;

    
    this.setup("blob-http", () =>
      http.addRequestHandler("/__blob/", (req, res) => {
        const corsHeaders: Record<string, string> = {
          "Access-Control-Allow-Origin": req.headers.origin || "*",
          Vary: "Origin",
        };
        if (req.method === "OPTIONS") {
          res.writeHead(204, {
            ...corsHeaders,
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Max-Age": "86400",
          });
          res.end();
          return;
        }
        try {
          const u = new URL(req.url ?? "/", "http://127.0.0.1");
          if (u.searchParams.get("token") !== http.authToken) {
            res.writeHead(403, corsHeaders);
            res.end("forbidden");
            return;
          }
          const blobId = decodeURIComponent(
            u.pathname.slice("/__blob/".length),
          );
          if (!/^[A-Za-z0-9_-]+$/.test(blobId)) {
            res.writeHead(400, corsHeaders);
            res.end("bad blob id");
            return;
          }
          const dir = path.join(this.dbPath, "blobs", blobId);
          const file = path.join(dir, "data");
          const stat = statSync(file, { throwIfNoEntry: false });
          if (!stat) {
            res.writeHead(404, corsHeaders);
            res.end("not found");
            return;
          }
          
          let storedType: string | undefined;
          try {
            const idx = JSON.parse(
              readFileSync(path.join(dir, "index.json"), "utf8"),
            );
            if (typeof idx?.contentType === "string") storedType = idx.contentType;
          } catch {}
          res.writeHead(200, {
            ...corsHeaders,
            "Content-Type":
              storedType || u.searchParams.get("type") || "application/octet-stream",
            "Content-Length": String(stat.size),
           
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          if (req.method === "HEAD") {
            res.end();
            return;
          }
          createReadStream(file).pipe(res);
        } catch {
          if (!res.headersSent) res.writeHead(500, corsHeaders);
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

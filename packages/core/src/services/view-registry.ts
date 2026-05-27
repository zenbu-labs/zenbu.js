import * as Effect from "effect/Effect";
import { Service, runtime, getPlugins } from "../runtime";
import { ReloaderService, type ReloaderEntry } from "./reloader";
import { DbService } from "./db";
import { addComponentView } from "./advice-config";
import { createLogger } from "../shared/log";

const log = createLogger("view-registry");

export interface ViewMeta {
  kind?: string;
  sidebar?: boolean;
  bottomPanel?: boolean;
  label?: string;
  [key: string]: unknown;
}

export type ViewRendering = "iframe" | "component";

interface ViewEntry {
  type: string;
  /** Direct URL once Vite is up. Empty string while still lazy or for component views. */
  url: string;
  /** Listening port once Vite is up. 0 while still lazy or for component views. */
  port: number;
  ownsServer: boolean;
  lazy: boolean;
  rendering: ViewRendering;
  meta?: ViewMeta;
  /** Disposes the prelude entry for a component view; triggers a reload. */
  disposeSource?: () => void;
}

const DEFAULT_SHARED_RELOADER_ID = "app";

export type ViewSource =
  | {
      // component view
      modulePath: string;
      exportName?: string;
    }
  | {
      // iframe with dedicated Vite server
      root: string;
      configFile?: string | false;
      eager?: boolean;
    }
  | {
      // iframe sharing an existing Vite server
      pathPrefix: string;
      sharedWith?: string;
    };

/**
 *   - `rendering: "component"`: `source` must be `{ modulePath, ... }`.
 *   - `rendering: "iframe"` (default): `source` is either a `root`
 *     spec (own dev server) or a `pathPrefix` spec (share).
 */
export type RegisterViewSpec =
  | {
      type: string;
      meta?: ViewMeta;
      rendering: "component";
      source: { modulePath: string; exportName?: string };
    }
  | {
      type: string;
      meta?: ViewMeta;
      rendering?: "iframe";
      source:
        | { root: string; configFile?: string | false; eager?: boolean }
        | { pathPrefix: string; sharedWith?: string };
    };

export class ViewRegistryService extends Service.create({
  key: "viewRegistry",
  deps: { reloader: ReloaderService, db: DbService },
}) {
  private views = new Map<string, ViewEntry>();
  private manifestIcons = new Map<string, string>();

  /**
   * Register a view. Returns a synchronous dispose function;
   * wrapping the call in `this.setup(...)` ensures unregistration
   * runs on plugin teardown / hot reload.
   *
   * The actual registration work (Vite server start for `root` mode,
   * db write, prelude wiring) is fire-and-forget under the hood:
   * callers don't need to `await`. If you need the `ViewEntry`
   * synchronously, call `registerViewAndAwait` instead.
   */
  registerView(spec: RegisterViewSpec): () => void {
    void this.registerViewAndAwait(spec);
    return () => {
      void this.unregisterView(spec.type);
    };
  }

  /**
   * Same as `registerView` but returns the live `ViewEntry`. Use
   * when callers care about the entry's resolved URL / port (rare).
   */
  async registerViewAndAwait(spec: RegisterViewSpec): Promise<ViewEntry> {
    const { type, meta } = spec;
    const existing = this.views.get(type);
    if (existing) return existing;

    // --- component view ---------------------------------------------
    if (spec.rendering === "component") {
      // Metadata mirrors into `lastKnownViewRegistry`; the source
      // routes through `addComponentView` so every iframe's prelude
      // statically imports it + calls `registerViewComponent` before
      // `main.tsx` runs.
      const disposeSource = addComponentView(null, {
        type,
        modulePath: spec.source.modulePath,
        exportName: spec.source.exportName,
      });
      const entry: ViewEntry = {
        type,
        url: "",
        port: 0,
        ownsServer: false,
        lazy: false,
        rendering: "component",
        meta,
        disposeSource,
      };
      this.views.set(type, entry);
      await this.syncToDb();
      log.verbose(
        `"${type}" registered as component view (source=${spec.source.modulePath})`,
      );
      return entry;
    }

    // --- iframe view, sharing an existing Vite server ---------------
    if ("pathPrefix" in spec.source) {
      const { pathPrefix } = spec.source;
      const reloaderId = spec.source.sharedWith ?? DEFAULT_SHARED_RELOADER_ID;
      const reloaderEntry = this.ctx.reloader.get(reloaderId);
      if (!reloaderEntry) {
        throw new Error(
          `ViewRegistryService.register("${type}"): reloader "${reloaderId}" not found (shared iframe view). ` +
            `Make sure the service that owns the reloader has evaluated before this register call — ` +
            `for the framework's host renderer that means depending on RendererHostService.`,
        );
      }
      const entry: ViewEntry = {
        type,
        url: `${reloaderEntry.url}${pathPrefix}`,
        port: reloaderEntry.port,
        ownsServer: false,
        lazy: false,
        rendering: "iframe",
        meta,
      };
      this.views.set(type, entry);
      await this.syncToDb();
      log.verbose(
        `"${type}" registered as shared iframe view at ${entry.url} (sharedWith=${reloaderId}, prefix=${pathPrefix})`,
      );
      return entry;
    }

    // --- iframe view with its own dedicated Vite server -------------
    const { root, configFile, eager } = spec.source;

    if (!eager) {
      // Default path: declare the spec, defer the Vite startup until the
      // first `ensure(type)` call.
      this.ctx.reloader.registerLazy(type, root, configFile);
      const entry: ViewEntry = {
        type,
        url: "",
        port: 0,
        ownsServer: true,
        lazy: true,
        rendering: "iframe",
        meta,
      };
      this.views.set(type, entry);
      void this.syncToDb();
      return entry;
    }

    const reloaderEntry = await this.ctx.reloader.create(
      type,
      root,
      configFile,
    );
    const entry: ViewEntry = {
      type,
      url: reloaderEntry.url,
      port: reloaderEntry.port,
      ownsServer: true,
      lazy: false,
      rendering: "iframe",
      meta,
    };
    this.views.set(type, entry);
    await this.syncToDb();
    log.verbose(`"${type}" registered at ${entry.url}`);
    return entry;
  }

  /**
   * Materialize a lazy view: start its Vite server if it isn't running
   * yet, update the stored URL/port, and sync to the DB so the renderer
   * picks up the real URL. The renderer's `<View>` component calls this
   * automatically when an iframe is about to mount and finds an empty URL.
   */
  async ensure(args: { type: string }): Promise<ViewEntry | undefined> {
    const { type } = args;
    const entry = this.views.get(type);
    if (!entry) return undefined;
    // Component views have no backing Vite server; nothing to ensure.
    if (entry.rendering === "component") return entry;
    if (!entry.lazy || entry.url) return entry;
    const reloaderEntry = await this.ctx.reloader.ensure(type);
    if (!reloaderEntry) return entry;
    entry.url = reloaderEntry.url;
    entry.port = reloaderEntry.port;
    entry.lazy = false;
    await this.syncToDb();
    return entry;
  }

  async unregisterView(type: string): Promise<void> {
    const entry = this.views.get(type);
    if (!entry) return;
    if (entry.ownsServer) {
      await this.ctx.reloader.remove(type);
    }
    entry.disposeSource?.();
    this.views.delete(type);
    await this.syncToDb();
  }

  get(type: string): ViewEntry | undefined {
    return this.views.get(type);
  }

  evaluate() {
    this.loadManifestIcons();

    // Wipe stale rows from any prior session; ports are fresh on boot.
    void this.syncToDb();

    this.setup("view-registry-cleanup", () => {
      return async () => {
        for (const [type, entry] of this.views) {
          if (entry.ownsServer) {
            await this.ctx.reloader.remove(type);
          }
          entry.disposeSource?.();
        }
        this.views.clear();
        await this.syncToDb();
      };
    });
  }

  private loadManifestIcons(): void {
    this.manifestIcons.clear();
    for (const plugin of getPlugins()) {
      if (!plugin.icons) continue;
      for (const [type, svg] of Object.entries(plugin.icons)) {
        this.manifestIcons.set(type, svg);
      }
    }
  }

  private async syncToDb(): Promise<void> {
    const client = this.ctx.db.effectClient;
    const snapshot = [...this.views.values()].map((e) => ({
      type: e.type,
      url: e.url,
      port: e.port,
      icon: this.manifestIcons.get(e.type),
      rendering: e.rendering,
      meta: e.meta,
    }));
    await Effect.runPromise(
      client.update((root) => {
        root.core.lastKnownViewRegistry = snapshot;
      }),
    ).catch((err) => {
      // log removed
    });
  }
}

runtime.register(ViewRegistryService, import.meta);

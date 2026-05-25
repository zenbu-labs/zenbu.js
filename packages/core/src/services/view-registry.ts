import * as Effect from "effect/Effect";
import { Service, runtime, getPlugins } from "../runtime";
import { ReloaderService, type ReloaderEntry } from "./reloader";
import { DbService } from "./db";
import { enqueueRegistrationsWrite } from "./advice-config";
import { createLogger } from "../shared/log";

const log = createLogger("view-registry");

/**
 * View metadata surfaced to the renderer (icon picker, sidebar slot,
 * bottom-panel slot, human label). Optional everywhere; views without
 * metadata simply don't appear in the corresponding chrome.
 */
/**
 * View metadata is open by design. The framework attaches
 * meaning to a small set of well-known fields (`kind`, `sidebar`,
 * `bottomPanel`, `label`) used by built-in chrome (icon picker,
 * sidebar slot, bottom-panel slot, human label). Everything else
 * is userland — host applications and plugins are free to attach
 * their own fields here (sort hints, visibility predicates, etc.)
 * without coordinating with the framework. Unknown fields
 * round-trip through `lastKnownViewRegistry` thanks to the schema
 * being `.passthrough()`.
 */
export interface ViewMeta {
  kind?: string;
  sidebar?: boolean;
  bottomPanel?: boolean;
  label?: string;
  [key: string]: unknown;
}

/**
 * How the renderer should mount this view.
 *
 * - `"iframe"` (default): the registry owns a Vite server and the
 *   renderer's `<View>` mounts an out-of-process iframe pointed at it.
 * - `"component"`: no Vite server, no iframe. The renderer looks up a
 *   React component registered under `type` in its in-process client
 *   registry (`registerViewComponent` in `@zenbujs/core/react`) and
 *   mounts it directly. From the caller's point of view
 *   (`<View type="x" args={...}>`) the two modes are interchangeable.
 */
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
  /**
   * For `rendering: "component"` views with a `source`, the
   * `core.registrations` row's identity — used on unregister to
   * remove the matching row from the registrations table.
   */
  registrationKey?: { kind: "componentView"; type: string };
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
      // Metadata lives here (in `lastKnownViewRegistry`); the source
      // goes into `core.registrations` for the renderer-side reconciler
      // to dynamic-import and apply via `registerViewComponent`. `<View>`
      // reads both.
      const entry: ViewEntry = {
        type,
        url: "",
        port: 0,
        ownsServer: false,
        lazy: false,
        rendering: "component",
        meta,
        registrationKey: { kind: "componentView", type },
      };
      this.views.set(type, entry);
      await this.syncToDb();
      await this.writeComponentViewRegistration(type, spec.source);
      log.verbose(
        `"${type}" registered as component view (source=${spec.source.modulePath})`,
      );
      return entry;
    }

    // --- iframe view, sharing an existing Vite server ---------------
    if ("pathPrefix" in spec.source) {
      const { pathPrefix } = spec.source;
      const reloaderId =
        spec.source.sharedWith ?? DEFAULT_SHARED_RELOADER_ID;
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
    if (entry.registrationKey) {
      await this.removeComponentViewRegistration(type);
    }
    this.views.delete(type);
    await this.syncToDb();
  }

  /**
   * Write (or update) the `core.registrations` row for a component
   * view's source. The renderer-side reconciler subscribes to this
   * table, dynamic-imports the source, and calls
   * `registerViewComponent(type, exported)` so `<View>` can render
   * the component inline.
   *
   * `rev` is preserved across re-registrations as long as the
   * `modulePath` is the same — we only bump it when the source path
   * itself changed (which would force the reconciler to use a new
   * cache-busted URL). Editing the source's contents bumps `rev` from
   * the Vite plugin's `handleHotUpdate`.
   */
  private async writeComponentViewRegistration(
    type: string,
    source: { modulePath: string; exportName?: string },
  ): Promise<void> {
    void DEFAULT_SHARED_RELOADER_ID; // keep the constant referenced in this scope

    await enqueueRegistrationsWrite((root) => {
      const idx = root.core.registrations.findIndex(
        (r: any) => r.kind === "componentView" && r.type === type,
      );
      let rev = 0;
      if (idx >= 0) {
        const prev = root.core.registrations[idx]!;
        rev = prev.rev;
        if (prev.modulePath !== source.modulePath) rev = rev + 1;
      }
      const next = {
        kind: "componentView" as const,
        type,
        modulePath: source.modulePath,
        exportName: source.exportName ?? "default",
        rev,
      };
      if (idx >= 0) {
        root.core.registrations[idx] = next;
      } else {
        root.core.registrations.push(next);
      }
    });
  }

  private async removeComponentViewRegistration(type: string): Promise<void> {
    await enqueueRegistrationsWrite((root) => {
      const idx = root.core.registrations.findIndex(
        (r: any) => r.kind === "componentView" && r.type === type,
      );
      if (idx >= 0) root.core.registrations.splice(idx, 1);
    });
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
          if (entry.registrationKey) {
            await this.removeComponentViewRegistration(type);
          }
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

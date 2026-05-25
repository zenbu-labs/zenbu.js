import * as Effect from "effect/Effect";
import { Service, runtime, getPlugins } from "../runtime";
import { ReloaderService, type ReloaderEntry } from "./reloader";
import { DbService } from "./db";
import { addComponentView } from "./advice-config";
import { createLogger } from "../shared/log";

const log = createLogger("view-registry");

/**
 * View metadata surfaced to the renderer (icon picker, sidebar slot,
 * bottom-panel slot, human label). Optional everywhere; views without
 * metadata simply don't appear in the corresponding chrome.
 */
export interface ViewMeta {
  kind?: string;
  sidebar?: boolean;
  bottomPanel?: boolean;
  label?: string;
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
   * Dispose for the per-iframe prelude registration (component views
   * only). Calling this removes the `registerViewComponent(...)` line
   * from every iframe's generated prelude and triggers a reload.
   */
  disposeSource?: () => void;
}

/**
 * Source spec for a component view. The framework imports `modulePath`
 * in every iframe's prelude and calls
 * `registerViewComponent(type, <export>)` automatically, so `<View
 * type="...">` resolves to a real component without any user-land
 * sentinel.
 *
 * `modulePath` follows the same plugin-root resolution rules as advice
 * / content-script paths (relative is resolved against the registering
 * service's plugin root; absolute is taken verbatim).
 *
 * `exportName` defaults to `"default"`.
 */
export interface RegisterViewSpecSource {
  modulePath: string;
  exportName?: string;
}

/**
 * Spec for a fresh view registration. The registry spins up a Vite dev
 * server rooted at `root` and exposes the resulting URL under `type`.
 *
 * - `type`: stable id used by `<View type="...">` in the renderer.
 * - `root`: absolute path of the view's `index.html` directory.
 * - `configFile`: explicit Vite config path, or `false` to skip auto-discovery.
 * - `meta`: optional renderer-facing metadata.
 * - `source`: for `rendering: "component"` views, the file to import
 *   into every iframe's prelude.
 */
export interface RegisterViewSpec {
  type: string;
  /**
   * Absolute path to the view's `index.html` directory. Required for
   * `rendering: "iframe"` (the default). Ignored for
   * `rendering: "component"` views.
   */
  root?: string;
  configFile?: string | false;
  meta?: ViewMeta;
  /**
   * Choose how the renderer mounts this view. See {@link ViewRendering}.
   * Defaults to `"iframe"`.
   */
  rendering?: ViewRendering;
  /**
   * For `rendering: "component"` views, the source module whose export
   * is the component to render. The framework imports it into every
   * iframe's prelude and calls `registerViewComponent(type, ...)`
   * automatically. Omit if you'd rather push the component from
   * user-land via `useRegisterViewComponent` / `registerViewComponent`.
   */
  source?: RegisterViewSpecSource;
  /**
   * Force the Vite server to start immediately at registration time
   * instead of on first iframe mount. The default is lazy: every plugin
   * view's Vite server is created on-demand when the renderer's `<View>`
   * component asks for its URL. Starting a second Vite server during the
   * entrypoint's `loadURL` blocks the Node event loop for hundreds of ms
   * and stalls the main iframe's modules, so eager registration is
   * essentially never what you want for non-entrypoint views.
   *
   * Ignored for `rendering: "component"` views — they have no Vite
   * server to start.
   */
  eager?: boolean;
}

/**
 * Spec for re-exposing an existing reloader under a different view type
 * with a path prefix. Mostly used by core to alias the host renderer
 * (`"app"`) and by plugins that bundle multiple sub-views inside one
 * Vite server.
 */
export interface RegisterAliasSpec {
  type: string;
  reloaderId: string;
  pathPrefix: string;
  meta?: ViewMeta;
}

export class ViewRegistryService extends Service.create({
  key: "view-registry",
  deps: { reloader: ReloaderService, db: DbService },
}) {
  private views = new Map<string, ViewEntry>();
  private manifestIcons = new Map<string, string>();

  async register(spec: RegisterViewSpec): Promise<ViewEntry> {
    const { type, root, configFile, meta, eager } = spec;
    const rendering: ViewRendering = spec.rendering ?? "iframe";
    log.verbose(
      `register("${type}", rendering="${rendering}", root="${root ?? ""}", config="${configFile}", eager=${!!eager})`,
    );
    const existing = this.views.get(type);
    if (existing) return existing;

    // Component views skip Vite entirely — the host renderer mounts a
    // React component registered under `type` directly. We still want
    // them in the registry so chrome (sidebar slot, icon picker,
    // label, focus chain, etc.) treats them identically to iframe views.
    if (rendering === "component") {
      // If a `source` was provided, route it through the same prelude
      // pipeline advice / content scripts use. `modulePath` must be
      // absolute (same convention as `root` for iframe views) — we
      // don't know which service called `register` without stack
      // tricks, so we don't try to anchor relative paths here. The
      // plugin author writes `path.resolve(import.meta.dirname, ...)`.
      let disposeSource: (() => void) | undefined;
      if (spec.source) {
        disposeSource = addComponentView(null, {
          type,
          modulePath: spec.source.modulePath,
          exportName: spec.source.exportName,
        });
      }
      const entry: ViewEntry = {
        type,
        url: "",
        port: 0,
        ownsServer: false,
        lazy: false,
        rendering,
        meta,
        disposeSource,
      };
      this.views.set(type, entry);
      await this.syncToDb();
      log.verbose(
        `"${type}" registered as component view${spec.source ? ` (source=${spec.source.modulePath})` : ""}`,
      );
      return entry;
    }

    if (!root) {
      throw new Error(
        `ViewRegistryService.register("${type}"): "root" is required for iframe views`,
      );
    }

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
        rendering,
        meta,
      };
      this.views.set(type, entry);
      void this.syncToDb();
      return entry;
    }

    const reloaderEntry = await this.ctx.reloader.create(type, root, configFile);
    const entry: ViewEntry = {
      type,
      url: reloaderEntry.url,
      port: reloaderEntry.port,
      ownsServer: true,
      lazy: false,
      rendering,
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

  registerAlias(spec: RegisterAliasSpec): ViewEntry {
    const { type, reloaderId, pathPrefix, meta } = spec;
    const existing = this.views.get(type);
    if (existing) return existing;

    const reloaderEntry = this.ctx.reloader.get(reloaderId);
    if (!reloaderEntry)
      throw new Error(
        `Reloader "${reloaderId}" not found for alias "${type}"`,
      );

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
    void this.syncToDb();
    return entry;
  }

  async unregister(type: string): Promise<void> {
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

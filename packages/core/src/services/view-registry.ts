import { Service, runtime, state, getPlugins } from "../runtime";
import { ReloaderService } from "./reloader";
import { createLogger } from "../shared/log";

const log = createLogger("view-registry");

/**
 * Renderer-facing shape for a registered view. The same shape is exposed
 * over the `state` wire channel via the `registry` cell below — kept in
 * its own type so renderer code (`<View>` in `react.ts`) can import
 * without pulling in the whole service module.
 */
export interface ViewRegistrySnapshotEntry {
  type: string;
  url: string;
  port: number;
  icon?: string;
  meta?: ViewMeta;
}

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

interface ViewEntry {
  type: string;
  url: string;
  port: number;
  ownsServer: boolean;
  meta?: ViewMeta;
}

/**
 * Spec for a fresh view registration. The registry spins up a Vite dev
 * server rooted at `root` and exposes the resulting URL under `type`.
 *
 * - `type`: stable id used by `<View type="...">` in the renderer.
 * - `root`: absolute path of the view's `index.html` directory.
 * - `configFile`: explicit Vite config path, or `false` to skip auto-discovery.
 * - `meta`: optional renderer-facing metadata.
 */
export interface RegisterViewSpec {
  type: string;
  root: string;
  configFile?: string | false;
  meta?: ViewMeta;
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
  deps: { reloader: ReloaderService },
}) {
  /**
   * Source of truth (main-process only). `registry` below is the
   * serialized projection broadcast to the renderer.
   */
  private views = new Map<string, ViewEntry>();
  private manifestIcons = new Map<string, string>();

  /**
   * Renderer-visible snapshot. Mirrored to every connected renderer
   * via `StateService` over the `state` wire channel. Dies with this
   * service instance — no DB round-trip, no stale rows after a crash.
   */
  registry = state<ViewRegistrySnapshotEntry[]>([]);

  async register(spec: RegisterViewSpec): Promise<ViewEntry> {
    const { type, root, configFile, meta } = spec;
    log.verbose(`register("${type}", root="${root}", config="${configFile}")`);
    const existing = this.views.get(type);
    if (existing) {
      log.verbose(`"${type}" already exists at ${existing.url}`);
      return existing;
    }

    log.verbose(`creating reloader for "${type}"...`);
    const reloaderEntry = await this.ctx.reloader.create(
      type,
      root,
      configFile,
    );
    log.verbose(`reloader created: ${reloaderEntry.url} (port ${reloaderEntry.port})`);
    const entry: ViewEntry = {
      type,
      url: reloaderEntry.url,
      port: reloaderEntry.port,
      ownsServer: true,
      meta,
    };
    this.views.set(type, entry);
    this.publish();
    log.verbose(`"${type}" registered at ${entry.url}`);
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
      meta,
    };
    this.views.set(type, entry);
    this.publish();
    return entry;
  }

  async unregister(type: string): Promise<void> {
    const entry = this.views.get(type);
    if (!entry) return;
    if (entry.ownsServer) {
      await this.ctx.reloader.remove(type);
    }
    this.views.delete(type);
    this.publish();
  }

  get(type: string): ViewEntry | undefined {
    return this.views.get(type);
  }

  evaluate() {
    this.loadManifestIcons();
    // Fresh boot: empty registry. Renderer sees [] until views register.
    this.publish();

    this.setup("view-registry-cleanup", () => {
      return async () => {
        for (const [type, entry] of this.views) {
          if (entry.ownsServer) {
            await this.ctx.reloader.remove(type);
          }
        }
        this.views.clear();
        this.publish();
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

  private publish(): void {
    const snapshot: ViewRegistrySnapshotEntry[] = [...this.views.values()].map(
      (e) => ({
        type: e.type,
        url: e.url,
        port: e.port,
        icon: this.manifestIcons.get(e.type),
        meta: e.meta,
      }),
    );
    this.registry.set(snapshot);
  }
}

runtime.register(ViewRegistryService, import.meta);

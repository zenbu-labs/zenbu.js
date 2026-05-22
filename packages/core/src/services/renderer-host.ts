import fsp from "node:fs/promises";
import path from "node:path";
import { Service, runtime, getAppEntrypoint } from "../runtime";
import { ReloaderService } from "./reloader";
import { ViewRegistryService } from "./view-registry";
import { createLogger } from "../shared/log";

const log = createLogger("renderer-host");

export const APP_RENDERER_RELOADER_ID = "app";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * The app's renderer root is the `uiEntrypoint` directory in
 * `zenbu.config.ts`. Vite's `root` resolves to it, and `index.html` inside
 * it is served through Vite. `splash.html` (sibling) is loaded raw — see
 * `setup-gate.spawnSplashWindow`.
 *
 * `vite.config.ts` is resolved by walking up from `rendererRoot` toward
 * the project root (the dir holding `zenbu.config.ts`). The first match
 * wins, so a per-package config (e.g. `packages/app/vite.config.ts`)
 * takes precedence over a root-level one. If none is found we return
 * `false` and Vite uses its built-in defaults.
 */
async function resolveRendererRoot(): Promise<{
  rendererRoot: string;
  configFile: string | false;
}> {
  const rendererRoot = getAppEntrypoint();
  if (!rendererRoot) {
    throw new Error(
      "[renderer-host] no `uiEntrypoint` registered. " +
        "Set `uiEntrypoint` in zenbu.config.ts before starting the app.",
    );
  }
  if (!(await pathExists(rendererRoot))) {
    throw new Error(
      `[renderer-host] uiEntrypoint directory does not exist: ${rendererRoot}.`,
    );
  }

  const configPath = process.env.ZENBU_CONFIG_PATH;
  const projectDir = configPath ? path.dirname(configPath) : rendererRoot;
  const configFile = await findViteConfigUp(rendererRoot, projectDir);

  return { rendererRoot, configFile };
}

/**
 * Walk deepest → shallowest from `rendererRoot` up to (and including)
 * `projectDir`, returning the first `vite.config.ts` found.
 *
 * Bounded by the number of path segments between the two dirs (typically
 * 0–4), so no risk of unbounded traversal. If `rendererRoot` doesn't sit
 * inside `projectDir` (`path.relative` returns `..` or an absolute path)
 * we only probe `projectDir` itself — the legacy behavior.
 */
async function findViteConfigUp(
  rendererRoot: string,
  projectDir: string,
): Promise<string | false> {
  const rel = path.relative(projectDir, rendererRoot);
  const escaping = rel.startsWith("..") || path.isAbsolute(rel);
  const segments = escaping || rel === "" ? [] : rel.split(path.sep);
  for (let i = segments.length; i >= 0; i--) {
    const candidate = path.join(
      projectDir,
      ...segments.slice(0, i),
      "vite.config.ts",
    );
    if (await pathExists(candidate)) return candidate;
  }
  return false;
}

export class RendererHostService extends Service.create({
  key: "renderer-host",
  deps: { reloader: ReloaderService, viewRegistry: ViewRegistryService },
}) {
  url = "";
  port = 0;

  async evaluate() {
    const { rendererRoot, configFile } = await resolveRendererRoot();
    const entry = await this.ctx.reloader.create(
      APP_RENDERER_RELOADER_ID,
      rendererRoot,
      configFile,
    );
    this.url = entry.url;
    this.port = entry.port;
    // The framework-managed view type is `"entrypoint"`: it's a synthetic
    // alias over the `uiEntrypoint` directory from zenbu.config.ts that
    // no plugin ever registers explicitly. User-defined view types live
    // alongside it; the name makes the framework-vs-user distinction
    // legible at every call site.
    this.ctx.viewRegistry.registerAlias({
      type: "entrypoint",
      reloaderId: APP_RENDERER_RELOADER_ID,
      pathPrefix: "",
      meta: { kind: "entrypoint", label: "App" },
    });

    log.verbose(`ready at ${this.url}`);
  }
}

runtime.register(RendererHostService, import.meta);

/**
 * this file is in a really hacky state needs to be fixed
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { register as registerLoaderImpl, createRequire } from "node:module";

function registerLoader(specifier: string, opts?: { data?: unknown }) {
  // `node:module#register` typings don't include the `data` field in older
  // @types/node, so we cast at the boundary.
  return (
    registerLoaderImpl as unknown as (
      specifier: string,
      parentURL?: string | URL,
      options?: { data?: unknown },
    ) => unknown
  )(specifier, undefined, opts);
}
import { pathToFileURL } from "node:url";
import { register as registerTsx } from "tsx/esm/api";
import { bootstrapEnv } from "./env-bootstrap";
import { bootTrace } from "./boot-trace";
import {
  parseZenbuBgEntries,
  pickZenbuBgEntry,
} from "./shared/zenbu-bg-parse";

type PackageJson = {
  name?: string;
  zenbu?: {
    host?: string;
    branch?: string;
    updateUrl?: string;
  };
};

type ElectronEvent = { preventDefault(): void };
type ElectronApp = {
  getAppPath(): string;
  whenReady(): Promise<void>;
  on(
    event: "before-quit" | "window-all-closed",
    listener: (event: ElectronEvent) => void,
  ): void;
  quit(): void;
  exit(code?: number): void;
};

type DynohotPauseModule = {
  closeAllWatchers?: () => void | Promise<void>;
};

type PluginModule = {
  default: () => unknown;
};

type PluginController = {
  main: () => Promise<void> | void;
};

const verbose = process.env.ZENBU_VERBOSE === "1";

/**
 * Suppress `@babel/generator`'s "[BABEL] Note: The code generator has
 * deoptimised the styling of <file> as it exceeds the max of 500KB" notice.
 * It's hardcoded as `console.error` in @babel/generator's printer with no
 * opt-out (https://github.com/babel/babel/issues/7569). Vite's
 * `@vitejs/plugin-react` runs Babel for fast-refresh on prebundled deps
 * caches, hitting this for `react-dom_client.js` and similar large chunks
 * on every dev boot. We filter the one specific message at the
 * `console.error` boundary so the rest of console.error stays useful.
 *
 * Patched once at module init, before any Vite dev server has started.
 */
const _origConsoleError = console.error.bind(console);
console.error = (...args: unknown[]): void => {
  if (
    args.length > 0 &&
    typeof args[0] === "string" &&
    args[0].startsWith("[BABEL] Note: The code generator has deoptimised")
  ) {
    return;
  }
  _origConsoleError(...args);
};

function isPluginModule(value: unknown): value is PluginModule {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PluginModule).default === "function"
  );
}

function isPluginController(value: unknown): value is PluginController {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PluginController).main === "function"
  );
}

function envMs(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function projectArg(): string | null {
  const arg = process.argv.find((item) => item.startsWith("--project="));
  return arg ? path.resolve(arg.slice("--project=".length)) : null;
}

function appDirName(name: string): string {
  return name.replace(/^@/, "").replace(/[\\/]/g, "__");
}

function readPackageJson(packageDir: string): PackageJson {
  const pkgPath = path.join(packageDir, "package.json");
  return JSON.parse(fs.readFileSync(pkgPath, "utf8")) as PackageJson;
}

function findProjectRoot(projectDir: string): string {
  let dir = path.resolve(projectDir);
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    dir = path.dirname(dir);
  }
  return path.resolve(projectDir);
}

function resolveConfigPath(projectRoot: string): string {
  const candidates = [
    "zenbu.config.ts",
    "zenbu.config.mts",
    "zenbu.config.js",
    "zenbu.config.mjs",
  ];
  for (const name of candidates) {
    const candidate = path.join(projectRoot, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `No zenbu config found at ${projectRoot}. Expected one of: ${candidates.join(
      ", ",
    )}`,
  );
}

function findTsconfig(projectRoot: string): string | false {
  const candidate = path.join(projectRoot, "tsconfig.json");
  return fs.existsSync(candidate) ? candidate : false;
}

function loadElectronApp(): ElectronApp {
  const requireFromCore = createRequire(import.meta.url);
  const electron = requireFromCore("electron") as { app?: ElectronApp };
  if (!electron.app) {
    throw new Error(
      "Electron app API is unavailable; setup-gate must run inside Electron",
    );
  }
  return electron.app;
}

async function closeRegisteredWatchers(): Promise<void> {
  const pause = (await import("@zenbujs/hmr/pause")) as DynohotPauseModule;
  await pause.closeAllWatchers?.();
}

type BootWindow = { windowId: string; win: unknown };

/**
 * Extract the splash's intended background color from `<meta name="zenbu-bg">`
 * tag(s). Used as the BaseWindow's `backgroundColor` so the OS doesn't
 * paint a single mismatched frame before the WebContentsView's pixels
 * reach the screen.
 *
 * Supports the `media` attribute (mirrors the W3C `theme-color` pattern),
 * so the splash can declare separate colors per system theme:
 *
 *   <meta name="zenbu-bg" content="#fafafa" media="(prefers-color-scheme: light)">
 *   <meta name="zenbu-bg" content="#09090b" media="(prefers-color-scheme: dark)">
 *
 * Defaults to `#F4F4F4` when no tag matches.
 */
function readSplashBgColor(splashPath: string, dark: boolean): string {
  try {
    const html = fs.readFileSync(splashPath, "utf8");
    const entries = parseZenbuBgEntries(html);
    const picked = pickZenbuBgEntry(entries, dark);
    if (picked) return picked;
  } catch {}
  return "#F4F4F4";
}

type ElectronWindowing = {
  BaseWindow: new (opts: Record<string, unknown>) => {
    contentView: {
      addChildView(view: unknown): void;
      removeChildView(view: unknown): void;
      readonly children: unknown[];
    };
    getContentBounds(): { width: number; height: number };
    show(): void;
    setBackgroundColor(color: string): void;
    setResizable(resizable: boolean): void;
    setMinimizable(minimizable: boolean): void;
    setMaximizable(maximizable: boolean): void;
    setFullScreenable(fullScreenable: boolean): void;
    setContentSize(width: number, height: number, animate?: boolean): void;
    center(): void;
    on(event: string, cb: (...args: unknown[]) => void): void;
  };
  WebContentsView: new (opts?: Record<string, unknown>) => {
    webContents: {
      loadFile(path: string): Promise<void>;
      close(): void;
    };
    setBounds(bounds: {
      x: number;
      y: number;
      width: number;
      height: number;
    }): void;
  };
  nativeTheme: {
    shouldUseDarkColors: boolean;
  };
};

/**
 * Spawn the splash window as early as possible OR adopt the launcher's
 * pre-existing installing window. The window is created with `show: true`
 * and its `backgroundColor` set up front so the OS composites a colored
 * frame on the next vsync — no waiting for `did-finish-load` before any
 * pixels reach the screen. Splash content paints into the WebContentsView
 * a frame or two later, replacing the flat color.
 *
 * If the launcher already opened an installing window
 * (`globalThis.__zenbu_boot_windows__` is non-empty), we reuse that
 * BaseWindow and just swap its child WebContentsView from installing.html
 * to splash.html. The titlebar / window chrome stays continuous.
 *
 * `BaseWindowService.evaluate()` adopts the resulting window from
 * `globalThis.__zenbu_boot_windows__` instead of creating a new one, so
 * `WindowService.openView` can swap the splash content view for the
 * Vite-served renderer in-place when the renderer is ready.
 */
async function spawnSplashWindow(
  splashPath: string | undefined,
): Promise<void> {
  if (!splashPath || !fs.existsSync(splashPath)) {
    if (verbose) {
      console.log(
        "[setup-gate] no splash.html resolved; skipping splash window",
      );
    }
    return;
  }

  const slot = globalThis as unknown as {
    __zenbu_boot_windows__?: BootWindow[];
  };
  const electron = (await import("electron")) as unknown as ElectronWindowing;
  const backgroundColor = readSplashBgColor(
    splashPath,
    electron.nativeTheme.shouldUseDarkColors,
  );
  // Only adopt the launcher's "main" window. Anything else in the slot
  // (legacy code, plugins) is ignored — we'd rather have a momentary
  // second window than swap content on a window we don't own.
  const existing = slot.__zenbu_boot_windows__?.find(
    (b) => b.windowId === "main",
  );

  type WindowingWindow = InstanceType<ElectronWindowing["BaseWindow"]>;
  let win: WindowingWindow;
  if (existing) {
    win = existing.win as WindowingWindow;
    // Update the BaseWindow's bg color to splash's so the brief gap
    // between removing the installing view and the splash WebContentsView
    // painting shows splash's intended color, not installing's.
    try {
      win.setBackgroundColor(backgroundColor);
    } catch {}
    // The launcher opens the install window at installer dimensions
    // (~480x320, non-resizable) so the cold-boot screen doesn't look
    // empty. The actual app needs splash-sized real estate though, so
    // resize back up + recenter + restore window chrome attributes here
    // before swapping in the splash view. Wrapped in try/catch because
    // BaseWindow may have been destroyed if the launcher errored out
    // between handoff() and us reaching this point.
    try {
      win.setResizable(true);
      win.setMinimizable(true);
      win.setMaximizable(true);
      win.setFullScreenable(true);
      win.setContentSize(1100, 750);
      win.center();
    } catch {}
    // Tear down the installing window's child view(s); we'll re-fill with
    // the splash view below.
    for (const child of [...win.contentView.children]) {
      try {
        win.contentView.removeChildView(child);
      } catch {}
      const wc = (child as { webContents?: { close(): void } }).webContents;
      try {
        wc?.close();
      } catch {}
    }
    if (verbose) {
      console.log(
        "[setup-gate] adopting existing installing window for splash",
      );
    }
  } else {
    win = new electron.BaseWindow({
      width: 1100,
      height: 750,
      titleBarStyle: "hidden",
      trafficLightPosition: { x: 14, y: 10 },
      backgroundColor,
    });
  }

  const splashView = new electron.WebContentsView();
  win.contentView.addChildView(splashView);
  const bounds = win.getContentBounds();
  splashView.setBounds({
    x: 0,
    y: 0,
    width: bounds.width,
    height: bounds.height,
  });

  /**
   * human note: this is a bad solution we should have an invariant verifying program state
   * but its fine for now
   */
  // We cap at 1500ms so a broken splash (404, JS error, etc.) doesn't
  // strand boot — the BaseWindow's backgroundColor already makes a
  // visible frame appear in that case.
  await Promise.race([
    splashView.webContents.loadFile(splashPath).catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, 1500)),
  ]);

  if (!existing) {
    const boot: BootWindow = { windowId: "main", win };
    slot.__zenbu_boot_windows__ = [
      ...(slot.__zenbu_boot_windows__ ?? []),
      boot,
    ];
  }

  if (verbose) {
    console.log(
      "[setup-gate] splash window shown with",
      splashPath,
      "bg=",
      backgroundColor,
    );
  }
}

type LoaderData = {
  payload: {
    plugins: Array<{
      name: string;
      dir: string;
      services: string[];
      schemaPath?: string;
      migrationsPath?: string;
      preloadPath?: string;
      eventsPath?: string;
      icons?: Record<string, string>;
    }>;
    appEntrypoint: string;
    splashPath?: string;
    installingPath?: string;
  };
  pluginSourceFiles: string[];
};

/**
 * Phase 1 of loader setup: register tsx + read the user's `zenbu.config.ts`.
 * This is split out from the rest of the loader registration so the splash
 * window can be spawned the moment optional `splashPath` is known, instead of
 * waiting for advice + dynohot to register too. tsx must run with the
 * project's tsconfig because user code (config + plugins) may rely on
 * non-default TS settings (paths, jsx, etc.).
 */
async function loadConfigPhase(
  tsconfig: string | false,
  projectRoot: string,
): Promise<LoaderData> {
  await bootTrace.span("tsx-register", () => {
    registerTsx({ tsconfig });
  });

  const { loadConfig } = await bootTrace.span(
    "import:cli/lib/load-config",
    () => import("./cli/lib/load-config"),
  );
  const { resolved, pluginSourceFiles } = await bootTrace.span(
    "loadConfig",
    () => loadConfig(projectRoot),
  );
  // Auto-link: regenerate `<app>/types/*.ts` so `useRpc()` / `useDb()` /
  // `useEvents()` resolve against the freshly-installed plugin set on
  // every launch. Content-addressed writes mean unchanged content is a
  // no-op (no working-tree mtime bumps that would trip the updater's
  // dirty-tree check). Non-fatal: link failures shouldn't block boot.
  try {
    await bootTrace.span("linkProject", async () => {
      const { linkProject } = await import("./cli/commands/link");
      await linkProject(projectRoot, { quiet: true });
    });
  } catch (err) {
    console.warn(
      `[setup-gate] zen link failed (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const loaderData: LoaderData = {
    payload: {
      plugins: resolved.plugins.map((p) => ({
        name: p.name,
        dir: p.dir,
        services: p.services,
        schemaPath: p.schemaPath,
        migrationsPath: p.migrationsPath,
        preloadPath: p.preloadPath,
        eventsPath: p.eventsPath,
        icons: p.icons,
      })),
      appEntrypoint: resolved.uiEntrypointPath,
      splashPath: resolved.splashPath,
      installingPath: resolved.installingPath,
    },
    pluginSourceFiles,
  };
  (
    globalThis as unknown as { __zenbu_main_resolved_config__?: LoaderData }
  ).__zenbu_main_resolved_config__ = loaderData;
  return loaderData;
}

/**
 * Phase 2 of loader setup: register the zenbu loader, advice, and dynohot.
 * Runs AFTER the splash window is on screen so the user sees pixels while
 * advice patches install and dynohot's worker spawns. Node 22+ runs loader
 * hooks in a worker thread; the resolved config crosses the boundary via
 * `register()`'s `data` argument.
 */
async function registerLoadersPhase(
  projectRoot: string,
  loaderData: LoaderData,
): Promise<void> {
  bootTrace.spanSync("register-zenbu-loader", () => {
    registerLoader(import.meta.resolve("@zenbujs/core/loaders/zenbu"), {
      data: loaderData,
    });
  });

  process.env.ZENBU_ADVICE_ROOT = projectRoot;
  // Main-process advice has no public API yet — nothing in user code
  // calls `advise()` against a main-process module today. Registering
  // the loader anyway costs ~2200ms of blocked event loop on boot
  // because every user `.ts` file gets parsed by babel inside the loader
  // worker (whose `Atomics.wait()` pins the main thread). Skip the
  // import entirely; opt in with `ZENBU_ENABLE_MAIN_ADVICE=1` once the
  // loader is rewritten on top of swc / a precompiled native binding.
  if (process.env.ZENBU_ENABLE_MAIN_ADVICE === "1") {
    await bootTrace.span("register-advice", () => import("@zenbu/advice/node"));
  } else {
    bootTrace.mark("register-advice:skipped");
  }

  const requireFromCore = createRequire(import.meta.url);
  const dynohotRegisterPath = requireFromCore.resolve("@zenbujs/hmr/register");
  const dynohot = await bootTrace.span(
    "import-dynohot",
    () => import(pathToFileURL(dynohotRegisterPath).href),
  );
  if (typeof dynohot.register === "function") {
    // Ignore both `node_modules/` and any `dist/` directory. The latter
    // covers `@zenbujs/core` when it's `link:`'d for development — its
    // built `dist/*.mjs` chunks are framework code that the app shouldn't
    // be hot-reloading. Without this, an entry can be loaded twice (once
    // hot-wrapped via the user's plugin barrel, once non-hot via setup-gate's
    // own dynamic imports), producing two distinct hot module URLs and
    // double-evaluating services like `ServerService`.
    bootTrace.spanSync("register-dynohot", () => {
      dynohot.register({ ignore: /[/\\](?:node_modules|dist)[/\\]/ });
    });
  }
}

export async function setupGate(): Promise<void> {
  // Always-on minimal startup logging. One line per major completed step
  // with elapsed-since-start, so a scrollback shows where boot time goes
  // without needing ZENBU_VERBOSE=1. Mirrored into `bootTrace` for the
  // unified flame graph.
  const t0 = Date.now();
  const ms = (): string => `+${Date.now() - t0}ms`;
  const step = (label: string): void => {
    console.log(`[zenbu] ${label} (${ms()})`);
    bootTrace.mark(label.replace(/\s+/g, "-"));
  };

  // Node 22+ can persist V8 bytecode for loaded modules. This does not
  // replace tsx/dynohot transforms, but it cuts repeated parse/compile cost
  // for the large main-process module graph (vite, core services, app
  // services) on warm boots. Best-effort: older runtimes simply skip it.
  try {
    const mod = await import("node:module") as any;
    const enableCompileCache = mod.enableCompileCache;
    if (typeof enableCompileCache === "function") {
      const cacheDir = path.join(os.homedir(), ".zenbu", ".internal", "node-compile-cache");
      fs.mkdirSync(cacheDir, { recursive: true });
      const result = enableCompileCache(cacheDir);
      bootTrace.mark("node-compile-cache-enabled", {
        status: result?.status,
        directory: result?.directory ?? cacheDir,
      });
    }
  } catch {}

  // Kick off the heavy `import("vite")` IMMEDIATELY — before even waiting
  // for `app.whenReady()`. Vite's main bundle is ~1.4MB and the top-level
  // evaluation takes ~1.4s of CPU (parses rollup, esbuild bindings, etc).
  // Running it here lets that work overlap with Electron's own startup
  // (electron-ready usually takes 80-200ms but the GPU/network helpers
  // take longer) and with the splash/loader registration. The cached
  // module promise is consumed later when `ViteService` calls
  // `createServer` — by then it's already a cache hit.
  const vitePrewarm = bootTrace.span("prewarm:vite-import", () =>
    import("vite").then(() => {}).catch(() => {}),
  );
  void vitePrewarm;
  (globalThis as unknown as {
    __zenbu_vite_prewarm__?: Promise<void>;
  }).__zenbu_vite_prewarm__ = vitePrewarm;

  const app = loadElectronApp();
  await app.whenReady();
  bootTrace.mark("electron-ready");
  step("electron ready");
  bootstrapEnv();

  // Install shutdown handling before loaders can create native watchers.
  // Cmd+Q can arrive while setup is still importing hot-wrapped modules; if
  // Electron proceeds with its default teardown then parcel-watcher's native
  // cleanup can race a dying NAPI env.
  let shuttingDown = false;
  const shutdown = async (exitCode = 0): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      const rt = (
        globalThis as {
          __zenbu_service_runtime__?: { shutdown(): Promise<void> };
        }
      ).__zenbu_service_runtime__;
      await rt?.shutdown();
    } catch (err) {
      console.error("[setup-gate] shutdown failed:", err);
    }
    try {
      await closeRegisteredWatchers();
    } catch (err) {
      console.error("[setup-gate] closeAllWatchers failed:", err);
    }
    // `process.exit` runs Node's normal shutdown, including the async
    // cleanup hooks parcel-watcher uses to drain native work. `app.exit`
    // bypasses too much of Node's cleanup path here.
    process.exit(exitCode);
  };
  app.on("before-quit", (event) => {
    event.preventDefault();
    void shutdown(0);
  });
  /**
   * i think we probably want to expose this in an editable form to the user
   */
  app.on("window-all-closed", () => {});
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  const autoQuitReadyMs = envMs("ZENBU_AUTO_QUIT_AFTER_READY_MS");
  if (autoQuitReadyMs != null) {
    if (verbose) {
      console.log(
        "[setup-gate] auto-quit after ready scheduled:",
        autoQuitReadyMs,
      );
    }
    setTimeout(() => app.quit(), autoQuitReadyMs).unref();
  }

  const bundledAppPath = app.getAppPath();
  const bundledPkg = readPackageJson(bundledAppPath);
  const appName = bundledPkg.name ?? path.basename(bundledAppPath);
  const resolvedProjectDir =
    projectArg() ??
    path.join(
      process.env.ZENBU_APPS_DIR ?? path.join(os.homedir(), ".zenbu", "apps"),
      appDirName(appName),
    );

  if (!fs.existsSync(resolvedProjectDir)) {
    throw new Error(
      `setup-gate: project directory ${resolvedProjectDir} does not exist. ` +
        `In a shipped .app, the launcher provisions this dir before invoking setup-gate. ` +
        `In dev, point at an existing project with --project=.`,
    );
  }

  const projectRoot = findProjectRoot(resolvedProjectDir);
  const configPath = resolveConfigPath(projectRoot);
  const tsconfig = findTsconfig(projectRoot);

  process.chdir(projectRoot);
  process.env.ZENBU_CONFIG_PATH = configPath;

  if (!process.argv.some((arg) => arg.startsWith("--project="))) {
    process.argv.push(`--project=${resolvedProjectDir}`);
  }

  if (verbose) {
    console.log("[setup-gate] project:", resolvedProjectDir);
    console.log("[setup-gate] config:", configPath);
  }

  // Anchor the trace to the project so `flush()` can write
  // `<project>/traces/boot/boot-<ts>.json` at the end of boot.
  bootTrace.setProjectRoot(projectRoot);

  // Pop the splash as early as possible. Only `loadConfig` is needed to
  // know `splashPath`; advice + dynohot registration is deferred until
  // after the window is on screen so the user sees pixels while those
  // run. BaseWindowService adopts the splash window on first evaluate
  // and hands it off to WindowService.openView, which swaps the splash
  // WebContentsView for the Vite-served renderer.
  let loaderData: LoaderData;
  try {
    loaderData = await bootTrace.span("load-config-phase", () =>
      loadConfigPhase(tsconfig, projectRoot),
    );
  } catch (err) {
    if (shuttingDown) return;
    throw err;
  }
  if (shuttingDown) return;
  step(`config loaded (${loaderData.payload.plugins.length} plugins)`);

  try {
    if (loaderData.payload.splashPath) {
      // spawnSplashWindow now awaits the splash's did-finish-load (with a
      // 1500ms cap), so by the time it returns the splash content is
      // loaded into the renderer process AND the main thread has yielded
      // long enough for AppKit to composite the window. No artificial
      // setImmediate / setTimeout yield needed.
      await bootTrace.span("spawn-splash", () =>
        spawnSplashWindow(loaderData.payload.splashPath),
      );
    } else {
      bootTrace.mark("splash-skipped");
    }
  } catch (err) {
    if (shuttingDown) return;
    throw err;
  }
  if (shuttingDown) return;
  step(loaderData.payload.splashPath ? "splash shown" : "splash skipped");

  try {
    await bootTrace.span("register-loaders-phase", () =>
      registerLoadersPhase(projectRoot, loaderData),
    );
  } catch (err) {
    if (shuttingDown) return;
    throw err;
  }
  if (shuttingDown) return;
  step("loaders registered");

  // Bind the WS/HTTP server to a port NOW, before the heavy `default-services`
  // imports queue 100MB of tsx/dynohot/babel work onto the event loop.
  // `http.Server.listen(0)` returns instantly but its callback is a
  // queued task — if we let it race against the import chain, the callback
  // is starved for 1500-2000ms (the listen syscall finishes in <1ms; the
  // delay is pure JS scheduling). Doing it here keeps the bind on the
  // critical path but lets it finish before everything else piles up.
  // ServerService picks up the pre-bound server via globalThis.
  await bootTrace.span("prealloc-http-server", async () => {
    const http = await import("node:http");
    const { WebSocketServer } = await import("ws");
    const server = http.createServer();
    const wss = new WebSocketServer({ noServer: true });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });
    (globalThis as unknown as {
      __zenbu_preallocated_server__?: {
        server: import("node:http").Server;
        wss: import("ws").WebSocketServer;
        port: number;
      };
    }).__zenbu_preallocated_server__ = { server, wss, port };
  });

  // (Vite prewarm fired earlier, before app.whenReady, so it overlaps
  // with Electron's own GPU/network helper startup. By now the import
  // is either resolved or close to it; downstream `import("vite")`
  // calls inside reloader.ts hit the module cache instantly.)

  // Kick both module-graph loads in parallel. Default-services pulls in
  // the framework's built-in services (DB, RPC, Vite reloader, etc.) and
  // `zenbu:plugins` loads the user's plugin barrel — they share no
  // ordering dependency at the import level (registrations resolve in
  // topological order at evaluate time, not at import time), so running
  // them serially put ~600ms of the plugin-barrel transform on the
  // critical path for no reason. The runtime won't actually start
  // evaluating any service until both are done because
  // `runtime.whenIdle()` below waits on every registered slot.
  const url = `zenbu:plugins?config=${encodeURIComponent(configPath)}`;
  let mod: unknown;
  try {
    const [, m] = await Promise.all([
      bootTrace.span("default-services", async () => {
        const { defaultServices } = await import("./services/default");
        await defaultServices();
      }),
      bootTrace.span("import:zenbu-plugins", () =>
        import(url, { with: { hot: "import" } }),
      ),
    ]);
    mod = m;
  } catch (err) {
    if (shuttingDown) return;
    throw err;
  }
  if (shuttingDown) return;
  if (isPluginModule(mod)) {
    const controller = mod.default();
    if (isPluginController(controller)) {
      await bootTrace.span("plugin-controller-main", () => controller.main());
    }
  }
  if (shuttingDown) return;
  step("plugins evaluated");

  const runtime = (
    globalThis as { __zenbu_service_runtime__?: { whenIdle(): Promise<void> } }
  ).__zenbu_service_runtime__;
  await bootTrace.span("runtime-when-idle", async () => {
    await runtime?.whenIdle();
  });
  step("ready");

  // Give the renderer a beat to deliver FCP / first-render marks via the
  // BootTraceService RPC, then flush the unified flame to stdout + disk.
  // We don't await this — the timeout will fire whether or not the
  // renderer connects, and it shouldn't block service idleness.
  setTimeout(() => {
    bootTrace.flush({ reason: "ready" });
  }, 1500).unref();
  // Second, later flush for renderer/app-visible marks. The first flush is
  // intentionally early for quick feedback, but FCP/LCP/AppReady can happen
  // several seconds later in dev mode if the renderer import graph is large.
  setTimeout(() => {
    bootTrace.flush({ reason: "app-visible" });
  }, 7000).unref();

  const autoQuitMs = envMs("ZENBU_AUTO_QUIT_AFTER_IDLE_MS");
  if (autoQuitMs != null) {
    if (verbose) console.log("[setup-gate] auto-quit scheduled:", autoQuitMs);
    setTimeout(() => app.quit(), autoQuitMs).unref();
  }
}

void setupGate().catch((error) => {
  console.error(error);
  process.exit(1);
});

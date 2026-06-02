/**
 * Zenbu launcher shim.
 *
 * Shipped inside `@zenbujs/core/dist/launcher.mjs` and copied into the .app
 * bundle by `zen build:electron`. The bundle's `package.json#main` points
 * here, so this is the FIRST user code Electron evaluates after main process
 * boot.
 *
 * Job:
 *   1. Clone or fetch the configured source mirror into `~/.zenbu/apps/<name>/`
 *      (we no longer bundle a `seed/` snapshot — every launch picks up
 *      whatever's on the mirror's branch HEAD).
 *   2. Run `pnpm install` against the apps-dir using the bundled toolchain.
 *   3. Dynamic-`import()` the apps-dir's `@zenbujs/core/dist/setup-gate.mjs`,
 *      which becomes the one-and-only `@zenbujs/core` instance for the rest
 *      of the process lifetime.
 *
 * It must NOT import `@zenbujs/core`. Doing so would create two distinct
 * module identities (this bundled copy + the apps-dir copy) and split-brain
 * the runtime singleton, dynohot HMR, and `instanceof` checks.
 *
 * Allowed deps: node built-ins, the `electron` main-process API (provided
 * at runtime), and `isomorphic-git` (bundled into this file by tsdown — see
 * `packages/core/tsdown.config.ts` `neverBundle: ["electron"]`).
 */
import { app, BaseWindow, WebContentsView, nativeTheme, ipcMain } from "electron";
import { existsSync } from "node:fs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import {
  type InstallReporter,
  type InstallStepId,
  type PackageManagerSpec,
  type InstallProgress,
  depsSignature,
  readDepsSig,
  runInstall,
  writeDepsSig,
} from "./shared/pm-install";
import { readHostVersion } from "./shared/host-version";
import { resolveTargetSha } from "./shared/range-resolver";
import {
  parseZenbuBgEntries,
  pickZenbuBgEntry,
} from "./shared/zenbu-bg-parse";

// =============================================================================
//                          stdio + logging safety net
// =============================================================================
// When the .app is launched from Finder (or `open <app>`), the main process
// inherits stdout/stderr connected to pipes whose other end launchd
// promptly closes; subsequent writes throw EPIPE. Vite warmup / Effect's
// failure reporter / dynohot / user `console.log`s then crash the whole app
// with "Uncaught Exception: write EPIPE".
//
// Patching `console.log/error` is NOT enough — Effect (and others) capture
// `console.error` at module init time before our wrapper installs, then
// call the captured reference forever. The reliable fix is to patch the
// underlying *streams* (`process.stdout.write`, `process.stderr.write`) so
// even the captured-original `console.error` flows through our try/catch.
/**
 * fixme this is nonsense
 */
const _logDir = path.join(os.homedir(), ".zenbu", ".internal");
fs.mkdirSync(_logDir, { recursive: true });
const _logStream = fs.createWriteStream(path.join(_logDir, "launcher.log"), {
  flags: "a",
});
_logStream.write(
  `\n=== launcher ${new Date().toISOString()} pid=${process.pid} ===\n`,
);

function silenceStream(
  stream: NodeJS.WriteStream | undefined,
  prefix: string,
): void {
  if (!stream) return;
  const original = stream.write.bind(stream);
  const safeWrite = ((
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    try {
      const text =
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      _logStream.write(prefix + text);
    } catch {}
    try {
      return original(chunk as never, encodingOrCb as never, cb as never);
    } catch {
      return true;
    }
  }) as NodeJS.WriteStream["write"];
  (stream as unknown as { write: NodeJS.WriteStream["write"] }).write =
    safeWrite;
  stream.on("error", () => {});
}

silenceStream(process.stdout, "");
silenceStream(process.stderr, "[ERR] ");

process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  try {
    _logStream.write(
      "[UNCAUGHT] " + (err.stack ?? err.message ?? String(err)) + "\n",
    );
  } catch {}
  if (err.code === "EPIPE") return;
});
process.on("unhandledRejection", (reason: unknown) => {
  try {
    const err = reason as NodeJS.ErrnoException | undefined;
    _logStream.write(
      "[UNHANDLED] " + (err?.stack ?? err?.message ?? String(reason)) + "\n",
    );
  } catch {}
});

interface AppConfig {
  name: string;
  mirrorUrl?: string;
  branch?: string;
  version?: string;
  /**
   * Which PM to use for first-launch install. Older bundles built before
   * this field existed get an implicit pnpm@10.33.0 (matches the previous
   * hardcoded behavior).
   */
  packageManager?: PackageManagerSpec;
  /**
   * Path (relative to the .app's `Resources/`) of the staged
   * `installing.html`, when the user shipped one. When set, the launcher
   * pops a window with this HTML before clone + first install and emits
   * IPC progress events to it. Older bundles without this field get the
   * old "no window during install" behavior (just a dock bounce).
   */
  installingHtml?: string;
  /**
   * Path (relative to `Resources/`) of the framework's built-in preload
   * that exposes `window.zenbuInstall`. Always set when `installingHtml`
   * is set.
   */
  installingPreload?: string;
  /**
   * When true, skip the mirror clone / fetch / checkout entirely. Used by
   * `create-zenbu-app --desktop`, which pre-seeds `~/.zenbu/apps/<name>` as
   * a local working tree (with `.git/HEAD`) and ships the `.app` already
   * pointing at it. The `mirrorUrl` field becomes optional in this mode.
   */
  local?: boolean;
}

const LEGACY_PACKAGE_MANAGER: PackageManagerSpec = {
  type: "pnpm",
  version: "10.33.0",
};

const APP_PATH = app.getAppPath();
const RESOURCES_PATH = path.dirname(APP_PATH);

// =============================================================================
//                          installing.html window
// =============================================================================
// When the user ships an `installing.html` (declared by presence of
// `<uiEntrypoint>/installing.html` and staged into Resources/ by
// `zen build:electron`), the launcher pops a BaseWindow + WebContentsView
// loading that HTML BEFORE clone + first install. The framework's built-in
// preload (`installing-preload.cjs`) exposes `window.zenbuInstall.on(event, cb)`;
// the launcher emits events on these channels:
//
//   zenbu:install:step      { id, label }
//   zenbu:install:message   { text }
//   zenbu:install:progress  { phase?, loaded?, total?, ratio? }
//   zenbu:install:done      { id }
//   zenbu:install:error     { id?, message }
//
// On successful install, the launcher hands the BaseWindow off to setup-gate
// via `globalThis.__zenbu_boot_windows__`; setup-gate's `spawnSplashWindow`
// adopts it and swaps the WebContentsView in place for splash content.

type InstallEvent = "step" | "message" | "progress" | "done" | "error";

type ProgressPayload = InstallProgress;

interface Installer extends InstallReporter {
  emit(event: InstallEvent, payload: unknown): void;
  step(id: InstallStepId, label: string): void;
  done(id: InstallStepId): void;
  message(text: string): void;
  progress(payload: ProgressPayload): void;
  fail(err: unknown, id?: InstallStepId): void;
  /** Currently-active step id, or null before any step has been emitted. */
  readonly currentStep: InstallStepId | null;
  /**
   * Hand the BaseWindow off to setup-gate via globalThis.__zenbu_boot_windows__,
   * so setup-gate's spawnSplashWindow can adopt it and swap content in
   * place (no second window flash).
   */
  handoff(): void;
}

function readBgColor(htmlPath: string, fallback: string): string {
  try {
    const html = fs.readFileSync(htmlPath, "utf8");
    const entries = parseZenbuBgEntries(html);
    const picked = pickZenbuBgEntry(
      entries,
      nativeTheme.shouldUseDarkColors,
    );
    if (picked) return picked;
  } catch {}
  return fallback;
}

async function maybeOpenInstallingWindow(
  cfg: AppConfig,
): Promise<Installer | null> {
  if (!cfg.installingHtml) return null;
  const htmlPath = path.join(RESOURCES_PATH, cfg.installingHtml);
  if (!existsSync(htmlPath)) {
    _logStream.write(
      `[installer] installing.html not found at ${htmlPath}; skipping window\n`,
    );
    return null;
  }
  const preloadPath = cfg.installingPreload
    ? path.join(RESOURCES_PATH, cfg.installingPreload)
    : null;
  if (!preloadPath || !existsSync(preloadPath)) {
    _logStream.write(
      `[installer] installing-preload.cjs not found at ${preloadPath}; skipping window\n`,
    );
    return null;
  }

  const backgroundColor = readBgColor(htmlPath, "#F4F4F4");
  // Installer-shaped window: small, fixed size, centered. The cold-boot
  // install screen has nothing to interact with (one shimmering label +
  // an error block on failure), so splash-sized real estate would just
  // look empty. setup-gate's `spawnSplashWindow` resizes this BaseWindow
  // to splash dimensions during the handoff so the actual app doesn't
  // inherit the installer footprint.
  const win = new BaseWindow({
    width: 480,
    height: 320,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 10, y: 8 },
    backgroundColor,
    center: true,
  });
  const view = new WebContentsView({
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.contentView.addChildView(view);
  const layout = (): void => {
    const { width, height } = win.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  layout();
  win.on("resize", layout);

  // Re-pick the BG color when the OS theme flips during install. The HTML's
  // own CSS adapts via `prefers-color-scheme`; this keeps the BaseWindow's
  // pre-paint color in sync so the window edges (visible during resize /
  // around rounded corners) don't show the wrong-theme color.
  const onThemeChange = (): void => {
    try {
      win.setBackgroundColor(readBgColor(htmlPath, "#F4F4F4"));
    } catch {}
  };
  nativeTheme.on("updated", onThemeChange);

  // Escape hatch for the niche cold-boot hang: the page can show a
  // "Restart to launch" button (typically after a timeout) and call
  // `window.zenbuInstall.relaunch()`. Fully restart the Electron app so the
  // clone / install is retried from scratch. Guard against double-fire.
  let relaunching = false;
  const onRelaunch = (): void => {
    if (relaunching) return;
    relaunching = true;
    _logStream.write("[installer] relaunch requested from installing screen\n");
    try {
      app.relaunch();
    } catch {}
    app.exit(0);
  };
  ipcMain.on("zenbu:install:relaunch", onRelaunch);

  win.on("closed", () => {
    nativeTheme.removeListener("updated", onThemeChange);
    ipcMain.removeListener("zenbu:install:relaunch", onRelaunch);
  });

  // Buffer events emitted before the page has finished loading. `loadFile`
  // resolves on did-finish-load, but the first launcher events (step("clone"))
  // can fire within milliseconds of `maybeOpenInstallingWindow` returning —
  // before the renderer process has attached its preload + page listeners.
  // Without buffering, those early events are silently dropped and the UI
  // stays stuck on its initial state.
  let ready = false;
  type Pending = { event: InstallEvent; payload: unknown };
  const pending: Pending[] = [];
  view.webContents.once("did-finish-load", () => {
    ready = true;
    for (const p of pending) {
      try {
        if (view.webContents.isDestroyed()) break;
        view.webContents.send(`zenbu:install:${p.event}`, p.payload);
      } catch {}
    }
    pending.length = 0;
  });
  view.webContents.once("did-fail-load", (_e, _code, desc) => {
    _logStream.write(`[installer] did-fail-load: ${desc}\n`);
    // Drain anyway so we don't leak the buffer; the events are lost but
    // the launcher continues to make progress.
    pending.length = 0;
    ready = true;
  });

  void view.webContents.loadFile(htmlPath).catch((err) => {
    _logStream.write(
      `[installer] loadFile failed: ${(err as Error).message ?? err}\n`,
    );
  });

  const emit = (event: InstallEvent, payload: unknown): void => {
    if (!ready) {
      pending.push({ event, payload });
      return;
    }
    try {
      if (view.webContents.isDestroyed()) return;
      view.webContents.send(`zenbu:install:${event}`, payload);
    } catch {}
  };

  let currentStep: InstallStepId | null = null;
  const installer: Installer = {
    emit,
    get currentStep() {
      return currentStep;
    },
    step(id, label) {
      currentStep = id;
      emit("step", { id, label });
    },
    done(id) {
      emit("done", { id });
    },
    message(text) {
      emit("message", { text });
    },
    progress(payload) {
      emit("progress", payload);
    },
    fail(err, id) {
      const message =
        err instanceof Error ? err.stack ?? err.message : String(err);
      emit("error", { id: id ?? currentStep ?? undefined, message });
    },
    handoff() {
      const slot = globalThis as unknown as {
        __zenbu_boot_windows__?: Array<{ windowId: string; win: BaseWindow }>;
      };
      slot.__zenbu_boot_windows__ = [
        ...(slot.__zenbu_boot_windows__ ?? []),
        { windowId: "main", win },
      ];
    },
  };
  return installer;
}

function readAppConfig(): AppConfig {
  const configPath = path.join(APP_PATH, "app-config.json");
  return JSON.parse(fs.readFileSync(configPath, "utf8")) as AppConfig;
}

function appsDirFor(name: string): string {
  if (process.env.ZENBU_APPS_DIR)
    return path.resolve(process.env.ZENBU_APPS_DIR);
  return path.join(os.homedir(), ".zenbu", "apps", name);
}

interface MirrorRef {
  url: string;
  branch: string;
}

function resolveMirror(cfg: AppConfig): MirrorRef {
  if (!cfg.mirrorUrl) {
    throw new Error(
      "[launcher] no mirror configured. The .app's app-config.json must " +
        "contain `mirrorUrl` (the GitHub repo cloned on first launch). " +
        "Configure `mirror.target` in zenbu.build.ts and rebuild.",
    );
  }
  return { url: cfg.mirrorUrl, branch: cfg.branch ?? "main" };
}

/**
 * Look like a real git working tree? (Distinguish "we cloned this" from a
 * partial copy left behind by an interrupted clone.)
 */
function isExistingClone(dir: string): boolean {
  return existsSync(path.join(dir, ".git", "HEAD"));
}

async function cloneMirror(
  dir: string,
  mirror: MirrorRef,
  installer: Installer | null,
): Promise<void> {
  console.log(`[launcher] cloning ${mirror.url}#${mirror.branch} -> ${dir}`);
  installer?.step("clone", `Cloning ${mirror.url}#${mirror.branch}`);
  await fsp.mkdir(dir, { recursive: true });
  await git.clone({
    fs,
    http,
    dir,
    url: mirror.url,
    ref: mirror.branch,
    singleBranch: true,
    depth: 1,
    onProgress: installer
      ? (e) => {
          const ratio = e.total ? e.loaded / e.total : undefined;
          installer.progress({
            phase: e.phase,
            loaded: e.loaded,
            total: e.total,
            ratio,
          });
        }
      : undefined,
    onMessage: installer
      ? (msg) => installer.message(msg.replace(/\n+$/g, ""))
      : undefined,
  });
  console.log(`[launcher] clone complete`);
  installer?.done("clone");
}

/**
 * Resolve the latest commit on origin/<branch> whose
 * `package.json#zenbu.host` satisfies the running .app's `hostVersion`,
 * and check it out if HEAD isn't already there. Pure delegation to
 * `resolveTargetSha` from `shared/range-resolver.ts` — same code path
 * used by `UpdaterService.update()` at runtime.
 */
async function resolveAndCheckout(
  dir: string,
  mirror: MirrorRef,
  hostVersion: string,
  installer: Installer | null,
): Promise<void> {
  const result = await resolveTargetSha({
    fs,
    http,
    dir,
    mirror: { url: mirror.url, branch: mirror.branch },
    hostVersion,
    reporter: installer,
  });
  if (result.targetSha === null) {
    throw new Error(
      `[launcher] no commit on origin/${mirror.branch} declares a ` +
        `package.json#zenbu.host range that satisfies host=${hostVersion}. ` +
        `Update the .app to a newer build, or push a compatible source ` +
        `commit to the mirror.`,
    );
  }
  let localSha: string | null = null;
  try {
    localSha = await git.resolveRef({ fs, dir, ref: "HEAD" });
  } catch {}
  if (localSha === result.targetSha) {
    console.log(`[launcher] up to date (${localSha.slice(0, 7)})`);
    return;
  }
  console.log(
    `[launcher] checking out ${result.targetSha.slice(0, 7)}` +
      (localSha ? ` (was ${localSha.slice(0, 7)})` : "") +
      (result.targetSha === result.tipSha
        ? ""
        : ` (tip=${result.tipSha.slice(0, 7)})`),
  );
  await git.checkout({ fs, dir, ref: result.targetSha, force: true });
}

async function ensureAppsDir(
  appsDir: string,
  mirror: MirrorRef,
  hostVersion: string,
  installer: Installer | null,
): Promise<void> {
  // First-launch path only. If the apps-dir already exists as a git
  // working tree, we trust it as-is and never touch git on relaunch.
  // Updates after first install go exclusively through
  // `UpdaterService.update()` invoked from user code at runtime — the
  // launcher must never auto-update on quit-and-reopen.
  if (isExistingClone(appsDir)) return;

  if (existsSync(appsDir)) {
    const entries = await fsp.readdir(appsDir).catch(() => [] as string[]);
    if (entries.length > 0) {
      throw new Error(
        `[launcher] ${appsDir} exists and isn't a git working tree (has ${entries.length} entries). ` +
          `Move or delete it, then relaunch.`,
      );
    }
  }
  await cloneMirror(appsDir, mirror, installer);
  // Only on first install do we run the host-range resolver to land on
  // a compatible commit. After this, the tree stays put.
  await resolveAndCheckout(appsDir, mirror, hostVersion, installer);
}

async function ensureDepsInstalled(
  appsDir: string,
  pm: PackageManagerSpec,
  installer: Installer | null,
): Promise<void> {
  const nodeModules = path.join(appsDir, "node_modules");
  const nextSig = await depsSignature(appsDir, pm);

  if (existsSync(nodeModules)) {
    const current = await readDepsSig(appsDir);
    if (current === nextSig) return;
  }

  console.log(
    `[launcher] installing deps in ${appsDir} via ${pm.type}@${pm.version}`,
  );
  installer?.step("install", "Installing dependencies");
  await runInstall({
    appsDir,
    resourcesPath: RESOURCES_PATH,
    pm,
    reporter: installer,
  });
  await writeDepsSig(appsDir, nextSig);
  installer?.done("install");
}

async function handoff(appsDir: string): Promise<void> {
  const entry = path.join(
    appsDir,
    "node_modules",
    "@zenbujs",
    "core",
    "dist",
    "setup-gate.mjs",
  );
  if (!existsSync(entry)) {
    throw new Error(
      `[launcher] expected entry not found: ${entry}. The cloned source may be missing @zenbujs/core in its dependencies.`,
    );
  }

  if (!process.argv.some((arg) => arg.startsWith("--project="))) {
    process.argv.push(`--project=${appsDir}`);
  }
  process.env.ZENBU_LAUNCHED_FROM_BUNDLE = "1";
  await import(entry);
}

async function main(): Promise<void> {
  await app.whenReady();

  const cfg = readAppConfig();
  // Pop the installing window before any clone/install work so the user
  // sees something the moment the app launches. No-op when the user
  // didn't ship `<uiEntrypoint>/installing.html`.
  const installer = await maybeOpenInstallingWindow(cfg);

  try {
    const appsDir = appsDirFor(cfg.name);
    const pm = cfg.packageManager ?? LEGACY_PACKAGE_MANAGER;

    if (cfg.local) {
      if (!isExistingClone(appsDir)) {
        throw new Error(
          `[launcher] app-config.local is true but ${appsDir} is not a git ` +
            `working tree. The bundle was built with create-zenbu-app --desktop ` +
            `but the apps-dir was deleted or never seeded.`,
        );
      }
    } else {
      const mirror = resolveMirror(cfg);
      // Concrete `host.json#version` baked at `zen build:electron` time.
      // The resolver picks the latest mirror commit whose
      // `package.json#zenbu.host` range satisfies this value.
      const { version: hostVersion } = readHostVersion(APP_PATH);
      await ensureAppsDir(appsDir, mirror, hostVersion, installer);
    }

    await ensureDepsInstalled(appsDir, pm, installer);

    installer?.step("handoff", "Starting app");
    // Hand the BaseWindow off to setup-gate via __zenbu_boot_windows__;
    // setup-gate's spawnSplashWindow adopts it and swaps the WebContentsView
    // from installing.html to splash.html in place.
    installer?.handoff();
    await handoff(appsDir);
  } catch (err) {
    // installer.fail() reads installer.currentStep when no explicit id is
    // passed, so the page sees `{ id: "clone" | "fetch" | "install" | "handoff" }`
    // matching whichever phase was active when it threw.
    installer?.fail(err);
    throw err;
  }
}

main().catch((err) => {
  console.error("[launcher] fatal:", err);
  app.exit(1);
});

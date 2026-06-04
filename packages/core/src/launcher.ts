/**
 * Zenbu launcher shim. First user code Electron runs after boot (the .app's
 * `package.json#main`). Clones/fetches the source mirror into
 * `~/.zenbu/apps/<name>/`, installs deps, then dynamic-imports the apps-dir's
 * `setup-gate.mjs` as the one-and-only `@zenbujs/core` instance.
 *
 * Must NOT import `@zenbujs/core`: a second module identity would split-brain
 * the runtime singleton, dynohot HMR, and `instanceof` checks. Allowed deps:
 * node built-ins, `electron`, and `isomorphic-git` (bundled by tsdown).
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

// stdio + logging safety net. Launched from Finder, the main process inherits
// stdout/stderr pipes that launchd closes, so writes throw EPIPE and crash the
// app. We patch the underlying streams (not just console.*) because Effect and
// others capture `console.error` at init and call the original forever.
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

// installing.html window. If the user ships `<uiEntrypoint>/installing.html`,
// the launcher shows it in a BaseWindow before clone + first install, emitting
// `zenbu:install:*` IPC events that its preload forwards to
// `window.zenbuInstall`. On success the BaseWindow is handed to setup-gate via
// `globalThis.__zenbu_boot_windows__` for splash reuse.

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

/**
 * Repair a partial working tree from an interrupted clone/checkout: `.git`
 * exists (so `isExistingClone` trusts it) but tracked files are missing.
 * Only ABSENT tracked files are restored, at the CURRENT HEAD — never changes
 * the commit (preserves "no auto-update on relaunch") and never clobbers
 * user-edited files (this is a hackable tree).
 */
async function repairPartialCheckout(
  dir: string,
  installer: Installer | null,
): Promise<void> {
  let headSha: string;
  try {
    headSha = await git.resolveRef({ fs, dir, ref: "HEAD" });
  } catch {
    return;
  }
  let tracked: string[];
  try {
    tracked = await git.listFiles({ fs, dir, ref: "HEAD" });
  } catch {
    return;
  }
  const missing = tracked.filter(
    (rel) => !existsSync(path.join(dir, rel)),
  );
  if (missing.length === 0) return;
  console.log(
    `[launcher] repairing partial checkout at ${headSha.slice(0, 7)}: ` +
      `${missing.length}/${tracked.length} tracked files missing`,
  );
  _logStream.write(
    `[launcher] partial checkout repair: restoring ${missing.length} missing files\n`,
  );
  installer?.step("clone", `Repairing install (${missing.length} files)`);
  await git.checkout({
    fs,
    dir,
    ref: headSha,
    force: true,
    filepaths: missing,
  });
  installer?.done("clone");
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
  //
  // Exception: a clone that was interrupted mid-checkout has `.git` but a
  // partial working tree. Restore the missing tracked files (at the same
  // HEAD, without touching user edits) so a hung first install becomes
  // self-healing on the next launch instead of erroring forever.
  if (isExistingClone(appsDir)) {
    await repairPartialCheckout(appsDir, installer);
    return;
  }

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

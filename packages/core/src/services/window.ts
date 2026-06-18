import {
  Menu,
  WebContentsView,
  app,
  clipboard,
  dialog,
  shell,
  type BaseWindowConstructorOptions,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
  type WebContents,
  type WebContentsViewConstructorOptions,
} from "electron";
import electronContextMenu from "electron-context-menu";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { URLSearchParams } from "node:url";
import { runtime, Service } from "../runtime";
import { BaseWindowService, MAIN_WINDOW_ID } from "./base-window";
import { HttpService } from "./http";
import { ViteService } from "./vite";
import { createLogger } from "../shared/log";
import { entrypointBgColor } from "../shared/zenbu-bg";
import { bootTrace } from "../boot-trace";

const log = createLogger("window");

/**
 * Boot-time snapshot of how the host was launched, captured at module load so
 * HMR can't desync it from the real process state. `respawnSelf` spawns
 * `execPath` with `bootArgv + extras` to re-launch the same code path in dev or prod.
 */
const BOOT_EXEC_PATH: string = process.execPath;
const BOOT_ARGV: ReadonlyArray<string> = Object.freeze(
  process.argv.slice(1),
);

type MountedView_ = {
  windowId: string;
  injection: string | null;
  view: WebContentsView;
  disposeContextMenu: () => void;
};

function queryString(
  query?: Record<string, string | number | boolean | null | undefined>,
): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export class WindowService extends Service.create({
  key: "window",
  deps: {
    baseWindow: BaseWindowService,
    http: HttpService,
    vite: ViteService,
  },
}) {
  private mounted = new Map<string, MountedView_>();

  evaluate() {
    this.setup("window-view-cleanup", () => {
      return () => {
        for (const mounted of this.mounted.values()) {
          const win = this.ctx.baseWindow.windows.get(mounted.windowId);
          try {
            win?.contentView.removeChildView(mounted.view);
          } catch {}
          try {
            mounted.disposeContextMenu();
          } catch {}
          mounted.view.webContents.close();
        }
        this.mounted.clear();
      };
    });

    // Re-open the main window on dock/taskbar click when no
    // BaseWindow is live (Electron fires `activate` on every focus).
    this.setup("activate-reopens-main", () => {
      const onActivate = () => {
        if (this.ctx.baseWindow.windows.size > 0) return;
        this.openWindow({}).catch((err) => {
          log.error("activate-reopens-main: openWindow failed:", err);
        });
      };
      app.on("activate", onActivate);
      return () => {
        app.removeListener("activate", onActivate);
      };
    });

    // Electron's default application menu binds View > Reload / Force Reload /
    // Toggle Developer Tools to roles that call
    // `BrowserWindow.getFocusedWindow().webContents.<method>()`. The
    // framework only ever creates `BaseWindow` + `WebContentsView`, so the
    // BrowserWindow lookup returns undefined and the menu's accelerator
    // (Cmd+Alt+I etc.) crashes the main process with
    // `Cannot read properties of undefined (reading 'toggleDevTools')`.
    // Replace the application menu with one whose View items target the
    // focused mounted WebContentsView directly.
    this.setup("app-menu", () => this.installAppMenu());
  }

  /**
   * Walk every mounted WebContentsView and return the one currently
   * focused, so application-menu actions (reload, devtools) hit the view
   * the user is actually looking at instead of the wrong window.
   */
  private focusedMountedWebContents(): WebContents | null {
    for (const mounted of this.mounted.values()) {
      const wc = mounted.view.webContents;
      if (!wc.isDestroyed() && wc.isFocused()) return wc;
    }
    return null;
  }

  private installAppMenu(): () => void {
    const isMac = process.platform === "darwin";
    const focusedWc = () => this.focusedMountedWebContents();

    const viewSubmenu: MenuItemConstructorOptions[] = [
      {
        label: "Reload",
        accelerator: "CmdOrCtrl+R",
        click: () => focusedWc()?.reload(),
      },
      {
        label: "Force Reload",
        accelerator: "Shift+CmdOrCtrl+R",
        click: () => focusedWc()?.reloadIgnoringCache(),
      },
      {
        label: "Toggle Developer Tools",
        accelerator: isMac ? "Alt+Cmd+I" : "Ctrl+Shift+I",
        click: () => {
          const wc = focusedWc();
          if (!wc) return;
          if (wc.isDevToolsOpened()) wc.closeDevTools();
          else wc.openDevTools({ mode: "detach" });
        },
      },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ];

    // Use Electron's role-built submenus for the parts that don't reach
    // into webContents (so we don't reimplement Cmd+Q, Edit, Window, etc),
    // and only override View where the defaults crash.
    const template: MenuItemConstructorOptions[] = [
      ...((isMac ? [{ role: "appMenu" as const }] : []) as MenuItemConstructorOptions[]),
      { role: "fileMenu" },
      { role: "editMenu" },
      { label: "View", submenu: viewSubmenu },
      { role: "windowMenu" },
    ];

    const previous = Menu.getApplicationMenu();
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    return () => {
      Menu.setApplicationMenu(previous);
    };
  }

  async openWindow(args: {
    /**
     * Threaded into the URL as `?route=<injection>`; the host's
     * `App` reads it and mounts `<View name={route} />`. Omit for
     * the main window.
     */
    injection?: string;
    windowId?: string;
    query?: Record<string, string | number | boolean | null | undefined>;
    baseWindow?: BaseWindowConstructorOptions;
    webContentsView?: WebContentsViewConstructorOptions;
    backgroundColor?: string;
    contextMenu?: false | Parameters<typeof electronContextMenu>[0];
    devtoolsShortcut?: boolean;
  }): Promise<{ windowId: string }> {
    const label = args.injection ?? "main";
    return bootTrace.span(`openWindow(${label})`, () =>
      this.openWindowImpl(args, label),
    );
  }

  private async openWindowImpl(
    args: {
      injection?: string;
      windowId?: string;
      query?: Record<string, string | number | boolean | null | undefined>;
      baseWindow?: BaseWindowConstructorOptions;
      webContentsView?: WebContentsViewConstructorOptions;
      backgroundColor?: string;
      contextMenu?: false | Parameters<typeof electronContextMenu>[0];
      devtoolsShortcut?: boolean;
    },
    label: string,
  ): Promise<{ windowId: string }> {
    const rendererUrl = this.ctx.vite.url;
    if (!rendererUrl) {
      throw new Error(
        "[window] Vite server URL isn't ready yet.",
      );
    }

    const windowId = args.windowId ?? MAIN_WINDOW_ID;
    // Patchable diffs apply via setters; immutable diffs recreate and
    // reparent children. `onRecreate` below rebinds the resize listener.
    let { win } = this.ctx.baseWindow.ensureWindow({
      windowId,
      baseWindow: args.baseWindow,
    });

    const existing = this.mounted.get(windowId);
    if (existing) {
      try {
        win.contentView.removeChildView(existing.view);
      } catch {}
      try {
        existing.disposeContextMenu();
      } catch {}
      existing.view.webContents.close();
      this.mounted.delete(windowId);
    }

    const view = new WebContentsView({
      ...args.webContentsView,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        ...args.webContentsView?.webPreferences,
      },
    });
    view.setBackgroundColor(args.backgroundColor ?? entrypointBgColor());
    win.contentView.addChildView(view);

    // Right-click → standard browser context menu with "Inspect Element" so
    // the renderer is debuggable out of the box.
    const disposeContextMenu =
      args.contextMenu === false
        ? () => {}
        : electronContextMenu({
            showInspectElement: true,
            showSearchWithGoogle: false,
            showSelectAll: true,
            prepend: (_defaults, _params, _win) => [
              {
                label: "Reload window",
                click: () => {
                  try {
                    view.webContents.reload();
                  } catch (err) {
                    log.error("context menu: reload window failed:", err);
                  }
                },
              },
              {
                label: "Reload main process",
                click: () => {
                  void runtime.reloadAll().catch((err) => {
                    log.error("context menu: reload main process failed:", err);
                  });
                },
              },
              { type: "separator" },
            ],
            ...args.contextMenu,
            window: view,
          });

    if (args.devtoolsShortcut !== false) {
      const handleInput = (_event: Electron.Event, input: Electron.Input) => {
        if (input.key !== "F12") return;
        if (view.webContents.isDevToolsOpened()) {
          view.webContents.closeDevTools();
        } else {
          view.webContents.openDevTools({ mode: "detach" });
        }
      };
      view.webContents.on("before-input-event", handleInput);
    }

    // `currentWin` reassigns on recreate so layout always targets the
    // live BaseWindow hosting our view.
    let currentWin = win;
    const layout = () => {
      const { width, height } = currentWin.getContentBounds();
      view.setBounds({ x: 0, y: 0, width, height });
    };
    const bindResize = (w: typeof currentWin) => {
      w.on("resize", layout);
      return () => {
        try { w.off("resize", layout); } catch {}
      };
    };
    let unbindResize = bindResize(currentWin);
    layout();

    const unsubscribeRecreate = this.ctx.baseWindow.onRecreate((e) => {
      if (e.windowId !== windowId) return;
      // View has already been reparented onto e.newWin by recreateWindow.
      unbindResize();
      currentWin = e.newWin;
      unbindResize = bindResize(currentWin);
      layout();
    });

    view.webContents.once("destroyed", () => {
      unbindResize();
      unsubscribeRecreate();
      try {
        disposeContextMenu();
      } catch {}
    });

    const url = `${rendererUrl.replace(/\/$/, "")}/index.html${queryString({
      ...args.query,
      wsPort: this.ctx.http.port,
      wsToken: this.ctx.http.authToken,
      windowId,
      // Host's `App.tsx` reads `?route=` and renders
      // `<View name={route} />` when set, otherwise falls through to
      // the default workspace shell.
      route: args.injection,
    })}`;
    // Log the renderer URL on stdout so external tools (agent-browser,
    // curl, devtools attach scripts) can pick it up without grepping.
    const cdpPort = process.env.ZENBU_CDP_PORT;
    console.log(
      `[zenbu] renderer-url window=${label} url=${url}${
        cdpPort ? ` cdp=${cdpPort}` : ""
      }`,
    );
    bootTrace.mark(`renderer-url:${label}`, { url, cdpPort });

    // Trace each renderer-process milestone so the flame surfaces WHICH
    // Electron event is actually gating `loadURL` resolution.
    const evtMark = (name: string) =>
      bootTrace.mark(`webContents:${label}:${name}`);
    view.webContents.once("did-start-loading", () =>
      evtMark("did-start-loading"),
    );
    view.webContents.once("did-stop-loading", () =>
      evtMark("did-stop-loading"),
    );
    view.webContents.once("dom-ready", () => evtMark("dom-ready"));
    view.webContents.once("did-finish-load", () =>
      evtMark("did-finish-load"),
    );
    view.webContents.once(
      "did-frame-finish-load",
      (_e: unknown, isMainFrame: boolean) =>
        evtMark(`did-frame-finish-load(main=${isMainFrame})`),
    );
    // Resolve on `dom-ready` of the main frame: this fires once per
    // navigation, *after* the main frame's DOM is parsed, but *before*
    // the page `load` event waits on every subresource (including nested
    // injected component subtrees that haven't yet rendered). We let
    // Electron's loadURL keep running in the background and just don't
    // await it.
    await bootTrace.span(
      `openWindow:loadURL(${label})`,
      () =>
        new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            view.webContents.off("dom-ready", onReady);
            view.webContents.off("did-fail-load", onFail);
            view.webContents.off("destroyed", onDestroyed);
          };
          const onReady = () => {
            cleanup();
            resolve();
          };
          const onFail = (
            _e: unknown,
            errCode: number,
            errDesc: string,
            _url: string,
            isMainFrame: boolean,
          ) => {
            if (!isMainFrame) return;
            cleanup();
            reject(new Error(`loadURL failed (${errCode}): ${errDesc}`));
          };
          const onDestroyed = () => {
            cleanup();
            reject(new Error("webContents was destroyed while loading"));
          };
          view.webContents.once("dom-ready", onReady);
          view.webContents.on("did-fail-load", onFail);
          view.webContents.once("destroyed", onDestroyed);
          // Kick off the navigation; ignore the full-load promise.
          view.webContents.loadURL(url).catch(() => {});
        }),
      { url },
    );

    // Evict any boot leftovers (splash from setup-gate, installing view
    // from launcher) now that the renderer is dom-ready and painting on
    // top. Leaving them attached leaks a renderer process and unions their
    // drag rects into the window — e.g. a full-width splash drag strip
    // overrides `no-drag` carve-outs in the renderer's title bar.
    for (const child of [...win.contentView.children]) {
      if (child === view) continue;
      try {
        win.contentView.removeChildView(child);
      } catch {}
      const wc = (child as { webContents?: WebContents }).webContents;
      try {
        wc?.close();
      } catch {}
    }

    this.mounted.set(windowId, {
      windowId,
      injection: args.injection ?? null,
      view,
      disposeContextMenu,
    });
    // currentWin, not win, in case recreate fired during loadURL.
    if (!currentWin.isVisible()) currentWin.show();
    currentWin.focus();
    log.verbose(`mounted "${label}" in window "${windowId}"`);

    return { windowId };
  }

  async closeWindow(args: { windowId: string }): Promise<void> {
    const windowId = args.windowId;
    const existing = this.mounted.get(windowId);
    if (existing) {
      const win = this.ctx.baseWindow.windows.get(windowId);
      try {
        win?.contentView.removeChildView(existing.view);
      } catch {}
      try {
        existing.disposeContextMenu();
      } catch {}
      existing.view.webContents.close();
      this.mounted.delete(windowId);
    }
    const win = this.ctx.baseWindow.windows.get(windowId);
    if (win && !win.isDestroyed()) {
      try {
        win.close();
      } catch {}
    }
  }

  async focusWindow(windowId: string): Promise<{ ok: true }> {
    const win = this.ctx.baseWindow.windows.get(windowId);
    if (win && !win.isDestroyed()) {
      if (!win.isVisible()) win.show();
      win.focus();
    }
    return { ok: true };
  }

  async pickFiles(): Promise<string[] | null> {
    const focusedWin = [...this.ctx.baseWindow.windows.values()].find((win) =>
      win.isFocused(),
    );
    const result = await dialog.showOpenDialog({
      ...(focusedWin ? { window: focusedWin } : {}),
      properties: ["openFile", "multiSelections"],
      title: "Choose Files",
    } as OpenDialogOptions);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths;
  }

  async pickDirectory(): Promise<string | null> {
    const focusedWin = [...this.ctx.baseWindow.windows.values()].find((win) =>
      win.isFocused(),
    );
    const result = await dialog.showOpenDialog({
      ...(focusedWin ? { window: focusedWin } : {}),
      properties: ["openDirectory", "createDirectory"],
      title: "Choose Directory",
    } as OpenDialogOptions);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0]!;
  }

  async openExternal(url: string): Promise<void> {
    await shell.openExternal(url);
  }

  /**
   * Spawn a fresh instance of the running host with extra flags.
   *
   * Used by tooling plugins that want to "test in a clean copy of
   * the app" — e.g. `plugin-dev`'s **Run in Dev** button, which
   * appends `--plugin=<manifest>` so the user's in-progress plugin
   * loads alongside the configured set.
   *
   * The framework owns the spawn primitive (not the caller) for
   * three reasons:
   *
   *  1. **Mode-agnostic**: `BOOT_EXEC_PATH` + `BOOT_ARGV` were
   *     captured at boot and give us the right command in dev
   *     and in production without callers having to branch.
   *  2. **Isolation**: a naive `spawn(process.execPath, argv)`
   *     deadlocks on Electron's `SingletonLock` and corrupts the
   *     parent's kyju DB because both processes hammer the same
   *     `userDataDir` / DB path. With `isolateUserData: true` we
   *     mint a per-run tmpdir, pass `--user-data-dir=<tmp>` so
   *     Electron is happy, and pass `--zen-db-path=<tmp>/db` so
   *     the framework's existing DB-path flag points the child at
   *     a sandbox. (See `shared/db-registry.ts#resolveDbPath`.)
   *  3. **Argv hygiene**: we strip prior `--plugin=` /
   *     `--user-data-dir=` / `--zen-db-path=` flags from the
   *     parent's argv before re-applying them, so respawning a
   *     respawned instance doesn't accumulate them.
   *
   * Returns the raw `ChildProcess`. The caller is responsible for
   * wiring stdio (the default is `["ignore", "pipe", "pipe"]` so
   * stdout / stderr stream back), reaping on exit, and converting
   * failures into user-visible state.
   */
  respawnSelf(args: {
    /** Extra argv appended after the parent's boot argv. The
     * caller is responsible for the value; the framework strips
     * known overrides (see above) before re-application. */
    extraArgv?: ReadonlyArray<string>;
    /** Extra env merged on top of `process.env`. */
    extraEnv?: NodeJS.ProcessEnv;
    /** Working directory for the child. Defaults to the parent's
     * cwd, which in practice is the project root. */
    cwd?: string;
    /** When true, the child gets its own `--user-data-dir` and
     * `--zen-db-path` pointing at a freshly-created tmpdir, so
     * the two instances don't fight over Electron's singleton
     * lock or kyju's DB lock. */
    isolateUserData?: boolean;
    /** Override stdio. Defaults to capturing stdout / stderr. */
    stdio?: "pipe" | "inherit" | "ignore";
    /** Pre-position the child's main window. Forwarded as
     * `--zen-x` / `--zen-y` / `--zen-width` / `--zen-height` so
     * `BaseWindowService` picks them up on first window creation.
     * Any subset is fine; unspecified dimensions fall through to
     * Electron's defaults. */
    windowBounds?: {
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    };
  } = {}): {
    child: ChildProcess;
    execPath: string;
    argv: string[];
    sandboxDir: string | null;
  } {
    const stripPrefixes = [
      "--plugin=",
      "--user-data-dir=",
      "--zen-db-path=",
      "--zen-x=",
      "--zen-y=",
      "--zen-width=",
      "--zen-height=",
    ];
    const base = BOOT_ARGV.filter(
      (a) => !stripPrefixes.some((p) => a.startsWith(p)),
    );

    let sandboxDir: string | null = null;
    const isolationArgv: string[] = [];
    if (args.isolateUserData) {
      sandboxDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "zenbu-respawn-"),
      );
      const userData = path.join(sandboxDir, "user-data");
      const dbPath = path.join(sandboxDir, "db");
      fs.mkdirSync(userData, { recursive: true });
      fs.mkdirSync(dbPath, { recursive: true });
      isolationArgv.push(
        `--user-data-dir=${userData}`,
        `--zen-db-path=${dbPath}`,
      );
    }

    const windowArgv: string[] = [];
    if (args.windowBounds) {
      const { x, y, width, height } = args.windowBounds;
      if (x !== undefined) windowArgv.push(`--zen-x=${x}`);
      if (y !== undefined) windowArgv.push(`--zen-y=${y}`);
      if (width !== undefined) windowArgv.push(`--zen-width=${width}`);
      if (height !== undefined) windowArgv.push(`--zen-height=${height}`);
    }

    const argv = [
      ...base,
      ...isolationArgv,
      ...windowArgv,
      ...(args.extraArgv ?? []),
    ];

    const stdio = args.stdio ?? "pipe";
    const stdioConfig: Array<"ignore" | "pipe" | "inherit"> =
      stdio === "pipe"
        ? ["ignore", "pipe", "pipe"]
        : stdio === "inherit"
          ? ["ignore", "inherit", "inherit"]
          : ["ignore", "ignore", "ignore"];

    const child = spawn(BOOT_EXEC_PATH, argv, {
      cwd: args.cwd ?? process.cwd(),
      env: { ...process.env, ...(args.extraEnv ?? {}) },
      stdio: stdioConfig,
      // Don't `detached: true`: we want the OS to keep the child
      // associated with the parent so the user's `Cmd+Q` /
      // workspace teardown reaps the dev instance. Callers that
      // want a true background process can set
      // `child.unref()` themselves after the spawn returns.
    });

    log.verbose(
      `respawnSelf pid=${child.pid ?? "?"} sandbox=${
        sandboxDir ?? "none"
      } argv=${argv.join(" ")}`,
    );

    return { child, execPath: BOOT_EXEC_PATH, argv, sandboxDir };
  }

  async openPath(filePath: string): Promise<void> {
    await shell.openPath(filePath);
  }

  copyToClipboard(text: string): void {
    clipboard.writeText(text);
  }
}

runtime.register(WindowService, import.meta);

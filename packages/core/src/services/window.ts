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
import { URLSearchParams } from "node:url";
import { runtime, Service } from "../runtime";
import { BaseWindowService, MAIN_WINDOW_ID } from "./base-window";
import { ViewRegistryService } from "./view-registry";
import { HttpService } from "./http";
import { RendererHostService } from "./renderer-host";
import { createLogger } from "../shared/log";
import { entrypointBgColor } from "../shared/zenbu-bg";
import { bootTrace } from "../boot-trace";

const log = createLogger("window");

type MountedView = {
  windowId: string;
  type: string;
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
    viewRegistry: ViewRegistryService,
    http: HttpService,
    rendererHost: RendererHostService,
  },
}) {
  private mounted = new Map<string, MountedView>();

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

    // Re-open the entrypoint when the user clicks the dock / taskbar icon
    // with no windows open. Electron emits `activate` on every focus
    // (dock click on macOS, taskbar reactivation on Win/Linux), so we
    // gate on "no live BaseWindow currently exists" — otherwise an
    // already-running app would spawn a duplicate window every time the
    // user tabs back in.
    //
    // The entrypoint view type is the framework-registered alias
    // `"entrypoint"` (see RendererHostService) — a synthetic view over
    // the project's `uiEntrypoint` directory, not anything the user
    // plugin tracks. This is purely "open the canonical entrypoint", no
    // last-value bookkeeping.
    this.setup("activate-reopens-entrypoint", () => {
      const onActivate = () => {
        if (this.ctx.baseWindow.windows.size > 0) return;
        this.openView({ type: "entrypoint" }).catch((err) => {
          log.error("activate-reopens-entrypoint: openView failed:", err);
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

  async openView(args: {
    type: string;
    windowId?: string;
    query?: Record<string, string | number | boolean | null | undefined>;

    baseWindow?: BaseWindowConstructorOptions;
    webContentsView?: WebContentsViewConstructorOptions;
    backgroundColor?: string;
    contextMenu?: false | Parameters<typeof electronContextMenu>[0];
    devtoolsShortcut?: boolean;
  }): Promise<{ windowId: string }> {
    return bootTrace.span(`openView(${args.type})`, () =>
      this.openViewImpl(args),
    );
  }

  private async openViewImpl(args: {
    type: string;
    windowId?: string;
    query?: Record<string, string | number | boolean | null | undefined>;
    baseWindow?: BaseWindowConstructorOptions;
    webContentsView?: WebContentsViewConstructorOptions;
    backgroundColor?: string;
    contextMenu?: false | Parameters<typeof electronContextMenu>[0];
    devtoolsShortcut?: boolean;
  }): Promise<{ windowId: string }> {
    const entry = this.ctx.viewRegistry.get(args.type);
    if (!entry) throw new Error(`No registered view for type "${args.type}"`);

    const windowId = args.windowId ?? MAIN_WINDOW_ID;
    let win = this.ctx.baseWindow.windows.get(windowId);
    if (!win) {
      win = this.ctx.baseWindow.createWindow({
        windowId,
        baseWindow: args.baseWindow,
      }).win;
    }

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
    // the framework's iframes are debuggable out of the box.
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

    const layout = () => {
      const { width, height } = win.getContentBounds();
      view.setBounds({ x: 0, y: 0, width, height });
    };
    layout();
    win.on("resize", layout);
    view.webContents.once("destroyed", () => {
      win.off("resize", layout);
      try {
        disposeContextMenu();
      } catch {}
    });

    const url = `${entry.url.replace(/\/$/, "")}/index.html${queryString({
      ...args.query,
      wsPort: this.ctx.http.port,
      wsToken: this.ctx.http.authToken,
      windowId,
      // The advice/content-script prelude reads `?type=` to pick which
      // registrations apply to this iframe (mirrors how Chrome extensions
      // match content scripts to URLs).
      type: args.type,
    })}`;
    // Always log the renderer URL on stdout so external tooling
    // (agent-browser, curl, devtools attach scripts) can pick it up
    // without grepping debug noise. The CDP port (if any) is logged
    // alongside so an automation agent can `agent-browser connect <port>`
    // and immediately know which renderer to drive.
    const cdpPort = process.env.ZENBU_CDP_PORT;
    console.log(
      `[zenbu] renderer-url type=${args.type} url=${url}${
        cdpPort ? ` cdp=${cdpPort}` : ""
      }`,
    );
    bootTrace.mark(`renderer-url:${args.type}`, { url, cdpPort });

    // Trace each renderer-process milestone so the flame surfaces WHICH
    // Electron event is actually gating `loadURL` resolution.
    const evtMark = (name: string) =>
      bootTrace.mark(`webContents:${args.type}:${name}`);
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
    // <View> iframes loading their own bundles). On cold boot, child
    // Vite servers may not even be up yet — making the page load event
    // gate the splash swap stalls first paint by 1-2s for no user-visible
    // benefit. We let Electron's loadURL keep running in the background
    // and just don't await it.
    await bootTrace.span(
      `openView:loadURL(${args.type})`,
      () =>
        new Promise<void>((resolve, reject) => {
          const onReady = () => {
            view.webContents.off("did-fail-load", onFail);
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
            view.webContents.off("dom-ready", onReady);
            reject(new Error(`loadURL failed (${errCode}): ${errDesc}`));
          };
          view.webContents.once("dom-ready", onReady);
          view.webContents.on("did-fail-load", onFail);
          // Kick off the navigation; ignore the full-load promise.
          view.webContents.loadURL(url).catch(() => {});
        }),
      { url },
    );

    this.mounted.set(windowId, {
      windowId,
      type: args.type,
      view,
      disposeContextMenu,
    });
    if (!win.isVisible()) win.show();
    win.focus();
    log.verbose(`mounted "${args.type}" in window "${windowId}"`);

    return { windowId };
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

  async openPath(filePath: string): Promise<void> {
    await shell.openPath(filePath);
  }

  copyToClipboard(text: string): void {
    clipboard.writeText(text);
  }
}

runtime.register(WindowService, import.meta);

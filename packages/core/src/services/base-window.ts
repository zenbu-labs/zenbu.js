import { BaseWindow, nativeTheme, type BaseWindowConstructorOptions } from "electron"
import { nanoid } from "nanoid"
import { Service, runtime } from "../runtime"
import { createLogger } from "../shared/log"
import { entrypointBgColor } from "../shared/zenbu-bg"
import { DbService } from "./db"

const log = createLogger("base-window")

export const MAIN_WINDOW_ID = "main"
type BootWindow = { windowId: string; win: BaseWindow }

export class BaseWindowService extends Service.create({
  key: "baseWindow",
  deps: { db: DbService },
}) {
  windows = new Map<string, BaseWindow>()
  // The kernel shell spawns a BaseWindow with a loading view before plugin
  // evaluation starts, then publishes it here. On first `evaluate` we adopt
  // it instead of creating a new window, so the launch feels instantaneous
  // and the loading view can be swapped for the orchestrator view in-place.
  private get bootWindows(): BootWindow[] { return (globalThis as any).__zenbu_boot_windows__ ?? [] }
  private set bootWindows(v: BootWindow[]) { (globalThis as any).__zenbu_boot_windows__ = v }

  private getZenWidth(): number | undefined {
    return readIntArg("--zen-width=")
  }
  private getZenHeight(): number | undefined {
    return readIntArg("--zen-height=")
  }
  private getZenX(): number | undefined {
    return readIntArg("--zen-x=")
  }
  private getZenY(): number | undefined {
    return readIntArg("--zen-y=")
  }

  getWindowId(win: BaseWindow): string | undefined {
    for (const [id, w] of this.windows) {
      if (w === win) return id
    }
    return undefined
  }

  createWindow(opts?: {
    windowId?: string
    baseWindow?: BaseWindowConstructorOptions
  }): { win: BaseWindow; windowId: string } {
    const windowId = opts?.windowId ?? nanoid()
    // `--zen-x` / `--zen-y` / `--zen-width` / `--zen-height` let a
    // parent process pre-position a spawned child instance. Used by
    // `WindowService.respawnSelf` so the dev-test window doesn't
    // open exactly on top of the parent. `undefined` falls through
    // to Electron's default behaviour (last-known bounds or OS
    // centering).
    const cliX = this.getZenX()
    const cliY = this.getZenY()
    const defaults: BaseWindowConstructorOptions = {
      width: this.getZenWidth() ?? 1100,
      height: this.getZenHeight() ?? 750,
      ...(cliX !== undefined ? { x: cliX } : {}),
      ...(cliY !== undefined ? { y: cliY } : {}),
      show: true,
      titleBarStyle: "hidden",
      // Traffic lights sit on top of our 36px orchestrator title bar.
      // macOS draws each light at 12×12 px, so centering vertically:
      //   y = (36 - 12) / 2 = 12
      // x mirrors macOS Finder/Safari (~20 px inset from window edge).
      trafficLightPosition: { x: 14, y: 10 },
      // Mirror whatever color the renderer's `index.html` declares via
      // `<meta name="zenbu-bg">`. Without this, the window paints
      // `#F4F4F4` for the few frames between BaseWindow creation and
      // the WebContentsView's first paint — visible as a white flash
      // on dark-themed apps.
      backgroundColor: entrypointBgColor(),
    }
    const win = new BaseWindow({ ...defaults, ...opts?.baseWindow })
    this.windows.set(windowId, win)
    win.on("closed", () => this.windows.delete(windowId))
    return { win, windowId }
  }

  evaluate() {
    if (this.windows.size === 0) {
      if (this.bootWindows.length > 0) {
        for (const boot of this.bootWindows) {
          this.windows.set(boot.windowId, boot.win)
          boot.win.on("closed", () => this.windows.delete(boot.windowId))
        }
        this.bootWindows = []
      } else {
        const prefs = this.ctx.db.client.readRoot().core.windowPrefs
        this.createWindow({
          windowId: MAIN_WINDOW_ID,
          baseWindow: { ...prefs[MAIN_WINDOW_ID]?.lastKnownBounds },
        })
      }
    }

    // Re-paint every BaseWindow's pre-render `backgroundColor` when the OS
    // theme flips. The renderer's CSS adapts on its own via
    // `prefers-color-scheme`; this keeps the window edges (visible during
    // resize / around rounded corners / for the few frames before a new
    // WebContentsView paints) in lockstep with whatever theme the
    // entrypoint's `<meta name="zenbu-bg">` declares for that mode.
    this.setup("native-theme-sync", () => {
      const onUpdated = (): void => {
        const color = entrypointBgColor()
        for (const win of this.windows.values()) {
          try {
            win.setBackgroundColor(color)
          } catch {}
        }
      }
      nativeTheme.on("updated", onUpdated)
      return () => {
        nativeTheme.removeListener("updated", onUpdated)
      }
    })

    this.setup("window-cleanup", () => {
      return () => {
        const snapshot = [...this.windows.entries()].map(([windowId, win]) => ({
          windowId,
          bounds: win.getBounds(),
        }))
        void this.ctx.db.client.update((root) => {
          const next = { ...root.core.windowPrefs }
          for (const { windowId, bounds } of snapshot) {
            next[windowId] = { ...next[windowId], lastKnownBounds: bounds }
          }
          root.core.windowPrefs = next
        })
        for (const win of this.windows.values()) {
          (win as any).__zenbu_on_close = null;
          (win as any).__zenbu_on_closed = null;
          win.close()
        }
        this.windows.clear()
      }
    })
    // 

    log.verbose(`ready (${this.windows.size} windows)`)
  }
}

function readIntArg(prefix: string): number | undefined {
  const flag = process.argv.find((a) => a.startsWith(prefix))
  if (!flag) return undefined
  const n = parseInt(flag.slice(prefix.length), 10)
  return Number.isNaN(n) ? undefined : n
}

runtime.register(BaseWindowService, import.meta)

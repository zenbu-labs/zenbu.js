import { BaseWindow, nativeTheme, type BaseWindowConstructorOptions } from "electron"
import { nanoid } from "nanoid"
import { Service, runtime } from "../runtime"
import { createLogger } from "../shared/log"
import { entrypointBgColor } from "../shared/zenbu-bg"
import { DbService } from "./db"

const log = createLogger("base-window")

export const MAIN_WINDOW_ID = "main"
type BootWindow = { windowId: string; win: BaseWindow }

// Reconcile tables. PATCHABLE: has a runtime setter. IMMUTABLE: constructor-only;
// changing requires recreate. width/height/x/y intentionally omitted from
// PATCHABLE — they're user state after construction.
type Applier = (win: BaseWindow, all: BaseWindowConstructorOptions) => void

const PATCHABLE_APPLIERS: Partial<Record<keyof BaseWindowConstructorOptions, Applier>> = {
  // min/max size pair through one setter; both keys dispatch the merged pair.
  minWidth: (win, all) => {
    win.setMinimumSize(all.minWidth ?? 0, all.minHeight ?? 0)
  },
  minHeight: (win, all) => {
    win.setMinimumSize(all.minWidth ?? 0, all.minHeight ?? 0)
  },
  maxWidth: (win, all) => {
    win.setMaximumSize(all.maxWidth ?? 0, all.maxHeight ?? 0)
  },
  maxHeight: (win, all) => {
    win.setMaximumSize(all.maxWidth ?? 0, all.maxHeight ?? 0)
  },
  resizable: (win, all) => win.setResizable(all.resizable as boolean),
  movable: (win, all) => win.setMovable(all.movable as boolean),
  closable: (win, all) => win.setClosable(all.closable as boolean),
  minimizable: (win, all) => win.setMinimizable(all.minimizable as boolean),
  maximizable: (win, all) => win.setMaximizable(all.maximizable as boolean),
  fullscreenable: (win, all) => win.setFullScreenable(all.fullscreenable as boolean),
  alwaysOnTop: (win, all) => win.setAlwaysOnTop(all.alwaysOnTop as boolean),
  skipTaskbar: (win, all) => win.setSkipTaskbar(all.skipTaskbar as boolean),
  opacity: (win, all) => win.setOpacity(all.opacity as number),
  title: (win, all) => win.setTitle(all.title as string),
  backgroundColor: (win, all) => win.setBackgroundColor(all.backgroundColor as string),
  trafficLightPosition: (win, all) => {
    const pos = all.trafficLightPosition
    if (pos) {
      try {
        win.setWindowButtonPosition(pos)
      } catch {
        // Non-macOS platforms throw; harmless.
      }
    }
  },
  // Note: visibleOnAllWorkspaces is a runtime property only, not in
  // BaseWindowConstructorOptions, so no reconcile key exists for it.
  kiosk: (win, all) => win.setKiosk(all.kiosk as boolean),
  fullscreen: (win, all) => win.setFullScreen(all.fullscreen as boolean),
  simpleFullscreen: (win, all) => win.setSimpleFullScreen(all.simpleFullscreen as boolean),
}

const IMMUTABLE_KEYS = new Set<keyof BaseWindowConstructorOptions>([
  "frame",
  "transparent",
  "titleBarStyle",
  "titleBarOverlay",
  "hasShadow",
  "useContentSize",
  "type",
  "parent",
  "modal",
  "acceptFirstMouse",
  "disableAutoHideCursor",
  "autoHideMenuBar",
  "enableLargerThanScreen",
  "vibrancy",
  "backgroundMaterial",
  "visualEffectState",
  "tabbingIdentifier",
  "roundedCorners",
  "thickFrame",
  "show",
  "focusable",
  // Note: `webPreferences` and `paintWhenInitiallyHidden` are on
  // BrowserWindowConstructorOptions, not BaseWindowConstructorOptions —
  // and BrowserWindow's webContents are managed separately as children.
])

// Baseline for windows adopted from `__zenbu_boot_windows__`. Keep in
// sync with the constructor calls in launcher.ts / setup-gate.ts. Only
// immutable values matter here — patchable ones reconcile naturally.
const LAUNCHER_ADOPTED_BASELINE: BaseWindowConstructorOptions = {
  titleBarStyle: "hidden",
  trafficLightPosition: { x: 14, y: 10 },
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a !== "object" || typeof b !== "object") return false
  const ak = Object.keys(a as object)
  const bk = Object.keys(b as object)
  if (ak.length !== bk.length) return false
  for (const k of ak) {
    if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false
  }
  return true
}

export type WindowRecreateEvent = {
  windowId: string
  oldWin: BaseWindow
  newWin: BaseWindow
  reason: { changedKeys: (keyof BaseWindowConstructorOptions)[] }
}

export class BaseWindowService extends Service.create({
  key: "baseWindow",
  deps: { db: DbService },
}) {
  windows = new Map<string, BaseWindow>()
  // Tracks the options each window was constructed with so `ensureWindow`
  // can diff patchable vs immutable changes.
  private optionsByWindow = new Map<string, BaseWindowConstructorOptions>()
  private recreateListeners = new Set<(e: WindowRecreateEvent) => void>()

  // The kernel shell spawns a BaseWindow with a loading view before plugin
  // evaluation starts, then publishes it here. On first `evaluate` we adopt
  // it instead of creating a new window, so the launch feels instantaneous
  // and the loading view can be swapped for the orchestrator view in-place.
  private get bootWindows(): BootWindow[] { return (globalThis as any).__zenbu_boot_windows__ ?? [] }
  private set bootWindows(v: BootWindow[]) { (globalThis as any).__zenbu_boot_windows__ = v }

  private getZenWidth(): number | undefined {
    const flag = process.argv.find((a) => a.startsWith("--zen-width="))
    if (!flag) return undefined
    const n = parseInt(flag.slice("--zen-width=".length), 10)
    return isNaN(n) ? undefined : n
  }

  getWindowId(win: BaseWindow): string | undefined {
    for (const [id, w] of this.windows) {
      if (w === win) return id
    }
    return undefined
  }

  /** Subscribe to recreate events so window-scoped listeners can rebind. */
  onRecreate(fn: (e: WindowRecreateEvent) => void): () => void {
    this.recreateListeners.add(fn)
    return () => this.recreateListeners.delete(fn)
  }

  createWindow(opts?: {
    windowId?: string
    baseWindow?: BaseWindowConstructorOptions
  }): { win: BaseWindow; windowId: string } {
    const windowId = opts?.windowId ?? nanoid()
    const defaults: BaseWindowConstructorOptions = {
      width: this.getZenWidth() ?? 1100,
      height: 750,
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
    const merged: BaseWindowConstructorOptions = { ...defaults, ...opts?.baseWindow }
    const win = new BaseWindow(merged)
    this.windows.set(windowId, win)
    this.optionsByWindow.set(windowId, merged)
    win.on("closed", () => {
      // Guard against recreate: we swap the map entry to `newWin` before
      // closing `win`, so this handler must not evict the new entry.
      if (this.windows.get(windowId) === win) {
        this.windows.delete(windowId)
        this.optionsByWindow.delete(windowId)
      }
    })
    return { win, windowId }
  }

  /**
   * Get-or-create a BaseWindow for `windowId`, reconciling options against
   * what it was built with. Patchable diffs apply via setters; immutable
   * diffs trigger a recreate that reparents children. `recreated: true`
   * flags the latter so callers can rebind window-scoped listeners.
   */
  ensureWindow(opts: {
    windowId?: string
    baseWindow?: BaseWindowConstructorOptions
  }): { win: BaseWindow; windowId: string; recreated: boolean } {
    const windowId = opts.windowId ?? nanoid()
    const requested = opts.baseWindow ?? {}
    const existing = this.windows.get(windowId)
    if (!existing) {
      const created = this.createWindow({ windowId, baseWindow: requested })
      return { ...created, recreated: false }
    }

    const current = this.optionsByWindow.get(windowId) ?? {}

    // Only keys present in `requested` are diffed — unspecified options
    // stay at whatever the constructor picked.
    const immutableChanged: (keyof BaseWindowConstructorOptions)[] = []
    for (const key of Object.keys(requested) as (keyof BaseWindowConstructorOptions)[]) {
      if (!IMMUTABLE_KEYS.has(key)) continue
      if (!shallowEqual(requested[key], current[key])) {
        immutableChanged.push(key)
      }
    }

    if (immutableChanged.length > 0) {
      const newWin = this.recreateWindow({
        windowId,
        oldWin: existing,
        current,
        requested,
        changedKeys: immutableChanged,
      })
      return { win: newWin, windowId, recreated: true }
    }

    // No immutable diff — patch in place.
    const merged: BaseWindowConstructorOptions = { ...current, ...requested }
    this.applyPatchable(existing, requested, merged)
    this.optionsByWindow.set(windowId, merged)
    return { win: existing, windowId, recreated: false }
  }

  private applyPatchable(
    win: BaseWindow,
    requested: BaseWindowConstructorOptions,
    merged: BaseWindowConstructorOptions,
  ): void {
    // Paired setters (setMinimumSize for minWidth+minHeight) must run once,
    // not per key.
    const ran = new Set<Applier>()
    for (const key of Object.keys(requested) as (keyof BaseWindowConstructorOptions)[]) {
      const applier = PATCHABLE_APPLIERS[key]
      if (!applier || ran.has(applier)) continue
      ran.add(applier)
      try {
        applier(win, merged)
      } catch (err) {
        log.error(`applyPatchable: ${String(key)} failed:`, err)
      }
    }
  }

  /**
   * Tear down `oldWin`, build a new BaseWindow with merged options, and
   * reparent its children. Children must be detached before close —
   * otherwise Electron destroys their `webContents` (and the renderer).
   */
  private recreateWindow(args: {
    windowId: string
    oldWin: BaseWindow
    current: BaseWindowConstructorOptions
    requested: BaseWindowConstructorOptions
    changedKeys: (keyof BaseWindowConstructorOptions)[]
  }): BaseWindow {
    const { windowId, oldWin, current, requested, changedKeys } = args
    log.verbose(
      `recreating "${windowId}" due to immutable option change: ${changedKeys.join(", ")}`,
    )

    // Snapshot state to carry across construction.
    const bounds = oldWin.getBounds()
    let wasFullScreen = false
    let wasMaximized = false
    let wasFocused = false
    try {
      wasFullScreen = oldWin.isFullScreen()
    } catch {}
    try {
      wasMaximized = oldWin.isMaximized()
    } catch {}
    try {
      wasFocused = oldWin.isFocused()
    } catch {}
    const children = [...oldWin.contentView.children]

    // Detach children before close so their webContents survive.
    for (const child of children) {
      try {
        oldWin.contentView.removeChildView(child)
      } catch (err) {
        log.error("recreateWindow: removeChildView failed:", err)
      }
    }

    const mergedConstructorOpts: BaseWindowConstructorOptions = {
      ...current,
      ...requested,
      // Preserve current geometry across recreate.
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    }
    const newWin = new BaseWindow(mergedConstructorOpts)

    // Swap the map entry before closing old so lookups by id hit newWin.
    this.windows.set(windowId, newWin)
    this.optionsByWindow.set(windowId, mergedConstructorOpts)
    newWin.on("closed", () => {
      if (this.windows.get(windowId) === newWin) {
        this.windows.delete(windowId)
        this.optionsByWindow.delete(windowId)
      }
    })

    // Reparent children. Layout is re-applied by subscribers on the
    // recreate event (e.g. WindowService rebinding resize → layout).
    for (const child of children) {
      try {
        newWin.contentView.addChildView(child)
      } catch (err) {
        log.error("recreateWindow: addChildView failed:", err)
      }
    }

    // Restore state that doesn't survive construction.
    if (wasMaximized) {
      try {
        newWin.maximize()
      } catch {}
    }
    if (wasFullScreen) {
      try {
        newWin.setFullScreen(true)
      } catch {}
    }
    if (wasFocused) {
      try {
        newWin.focus()
      } catch {}
    }

    // Close old. Map guard above already covers the eviction race, but
    // null out the bookkeeping hooks for belt-and-suspenders.
    ;(oldWin as any).__zenbu_on_close = null
    ;(oldWin as any).__zenbu_on_closed = null
    try {
      oldWin.close()
    } catch (err) {
      log.error("recreateWindow: oldWin.close failed:", err)
    }

    // Notify subscribers so they can rebind listeners tied to oldWin.
    const event: WindowRecreateEvent = {
      windowId,
      oldWin,
      newWin,
      reason: { changedKeys },
    }
    for (const fn of this.recreateListeners) {
      try {
        fn(event)
      } catch (err) {
        log.error("recreate listener failed:", err)
      }
    }

    return newWin
  }

  evaluate() {
    if (this.windows.size === 0) {
      if (this.bootWindows.length > 0) {
        for (const boot of this.bootWindows) {
          this.windows.set(boot.windowId, boot.win)
          // Best-effort baseline; if a plugin later disagrees on an
          // immutable, ensureWindow recreates once on first declare.
          this.optionsByWindow.set(boot.windowId, { ...LAUNCHER_ADOPTED_BASELINE })
          const captured = boot
          boot.win.on("closed", () => {
            if (this.windows.get(captured.windowId) === captured.win) {
              this.windows.delete(captured.windowId)
              this.optionsByWindow.delete(captured.windowId)
            }
          })
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
        this.optionsByWindow.clear()
      }
    })

    log.verbose(`ready (${this.windows.size} windows)`)
  }
}

runtime.register(BaseWindowService, import.meta)

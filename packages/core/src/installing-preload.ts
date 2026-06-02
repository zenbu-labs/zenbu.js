/**
 * Built-in preload script for the production launcher's `installing.html`
 * window. Compiled to CJS via tsdown (`dist/installing-preload.cjs`) and
 * staged into the .app's `Resources/` by `zen build:electron`. Sandboxed
 * preloads MUST be CommonJS — Electron disables ESM in sandboxed contexts.
 *
 * Exposes `window.zenbuInstall` to the page:
 *
 *   const off = window.zenbuInstall.on("step", (p) => { ... })
 *   window.zenbuInstall.off("step", cb)
 *   window.zenbuInstall.relaunch()   // restart the app from scratch
 *
 * `relaunch()` exists for the case where the cold-boot install/clone hangs:
 * the page can show a "Restart to launch" button after a timeout and call
 * this to fully relaunch the Electron app (app.relaunch + app.exit).
 *
 * Events emitted by the launcher (channel name `zenbu:install:<event>`):
 *
 *   - "step":     { id: "clone" | "fetch" | "install" | "handoff", label: string }
 *   - "message":  { text: string }
 *   - "progress": { phase?: string, loaded?: number, total?: number, ratio?: number }
 *   - "done":     { id: same as step }
 *   - "error":    { id?: string, message: string }
 *
 * The exposed API is intentionally tiny — no privileged Node access, no
 * arbitrary IPC channels. The page can only listen to the five fixed
 * event names above.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

type InstallEvent = "step" | "message" | "progress" | "done" | "error";
type Listener = (payload: unknown) => void;

const VALID_EVENTS: ReadonlySet<InstallEvent> = new Set([
  "step",
  "message",
  "progress",
  "done",
  "error",
]);

// Track wrappers so .off() can remove the same `ipcRenderer` listener that
// .on() installed. The page passes us its own user-callback; we wrap it
// for ipcRenderer (which gets `(event, payload)`), so the user-callback
// alone isn't a key into ipcRenderer's listener table.
const wrappers = new WeakMap<Listener, (event: IpcRendererEvent, payload: unknown) => void>();

function channelFor(event: InstallEvent): string {
  return `zenbu:install:${event}`;
}

contextBridge.exposeInMainWorld("zenbuInstall", {
  on(event: InstallEvent, cb: Listener): () => void {
    if (!VALID_EVENTS.has(event) || typeof cb !== "function") {
      return () => {};
    }
    const wrapper = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
    wrappers.set(cb, wrapper);
    ipcRenderer.on(channelFor(event), wrapper);
    return () => {
      const w = wrappers.get(cb);
      if (w) {
        ipcRenderer.off(channelFor(event), w);
        wrappers.delete(cb);
      }
    };
  },
  off(event: InstallEvent, cb: Listener): void {
    if (!VALID_EVENTS.has(event) || typeof cb !== "function") return;
    const wrapper = wrappers.get(cb);
    if (wrapper) {
      ipcRenderer.off(channelFor(event), wrapper);
      wrappers.delete(cb);
    }
  },
  relaunch(): void {
    ipcRenderer.send("zenbu:install:relaunch");
  },
});

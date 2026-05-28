import { app, BaseWindow, WebContentsView } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as git from "isomorphic-git";

import { runtime } from "../runtime";
import { createLogger } from "./log";
import {
  type PackageManagerSpec,
  depsSignature,
  runInstall,
  writeDepsSig,
} from "./pm-install";

const log = createLogger("plugin-update-supervisor");

// Resolved at module load time so we can locate the framework-shipped
// `installing-preload.cjs` regardless of how the package is consumed
// (link:, node_modules, packaged Resources). The preload exposes the
// same `window.zenbuInstall` API used by the cold-boot installer so
// `installing.html` and `updating.html` can share one preload script
// (same five-event API surface) while staying separate HTML files.
const SUPERVISOR_DIR = path.dirname(fileURLToPath(import.meta.url));

export type PluginUpdatePhase =
  | "closing"
  | "shutdown"
  | "git"
  | "install"
  | "relaunch";

export interface PluginUpdatePlan {
  repoPath: string;
  branch: string;
  remoteRef: string;
  targetCommit: string;
  dependenciesChanged: boolean;
  packageManager: PackageManagerSpec;
  resourcesPath: string | null;
  /**
   * Absolute path to `updating.html` to show during the update. When
   * provided, the supervisor opens a BaseWindow loading this file BEFORE
   * destroying the app's existing windows, and routes phase / failure
   * events to it via IPC (the framework-shipped `installing-preload.cjs`,
   * which exposes `window.zenbuInstall`).
   *
   * When omitted (or the file doesn't exist) the supervisor still runs
   * the update but does so without any visible UI.
   *
   * Naming: this is intentionally `updating.html`, NOT `installing.html`
   * — the cold-boot launcher uses installing.html for first-launch clone
   * + install, this file is the *in-app update* counterpart. Keeping the
   * filenames distinct lets the two flows diverge visually (e.g. the
   * install screen is splash-sized because it hands off to the splash;
   * the update screen is a small modal-feeling window).
   */
  updatingHtml?: string | null;
}

interface PendingPluginUpdate {
  status: "applying" | "done";
  plan: PluginUpdatePlan;
  updatedAt: string;
}

export interface PluginUpdateReporter {
  phase?(phase: PluginUpdatePhase, message?: string): void;
  failed?(phase: PluginUpdatePhase, message: string): void;
}

type LoadingEvent = "step" | "message" | "progress" | "done" | "error";

interface UpdatingWindow {
  win: BaseWindow;
  send(event: LoadingEvent, payload: unknown): void;
  /**
   * Best-effort close. Used on the success path right before relaunch.
   * On failure we *keep* the window open so the user can read the error.
   */
  close(): void;
}

function resolveInstallingPreload(resourcesPath: string | null): string | null {
  // 1. Production: staged into Resources/ next to the .app at build time.
  if (resourcesPath) {
    const staged = path.join(resourcesPath, "installing-preload.cjs");
    if (fs.existsSync(staged)) return staged;
  }
  // 2. Dev / link: shipped inside @zenbujs/core's dist alongside this module.
  const sibling = path.join(SUPERVISOR_DIR, "installing-preload.cjs");
  if (fs.existsSync(sibling)) return sibling;
  // 3. Walk up looking for `dist/installing-preload.cjs`. Bundlers may put
  //    `plugin-update-supervisor` into a chunk file at the dist root, in
  //    which case (2) already matched. This handles the case where the
  //    chunk lands in a subdir.
  let dir = SUPERVISOR_DIR;
  for (let i = 0; i < 5; i += 1) {
    const candidate = path.join(dir, "installing-preload.cjs");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function openUpdatingWindow(
  htmlPath: string,
  preloadPath: string,
): Promise<UpdatingWindow> {
  // Small modal-feeling window. The auto-updater only shows a single
  // shimmering label (and an error block on failure), so it doesn't need
  // splash-sized real estate. Resizable + minimizable stay off so the
  // window can't be hidden behind something while the update runs.
  const win = new BaseWindow({
    width: 320,
    height: 220,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 10, y: 8 },
    backgroundColor: "#f4f4f4",
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
    if (win.isDestroyed()) return;
    const { width, height } = win.getContentBounds();
    view.setBounds({ x: 0, y: 0, width, height });
  };
  layout();
  win.on("resize", layout);

  // Buffer events emitted before did-finish-load — the first phase event
  // can fire before the preload has wired up its listeners.
  let ready = false;
  const pending: Array<{ event: LoadingEvent; payload: unknown }> = [];
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
    log.error(`updating.html did-fail-load: ${desc}`);
    pending.length = 0;
    ready = true;
  });

  // Fire and forget — we don't want to block the update on the renderer.
  void view.webContents.loadFile(htmlPath).catch((err) => {
    log.error(
      `updating.html loadFile failed: ${(err as Error).message ?? err}`,
    );
  });

  return {
    win,
    send(event, payload) {
      if (!ready) {
        pending.push({ event, payload });
        return;
      }
      try {
        if (view.webContents.isDestroyed()) return;
        view.webContents.send(`zenbu:install:${event}`, payload);
      } catch {}
    },
    close() {
      try {
        if (!win.isDestroyed()) win.destroy();
      } catch {}
    },
  };
}

const PENDING_FILE = path.join(
  os.homedir(),
  ".zenbu",
  ".internal",
  "pending-plugin-update.json",
);

export function pendingPluginUpdatePath(): string {
  return PENDING_FILE;
}

async function writePending(
  plan: PluginUpdatePlan,
  status: PendingPluginUpdate["status"],
): Promise<void> {
  await fsp.mkdir(path.dirname(PENDING_FILE), { recursive: true });
  const payload: PendingPluginUpdate = {
    status,
    plan,
    updatedAt: new Date().toISOString(),
  };
  await fsp.writeFile(PENDING_FILE, JSON.stringify(payload, null, 2) + "\n");
}

async function clearPending(): Promise<void> {
  await fsp.rm(PENDING_FILE, { force: true });
}

function emit(
  reporter: PluginUpdateReporter | undefined,
  phase: PluginUpdatePhase,
  message?: string,
): void {
  log.verbose(`${phase}${message ? `: ${message}` : ""}`);
  reporter?.phase?.(phase, message);
}

function systemInstallArgs(pm: PackageManagerSpec): {
  bin: string;
  args: string[];
} {
  switch (pm.type) {
    case "pnpm":
      return { bin: "pnpm", args: ["install", "--prefer-offline"] };
    case "npm":
      return { bin: "npm", args: ["install", "--no-audit", "--no-fund"] };
    case "yarn":
      return { bin: "yarn", args: ["install"] };
    case "bun":
      return { bin: "bun", args: ["install"] };
  }
}

function runSystemInstall(
  repoPath: string,
  pm: PackageManagerSpec,
): Promise<void> {
  const { bin, args } = systemInstallArgs(pm);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: repoPath,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${bin} ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function installDeps(plan: PluginUpdatePlan): Promise<void> {
  if (plan.resourcesPath) {
    await runInstall({
      appsDir: plan.repoPath,
      resourcesPath: plan.resourcesPath,
      pm: plan.packageManager,
    });
  } else {
    // Dev fallback. Production always has `resourcesPath`; local dev can
    // still test the updater by relying on the package manager on PATH.
    await runSystemInstall(plan.repoPath, plan.packageManager);
  }
  const sig = await depsSignature(plan.repoPath, plan.packageManager);
  await writeDepsSig(plan.repoPath, sig);
}

/**
 * Take over the process and apply a plugin repo update.
 *
 * The returned promise never resolves in the success case because the
 * process relaunches. It may reject only before relaunch (for example if
 * git refuses the fast-forward or install fails).
 *
 * About the reporter: the supplied `reporter` is called for every phase
 * transition AND for failure. Note that we call `runtime.shutdown()`
 * early in this function, which tears down the service runtime — anything
 * the reporter touches must therefore not depend on services (rpc, db,
 * window manager, etc). The supervisor itself manages an `updating.html`
 * BaseWindow opened outside the runtime; that window receives mirrored
 * phase / failure events via IPC and is what the user sees during the
 * blackout between window close and relaunch.
 */
export async function takeOverPluginRepoUpdate(
  plan: PluginUpdatePlan,
  reporter?: PluginUpdateReporter,
): Promise<never> {
  await writePending(plan, "applying");

  // Open the updating window FIRST, before destroying any other windows.
  // If we opened it after closing the existing windows, macOS would
  // briefly show no app-owned windows and the app could drop focus /
  // hide. Opening first also gives the renderer a head start on loading
  // the asset so the user sees something within ~1 frame of clicking.
  let updating: UpdatingWindow | null = null;
  if (plan.updatingHtml && fs.existsSync(plan.updatingHtml)) {
    const preloadPath = resolveInstallingPreload(plan.resourcesPath);
    if (preloadPath) {
      try {
        updating = await openUpdatingWindow(plan.updatingHtml, preloadPath);
      } catch (err) {
        log.error(
          `failed to open updating window: ${(err as Error).message ?? err}`,
        );
      }
    } else {
      log.error(
        "updating.html provided but installing-preload.cjs could not be located; skipping window",
      );
    }
  }

  // Reporter facade: the *caller's* reporter is called for phase /
  // failure transitions, AND every event is mirrored to the updating
  // window over IPC. We keep the caller's reporter in a try/catch
  // because the most common consumer (PluginUpdaterService) emits via
  // rpc — which throws after `runtime.shutdown()`. Swallowing the
  // post-shutdown rpc error here is intentional: the updating window is
  // the surface we actually care about once the runtime is gone.
  const report = {
    phase(phase: PluginUpdatePhase, message?: string): void {
      log.verbose(`${phase}${message ? `: ${message}` : ""}`);
      try {
        reporter?.phase?.(phase, message);
      } catch (err) {
        log.verbose(
          `reporter.phase threw (likely runtime is down): ${(err as Error).message ?? err}`,
        );
      }
      updating?.send("step", { id: phase, label: message ?? phase });
      if (message) updating?.send("message", { text: message });
    },
    failed(phase: PluginUpdatePhase | "check", message: string): void {
      log.error(`failed during ${phase}: ${message}`);
      try {
        // The reporter's `failed` type only allows PluginUpdatePhase. The
        // "check" variant is owned by the caller (UpdateCheck error path)
        // and never reaches this function.
        reporter?.failed?.(phase as PluginUpdatePhase, message);
      } catch (err) {
        log.verbose(
          `reporter.failed threw (likely runtime is down): ${(err as Error).message ?? err}`,
        );
      }
      updating?.send("error", { id: phase, message });
    },
  };

  let currentPhase: PluginUpdatePhase = "closing";
  try {
    report.phase(currentPhase, "Closing windows");
    const updatingWin = updating?.win ?? null;
    for (const win of BaseWindow.getAllWindows()) {
      // Keep the updating window open so the user has a surface to look
      // at and so failure messages have somewhere to render.
      if (updatingWin && win === updatingWin) continue;
      try {
        win.destroy();
      } catch {}
    }

    currentPhase = "shutdown";
    report.phase(currentPhase, "Stopping service runtime");
    // After this point ANY call into the service runtime (including the
    // caller's RPC-backed reporter) will throw. `report.phase` / `report.failed`
    // tolerate that — but don't add raw `reporter?.phase?.(...)` calls
    // here.
    await runtime.shutdown();

    currentPhase = "git";
    report.phase(
      currentPhase,
      `Fast-forwarding ${path.basename(
        plan.repoPath,
      )} to ${plan.targetCommit.slice(0, 7)}`,
    );
    // Two-step apply:
    //   1. `git.merge({ fastForwardOnly: true })` advances the branch ref.
    //      This validates the FF (refuses on divergence) but DOES NOT
    //      touch the working tree or the index.
    //   2. `git.checkout({ force: true })` then materializes the new
    //      tree on disk + rewrites the index to match.
    //
    // Without step 2, HEAD points at the new commit but the files on
    // disk are still pre-merge. The next launch then runs the OLD
    // plugin source under the NEW commit id, and the very next
    // `checkRepo()` flags every changed file as "dirty" — because
    // the working tree now disagrees with HEAD — which blocks every
    // subsequent update until the user manually resets.
    await git.merge({
      fs,
      dir: plan.repoPath,
      ours: plan.branch,
      theirs: plan.targetCommit,
      fastForwardOnly: true,
      abortOnConflict: true,
    });
    await git.checkout({
      fs,
      dir: plan.repoPath,
      ref: plan.branch,
      force: true,
    });

    if (plan.dependenciesChanged) {
      currentPhase = "install";
      report.phase(currentPhase, "Installing dependencies");
      await installDeps(plan);
    }

    await writePending(plan, "done");
    await clearPending();

    currentPhase = "relaunch";
    report.phase(currentPhase, "Relaunching");
    // The updating window dies with the process on `app.exit`. We don't
    // explicitly close it first: if relaunch fails for some bizarre
    // reason the user still has a window on screen.
    app.relaunch();
    app.exit(0);
    return await new Promise<never>(() => undefined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    report.failed(currentPhase, message);
    // Intentionally DO NOT call `app.exit` here. The updating window
    // stays up displaying the error so the user (and the developer
    // debugging across machines) can read what actually went wrong.
    // The next user action — Quit from the updating window, or a hard
    // kill — tears down the rest.
    throw err;
  }
}

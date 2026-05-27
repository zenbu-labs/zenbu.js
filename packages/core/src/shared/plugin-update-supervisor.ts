import { app, BaseWindow } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
 */
export async function takeOverPluginRepoUpdate(
  plan: PluginUpdatePlan,
  reporter?: PluginUpdateReporter,
): Promise<never> {
  await writePending(plan, "applying");

  let currentPhase: PluginUpdatePhase = "closing";
  try {
    emit(reporter, currentPhase, "Closing windows");
    for (const win of BaseWindow.getAllWindows()) {
      try {
        win.destroy();
      } catch {}
    }

    currentPhase = "shutdown";
    emit(reporter, currentPhase, "Stopping service runtime");
    await runtime.shutdown();

    currentPhase = "git";
    emit(
      reporter,
      currentPhase,
      `Fast-forwarding ${path.basename(
        plan.repoPath,
      )} to ${plan.targetCommit.slice(0, 7)}`,
    );
    // Use merge rather than checkout so the current local branch advances.
    // `fastForwardOnly` keeps the destructive phase simple and safe; callers
    // must surface diverged/conflicting states from the check phase instead.
    await git.merge({
      fs,
      dir: plan.repoPath,
      ours: plan.branch,
      theirs: plan.targetCommit,
      fastForwardOnly: true,
      abortOnConflict: true,
    });

    if (plan.dependenciesChanged) {
      currentPhase = "install";
      emit(reporter, currentPhase, "Installing dependencies");
      await installDeps(plan);
    }

    await writePending(plan, "done");
    await clearPending();

    currentPhase = "relaunch";
    emit(reporter, currentPhase, "Relaunching");
    app.relaunch();
    app.exit(0);
    return await new Promise<never>(() => undefined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reporter?.failed?.(currentPhase, message);
    log.error(`failed during ${currentPhase}: ${message}`);
    throw err;
  }
}

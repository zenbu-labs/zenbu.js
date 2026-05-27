import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { getPlugins, type PluginRecord } from "../runtime";

export type LockfileName =
  | "pnpm-lock.yaml"
  | "package-lock.json"
  | "yarn.lock"
  | "bun.lock";

export type PluginRepoKind = "core" | "external";

const LOCKFILES: LockfileName[] = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
];

/** Plugin entry inside a repo. */
export interface PluginInRepo {
  name: string;
  /** Absolute plugin dir (the one with `zenbu.plugin.ts`). */
  dir: string;
}

/** A discovered plugin repo. */
export interface PluginRepo {
  /** Absolute path to the repo root (the dir containing `.git`). */
  path: string;
  /** Stable, UI-friendly group label. */
  displayName: string;
  /** Which concept this repo belongs to. */
  kind: PluginRepoKind;
  /** All installed plugins whose `dir` lives under this repo. */
  plugins: PluginInRepo[];
  /**
   * The lockfile sitting at the repo root, if any. We only consider a
   * single root lockfile — workspaces with per-package lockfiles are
   * unusual and we'd misdetect "deps changed". The common case (pnpm
   * monorepo with a root `pnpm-lock.yaml`) works.
   */
  lockfile: LockfileName | null;
}

/** Absolute path of the per-user plugins directory. */
export function pluginsHome(): string {
  return path.join(os.homedir(), ".zenbu", "plugins");
}

/**
 * Best-effort running app repo root. In dev this is the project cwd. In a
 * bundled app the launcher appends `--project=<appsDir>` before handing off.
 */
export function appProjectRoot(): string {
  const flag = process.argv.find((arg) => arg.startsWith("--project="));
  const start = flag ? flag.slice("--project=".length) : process.cwd();
  let dir = path.resolve(start);
  for (let i = 0; i < 12; i += 1) {
    if (fs.existsSync(path.join(dir, "zenbu.config.ts"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

/**
 * Walk up from `start` until we hit a directory containing `.git`.
 * If `stopAt` is provided, we refuse to walk above it.
 */
export function findGitRoot(start: string, stopAt?: string): string | null {
  let cur = path.resolve(start);
  const stop = stopAt ? path.resolve(stopAt) : null;
  while (true) {
    if (fs.existsSync(path.join(cur, ".git"))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    if (stop) {
      if (cur === stop) return null;
      if (!cur.startsWith(stop + path.sep) && cur !== stop) return null;
    }
    cur = parent;
  }
}

/** Pick the first lockfile present in `dir`, in priority order. */
export function detectLockfile(dir: string): LockfileName | null {
  for (const name of LOCKFILES) {
    if (fs.existsSync(path.join(dir, name))) return name;
  }
  return null;
}

function createRepo(
  root: string,
  kind: PluginRepoKind,
  plugin: PluginInRepo,
): PluginRepo {
  return {
    path: root,
    displayName: kind === "core" ? "Core plugins" : path.basename(root),
    kind,
    plugins: [plugin],
    lockfile: detectLockfile(root),
  };
}

/**
 * Enumerate every plugin currently in the runtime's plugin registry and
 * group them by their backing git repo.
 *
 * Core plugins are the plugins that live under `<project>/plugins/*`; they
 * become one repo group named "Core plugins". External plugins are repos
 * under `~/.zenbu/plugins/*` and are grouped by their own git root.
 */
export function listPluginRepos(): PluginRepo[] {
  const home = pluginsHome();
  const projectRoot = appProjectRoot();
  const projectPluginsDir = path.join(projectRoot, "plugins");
  const byRoot = new Map<string, PluginRepo>();

  for (const plugin of getPlugins()) {
    if (plugin.name === "core") continue;

    let kind: PluginRepoKind | null = null;
    let stopAt: string | undefined;
    if (insideDir(plugin.dir, projectPluginsDir)) {
      kind = "core";
      stopAt = projectRoot;
    } else if (insideDir(plugin.dir, home)) {
      kind = "external";
      stopAt = home;
    }
    if (!kind) continue;

    const root = findGitRoot(plugin.dir, stopAt);
    if (!root) continue;
    const entry: PluginInRepo = { name: plugin.name, dir: plugin.dir };
    const existing = byRoot.get(root);
    if (existing) {
      existing.plugins.push(entry);
    } else {
      byRoot.set(root, createRepo(root, kind, entry));
    }
  }

  return sortRepos([...byRoot.values()]);
}

/**
 * Same shape as `listPluginRepos` but scans `~/.zenbu/plugins` directly
 * instead of going through the runtime registry. Used by the recovery path
 * on boot, which runs before `registerPlugin()` calls have been replayed.
 */
export async function listPluginReposFromDisk(): Promise<PluginRepo[]> {
  const home = pluginsHome();
  let names: string[];
  try {
    names = await fsp.readdir(home);
  } catch {
    return [];
  }
  const byRoot = new Map<string, PluginRepo>();
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const dir = path.join(home, name);
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (
      !fs.existsSync(path.join(dir, "zenbu.plugin.ts")) &&
      !fs.existsSync(path.join(dir, "zenbu.plugin.js"))
    ) {
      continue;
    }
    const root = findGitRoot(dir, home);
    if (!root) continue;
    const entry: PluginInRepo = { name, dir };
    const existing = byRoot.get(root);
    if (existing) {
      existing.plugins.push(entry);
    } else {
      byRoot.set(root, createRepo(root, "external", entry));
    }
  }
  return sortRepos([...byRoot.values()]);
}

function insideDir(dir: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(dir));
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function sortRepos(repos: PluginRepo[]): PluginRepo[] {
  for (const repo of repos) {
    repo.plugins.sort((a, b) => a.name.localeCompare(b.name));
  }
  return repos.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "core" ? -1 : 1;
    return (
      a.displayName.localeCompare(b.displayName) || a.path.localeCompare(b.path)
    );
  });
}

/** Convenience: find one repo by absolute root path. */
export function findRepo(
  repos: PluginRepo[],
  repoPath: string,
): PluginRepo | null {
  const target = path.resolve(repoPath);
  return repos.find((r) => path.resolve(r.path) === target) ?? null;
}

export type { PluginRecord };

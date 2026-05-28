/**
 * High-level plugin updater service.
 *
 * This composes the thin `UpdaterService` / isomorphic-git primitives into
 * repo-scoped operations suitable for UI:
 *
 *   listRepos()  — enumerate installed plugin repos
 *   checkRepo()  — fetch + compute ahead/behind/conflicts/deps drift
 *   checkAll()   — check every repo
 *   applyRepo()  — one-shot handoff to the supervisor; never resolves
 */

import fs from "node:fs"
import path from "node:path"
import * as git from "isomorphic-git"
import type { StatusRow } from "isomorphic-git"
import http from "isomorphic-git/http/node"

import { Service, runtime, getAppEntrypoint } from "../runtime"
import { createLogger } from "../shared/log"
import {
  detectLockfile,
  findRepo,
  listPluginRepos,
  type LockfileName,
  type PluginRepo,
} from "../shared/plugin-repos"
import {
  type PackageManagerSpec,
} from "../shared/pm-install"
import {
  takeOverPluginRepoUpdate,
  type PluginUpdatePhase,
  type PluginUpdatePlan,
} from "../shared/plugin-update-supervisor"
import { RpcService } from "./rpc"
import { UpdaterService, type AppContext } from "./updater"

const log = createLogger("plugin-updater")

const FALLBACK_PM: PackageManagerSpec = { type: "pnpm", version: "10.13.1" }

export interface PluginRepoRef extends PluginRepo {
  branch: string | null
  remote: string | null
  remoteUrl: string | null
  head: string | null
}

export type UpdateCheck =
  | { kind: "up-to-date"; repo: PluginRepoRef }
  | {
      kind: "available"
      repo: PluginRepoRef
      target: string
      remoteRef: string
      behind: number
      ahead: number
      canFastForward: boolean
      conflicts: string[]
      dirtyFiles: string[]
      dependenciesChanged: boolean
      lockfile: LockfileName | null
    }
  | { kind: "error"; repo: PluginRepoRef; message: string }

interface RemoteInfo {
  branch: string
  remote: string
  remoteBranch: string
  remoteRef: string
  remoteUrl: string | null
  head: string
}

type PackageJson = {
  packageManager?: string
}

function normalizeHttpRemoteUrl(url: string | null): string | null {
  if (!url) return null
  if (url.startsWith("http://") || url.startsWith("https://")) return url

  const scpLike = url.match(/^git@([^:]+):(.+)$/)
  if (scpLike) return `https://${scpLike[1]}/${scpLike[2]}`

  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "ssh:") return url
    return `https://${parsed.host}${parsed.pathname}`
  } catch {
    return url
  }
}

type EmitCore = {
  core: {
    pluginUpdater: {
      checked: (payload: { result: UpdateCheck }) => void
      applying: (payload: {
        repoPath: string
        phase: PluginUpdatePhase
        message?: string
      }) => void
      failed: (payload: {
        repoPath: string
        phase: PluginUpdatePhase | "check"
        message: string
      }) => void
    }
  }
}

function parsePackageManager(value: string | undefined): PackageManagerSpec | null {
  if (!value) return null
  const at = value.lastIndexOf("@")
  if (at <= 0 || at === value.length - 1) return null
  const type = value.slice(0, at)
  const version = value.slice(at + 1)
  if (type === "pnpm" || type === "npm" || type === "yarn" || type === "bun") {
    return { type, version }
  }
  return null
}

/**
 * Resolve the absolute path of the `updating.html` to show during an in-app
 * plugin update. The supervisor uses it to pop a BaseWindow before tearing
 * the runtime down, so phase / failure events have somewhere to render.
 *
 * Distinct from `installing.html` on purpose: that one is the cold-boot
 * launcher's first-run window (clone + first `pnpm install`); this one is
 * the in-app updater's window (git fast-forward + dep refresh). They share
 * the `installing-preload.cjs` API surface but live in separate HTML files
 * so each flow can present its own copy / sizing.
 *
 * - Production: staged into the .app's Resources/ at build time by
 *   `zen build:electron` when `<uiEntrypoint>/updating.html` exists.
 * - Dev: lives alongside `splash.html` in the project's `uiEntrypoint`
 *   directory — the one returned by `getAppEntrypoint()`.
 *
 * Returns `null` when nothing is found, in which case the supervisor runs
 * without a visible UI (legacy behavior).
 */
function resolveUpdatingHtml(resourcesPath: string | null): string | null {
  if (resourcesPath) {
    const staged = path.join(resourcesPath, "updating.html")
    if (fs.existsSync(staged)) return staged
  }
  const entrypoint = getAppEntrypoint()
  if (entrypoint) {
    const dev = path.join(entrypoint, "updating.html")
    if (fs.existsSync(dev)) return dev
  }
  return null
}

function readPackageManager(repoPath: string, appContext: AppContext | null): PackageManagerSpec {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(repoPath, "package.json"), "utf8"),
    ) as PackageJson
    const parsed = parsePackageManager(pkg.packageManager)
    if (parsed) return parsed
  } catch {}

  const lockfile = detectLockfile(repoPath)
  if (lockfile === "package-lock.json") return { type: "npm", version: "10.0.0" }
  if (lockfile === "yarn.lock") return { type: "yarn", version: "1.22.22" }
  if (lockfile === "bun.lock") return { type: "bun", version: "1.3.0" }

  return appContext?.packageManager ?? FALLBACK_PM
}

function dirtyFilesFromMatrix(matrix: StatusRow[]): string[] {
  const dirty: string[] = []
  for (const row of matrix) {
    const [filepath, head, workdir, stage] = row
    if (head === workdir && workdir === stage) continue
    dirty.push(filepath)
  }
  return dirty
}

async function currentRemoteInfo(repoPath: string): Promise<RemoteInfo> {
  const branch = await git.currentBranch({ fs, dir: repoPath, fullname: false })
  if (!branch) throw new Error("Repository is in detached HEAD state.")

  const remote =
    (await git.getConfig({ fs, dir: repoPath, path: `branch.${branch}.remote` })) ??
    "origin"
  const mergeRef = await git.getConfig({
    fs,
    dir: repoPath,
    path: `branch.${branch}.merge`,
  })
  const remoteBranch = mergeRef?.startsWith("refs/heads/")
    ? mergeRef.slice("refs/heads/".length)
    : branch
  const remoteRef = `refs/remotes/${remote}/${remoteBranch}`
  const remoteUrl =
    (await git.getConfig({ fs, dir: repoPath, path: `remote.${remote}.url` })) ??
    null
  const head = await git.resolveRef({ fs, dir: repoPath, ref: "HEAD" })
  return { branch, remote, remoteBranch, remoteRef, remoteUrl, head }
}

async function repoRef(repo: PluginRepo): Promise<PluginRepoRef> {
  try {
    const info = await currentRemoteInfo(repo.path)
    return {
      ...repo,
      branch: info.branch,
      remote: info.remote,
      remoteUrl: info.remoteUrl,
      head: info.head,
    }
  } catch {
    return { ...repo, branch: null, remote: null, remoteUrl: null, head: null }
  }
}

async function readBlobOrNull(
  repoPath: string,
  oid: string,
  filepath: string,
): Promise<Uint8Array | null> {
  try {
    const result = await git.readBlob({ fs, dir: repoPath, oid, filepath })
    return result.blob
  } catch {
    return null
  }
}

function bytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

async function dependencyFilesChanged(args: {
  repoPath: string
  head: string
  target: string
}): Promise<{ changed: boolean; lockfile: LockfileName | null }> {
  const files: Array<"package.json" | LockfileName> = [
    "package.json",
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "bun.lock",
  ]
  let lockfile: LockfileName | null = null
  let changed = false
  for (const file of files) {
    const before = await readBlobOrNull(args.repoPath, args.head, file)
    const after = await readBlobOrNull(args.repoPath, args.target, file)
    if (!bytesEqual(before, after)) {
      changed = true
      if (file !== "package.json") lockfile = file
    }
  }
  return { changed, lockfile }
}

async function countSince(repoPath: string, ref: string, stop: string): Promise<number> {
  const commits = await git.log({ fs, dir: repoPath, ref })
  const index = commits.findIndex((commit) => commit.oid === stop)
  return index >= 0 ? index : commits.length
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

type ConflictErrorShape = {
  data?: {
    filepaths?: unknown
    conflicts?: unknown
  }
  message?: string
}

function conflictPathsFromError(err: unknown): string[] {
  const shaped = err as ConflictErrorShape
  const filepaths = shaped.data?.filepaths
  if (Array.isArray(filepaths)) {
    return filepaths.filter((v): v is string => typeof v === "string")
  }
  const conflicts = shaped.data?.conflicts
  if (Array.isArray(conflicts)) {
    return conflicts.filter((v): v is string => typeof v === "string")
  }
  return [shaped.message ?? errorMessage(err)]
}

async function probeConflicts(args: {
  repoPath: string
  head: string
  target: string
  base: string | null
  dirtyFiles: string[]
}): Promise<string[]> {
  if (args.dirtyFiles.length > 0) return args.dirtyFiles
  if (!args.base) return ["<unrelated histories>"]
  if (args.base === args.head) return []

  try {
    await git.merge({
      fs,
      dir: args.repoPath,
      ours: args.head,
      theirs: args.target,
      dryRun: true,
      noUpdateBranch: true,
      abortOnConflict: true,
    })
    return []
  } catch (err) {
    return conflictPathsFromError(err)
  }
}

export class PluginUpdaterService extends Service.create({
  key: "pluginUpdater",
  deps: { rpc: RpcService, updater: UpdaterService },
}) {
  evaluate(): void {
    log.verbose("plugin updater service ready")
  }

  async listRepos(): Promise<PluginRepoRef[]> {
    const repos = listPluginRepos()
    return Promise.all(repos.map((repo) => repoRef(repo)))
  }

  async checkAll(): Promise<UpdateCheck[]> {
    const repos = listPluginRepos()
    return Promise.all(repos.map((repo) => this.checkRepo({ path: repo.path })))
  }

  async checkRepo(args: { path: string }): Promise<UpdateCheck> {
    const repo = findRepo(listPluginRepos(), args.path)
    if (!repo) {
      const fallback: PluginRepoRef = {
        path: path.resolve(args.path),
        displayName: path.basename(path.resolve(args.path)),
        kind: "external",
        plugins: [],
        lockfile: null,
        branch: null,
        remote: null,
        remoteUrl: null,
        head: null,
      }
      return { kind: "error", repo: fallback, message: "Not an installed plugin repo." }
    }

    const ref = await repoRef(repo)
    try {
      const info = await currentRemoteInfo(repo.path)
      await git.fetch({
        fs,
        http,
        dir: repo.path,
        remote: info.remote,
        url: normalizeHttpRemoteUrl(info.remoteUrl) ?? info.remoteUrl ?? undefined,
        ref: info.remoteBranch,
        singleBranch: true,
        tags: false,
      })
      const target = await git.resolveRef({ fs, dir: repo.path, ref: info.remoteRef })
      const nextRef: PluginRepoRef = { ...ref, head: info.head }
      if (target === info.head) {
        const result: UpdateCheck = { kind: "up-to-date", repo: nextRef }
        this.emitChecked(result)
        return result
      }

      const bases = await git.findMergeBase({
        fs,
        dir: repo.path,
        oids: [info.head, target],
      })
      const base = bases[0] ?? null
      const matrix = await git.statusMatrix({ fs, dir: repo.path })
      const dirtyFiles = dirtyFilesFromMatrix(matrix)
      const dependencies = await dependencyFilesChanged({
        repoPath: repo.path,
        head: info.head,
        target,
      })
      const conflicts = await probeConflicts({
        repoPath: repo.path,
        head: info.head,
        target,
        base,
        dirtyFiles,
      })
      const behind = base ? await countSince(repo.path, target, base) : 0
      const ahead = base ? await countSince(repo.path, info.head, base) : 0
      const canFastForward = base === info.head && dirtyFiles.length === 0

      const result: UpdateCheck = {
        kind: "available",
        repo: nextRef,
        target,
        remoteRef: info.remoteRef,
        behind,
        ahead,
        canFastForward,
        conflicts,
        dirtyFiles,
        dependenciesChanged: dependencies.changed,
        lockfile: dependencies.lockfile ?? repo.lockfile,
      }
      this.emitChecked(result)
      return result
    } catch (err) {
      const result: UpdateCheck = {
        kind: "error",
        repo: ref,
        message: errorMessage(err),
      }
      this.emitChecked(result)
      this.emitFailed(repo.path, "check", result.message)
      return result
    }
  }

  async applyRepo(args: {
    path: string
    targetCommit?: string
    requireFastForward?: boolean
  }): Promise<never> {
    const check = await this.checkRepo({ path: args.path })
    if (check.kind !== "available") {
      throw new Error(check.kind === "up-to-date" ? "Repo is already up to date." : check.message)
    }
    if ((args.requireFastForward ?? true) && !check.canFastForward) {
      throw new Error("Update cannot fast-forward cleanly. Resolve conflicts before updating.")
    }
    if (check.conflicts.length > 0) {
      throw new Error(`Update has conflicts: ${check.conflicts.join(", ")}`)
    }

    const appContext = await this.ctx.updater.getAppContext()
    const plan: PluginUpdatePlan = {
      repoPath: check.repo.path,
      branch: check.repo.branch ?? "main",
      remoteRef: check.remoteRef,
      targetCommit: args.targetCommit ?? check.target,
      dependenciesChanged: check.dependenciesChanged,
      packageManager: readPackageManager(check.repo.path, appContext),
      resourcesPath: appContext?.resourcesPath ?? null,
      updatingHtml: resolveUpdatingHtml(appContext?.resourcesPath ?? null),
    }

    return takeOverPluginRepoUpdate(plan, {
      phase: (phase, message) => this.emitApplying(plan.repoPath, phase, message),
      failed: (phase, message) => this.emitFailed(plan.repoPath, phase, message),
    })
  }

  private emitChecked(result: UpdateCheck): void {
    const emit = this.ctx.rpc.emit as unknown as EmitCore
    emit.core.pluginUpdater.checked({ result })
  }

  private emitApplying(
    repoPath: string,
    phase: PluginUpdatePhase,
    message?: string,
  ): void {
    const emit = this.ctx.rpc.emit as unknown as EmitCore
    emit.core.pluginUpdater.applying({ repoPath, phase, message })
  }

  private emitFailed(
    repoPath: string,
    phase: PluginUpdatePhase | "check",
    message: string,
  ): void {
    const emit = this.ctx.rpc.emit as unknown as EmitCore
    emit.core.pluginUpdater.failed({ repoPath, phase, message })
  }
}

runtime.register(PluginUpdaterService, import.meta)

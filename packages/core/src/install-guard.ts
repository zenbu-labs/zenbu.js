/**
 * Hang-guarded child-process spawn for package-manager installs. pnpm
 * sometimes prints its final `Done in X` line but never exits; this helper
 * watches stdout/stderr for that sentinel, arms a grace timer, SIGTERMs the
 * child, and resolves as success. Incidents are logged to
 * `~/.zenbu/.internal/install-incidents.log` and
 * `globalThis.__zenbu_install_incident__`.
 *
 * Plugins shelling out to `pnpm install` should import this directly rather
 * than re-implementing the watchdog.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type InstallPmType = "pnpm" | "npm" | "yarn" | "bun"

export interface GuardedSpawnOptions {
  bin: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  /**
   * Which package manager is being invoked. Today only `"pnpm"` has a
   * post-completion hang sentinel; other PMs get plain spawn semantics
   * (no watchdog) but the same line / raw-line plumbing.
   */
  pmType?: InstallPmType
  /**
   * Override grace ms before we SIGTERM the child after seeing the
   * "Done" sentinel. Defaults to `ZENBU_PM_INSTALL_DONE_GRACE_MS` (env)
   * or 2000ms.
   */
  graceMs?: number
  /**
   * Free-form label used in incident records + the "killing" log line.
   * Defaults to `"<bin> <args>"`.
   */
  label?: string
  /** Per-line callback (already trimmed, blank lines skipped). */
  onLine?: (line: string, which: "stdout" | "stderr") => void
  /** Raw-line callback (one per `\n`, no trim, no skip). */
  onRawLine?: (rawLine: string, which: "stdout" | "stderr") => void
  /**
   * If true and no `onLine` / `onRawLine` is wired, mirror the child's
   * stdout/stderr through to the parent's own stdio so callers that
   * previously used `stdio: "inherit"` keep seeing output.
   */
  passthroughIfUnobserved?: boolean
  signal?: AbortSignal
}

export interface GuardedSpawnResult {
  /** True when the child was killed by our watchdog after the sentinel. */
  shortCircuited: boolean
  /** Total wall-clock from spawn → resolve. */
  durationMs: number
  /** Last ~20 trimmed output lines, useful for incident telemetry. */
  tail: string[]
}

export interface InstallIncidentDetail {
  pmType: InstallPmType
  durationMs: number
  graceMs: number
  cwd: string
  label: string
  reason: "pnpm-hang-after-done"
  tail: string[]
}

const PNPM_DONE_RE = /^Done in .* using pnpm/i
const DEFAULT_GRACE_MS = 2000
const KILL_FORCE_MS = 1000
const TAIL_MAX = 20

/**
 * Append an incident to `~/.zenbu/.internal/install-incidents.log` and
 * stash the latest one on `globalThis.__zenbu_install_incident__`.
 *
 * Safe to call directly if you're implementing your own spawn loop but
 * still want to participate in the shared telemetry stream.
 */
export function recordInstallIncident(detail: InstallIncidentDetail): void {
  const ts = new Date().toISOString()
  const payload = { ts, pid: process.pid, ...detail }
  try {
    const dir = path.join(os.homedir(), ".zenbu", ".internal")
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(
      path.join(dir, "install-incidents.log"),
      JSON.stringify(payload) + "\n",
    )
  } catch {}
  try {
    const slot = globalThis as unknown as {
      __zenbu_install_incident__?: typeof payload
    }
    slot.__zenbu_install_incident__ = payload
  } catch {}
}

/**
 * Spawn a package-manager install command with hang detection.
 *
 * Resolves with `{ shortCircuited: true }` when we detected the pnpm
 * "Done" sentinel and had to kill a hung process. Resolves with
 * `{ shortCircuited: false }` on a normal `code === 0` exit. Rejects
 * on real failures (non-zero exit without sentinel, spawn error,
 * abort).
 */
export function spawnWithInstallHangGuard(
  opts: GuardedSpawnOptions,
): Promise<GuardedSpawnResult> {
  const {
    bin,
    args,
    cwd,
    env,
    pmType,
    onLine,
    onRawLine,
    passthroughIfUnobserved,
    signal,
  } = opts
  const label = opts.label ?? `${bin} ${args.join(" ")}`
  const envGrace = Number(process.env.ZENBU_PM_INSTALL_DONE_GRACE_MS)
  const graceMs =
    opts.graceMs ??
    (Number.isFinite(envGrace) && envGrace > 0 ? envGrace : DEFAULT_GRACE_MS)

  return new Promise<GuardedSpawnResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`${label} aborted before start`))
      return
    }
    // Always pipe stdout/stderr so the sentinel sniffer can see output
    // even when the caller passes no listeners. When nothing is wired
    // and `passthroughIfUnobserved` is true we forward bytes to the
    // parent's own stdio so callers that previously used
    // `stdio: "inherit"` keep their console output.
    const child = spawn(bin, args, {
      cwd,
      stdio: ["inherit", "pipe", "pipe"],
      env,
    })
    const onAbort = (): void => {
      try {
        child.kill("SIGTERM")
      } catch {}
    }
    signal?.addEventListener("abort", onAbort, { once: true })

    const startedAt = Date.now()
    const tail: string[] = []
    let sawDone = false
    let selfKilled = false
    let graceTimer: NodeJS.Timeout | null = null
    let killTimer: NodeJS.Timeout | null = null
    const clearTimers = (): void => {
      if (graceTimer) clearTimeout(graceTimer)
      if (killTimer) clearTimeout(killTimer)
      graceTimer = null
      killTimer = null
    }
    const armWatchdog = (): void => {
      if (sawDone) return
      sawDone = true
      graceTimer = setTimeout(() => {
        selfKilled = true
        try {
          onLine?.(
            `[install] ${label}: pnpm printed "Done" but did not exit within ${graceMs}ms; killing.`,
            "stderr",
          )
        } catch {}
        try {
          child.kill("SIGTERM")
        } catch {}
        killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL")
          } catch {}
        }, KILL_FORCE_MS)
        killTimer.unref?.()
      }, graceMs)
      graceTimer.unref?.()
    }

    const observed = onLine != null || onRawLine != null
    const passthrough = !observed && passthroughIfUnobserved === true
    const wireStream = (
      stream: NodeJS.ReadableStream | null,
      which: "stdout" | "stderr",
    ): void => {
      if (!stream) return
      let buf = ""
      stream.setEncoding("utf8")
      stream.on("data", (chunk: string) => {
        if (passthrough) {
          const target = which === "stdout" ? process.stdout : process.stderr
          try {
            target.write(chunk)
          } catch {}
        }
        buf += chunk
        let nl: number
        while ((nl = buf.indexOf("\n")) >= 0) {
          const rawLine = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          onRawLine?.(rawLine, which)
          const line = rawLine.replace(/\r/g, "").trimEnd()
          if (!line) continue
          if (tail.push(line) > TAIL_MAX) tail.shift()
          onLine?.(line, which)
          if (pmType === "pnpm" && PNPM_DONE_RE.test(line)) armWatchdog()
        }
      })
      stream.on("end", () => {
        if (buf.length > 0) {
          onRawLine?.(buf, which)
          const line = buf.replace(/\r/g, "").trimEnd()
          if (line) {
            if (tail.push(line) > TAIL_MAX) tail.shift()
            onLine?.(line, which)
            if (pmType === "pnpm" && PNPM_DONE_RE.test(line)) armWatchdog()
          }
        }
      })
    }
    wireStream(child.stdout, "stdout")
    wireStream(child.stderr, "stderr")

    child.on("error", (err) => {
      clearTimers()
      signal?.removeEventListener("abort", onAbort)
      reject(err)
    })
    child.on("close", (code, sig) => {
      clearTimers()
      signal?.removeEventListener("abort", onAbort)
      const durationMs = Date.now() - startedAt
      if (selfKilled && sawDone) {
        if (pmType === "pnpm") {
          recordInstallIncident({
            pmType,
            durationMs,
            graceMs,
            cwd,
            label,
            reason: "pnpm-hang-after-done",
            tail: tail.slice(),
          })
        }
        resolve({ shortCircuited: true, durationMs, tail: tail.slice() })
        return
      }
      if (code === 0) {
        resolve({ shortCircuited: false, durationMs, tail: tail.slice() })
        return
      }
      if (signal?.aborted) {
        reject(new Error(`${label} aborted (${sig ?? code})`))
        return
      }
      reject(new Error(`${label} exited with code ${code}`))
    })
  })
}

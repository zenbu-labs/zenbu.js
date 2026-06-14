import { spawn } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import path, { resolve as resolvePath } from "node:path"
import { startLinkWatcher, type LinkWatcherHandle } from "../lib/link-watcher"

type DevArgs = {
  projectDir: string
  detach: boolean
  verbose: boolean
  watch: boolean
}

/**
 * `zen dev` — launch the local app under Electron with the setup-gate as the
 * main entry. This is the entrypoint of `pnpm dev` in scaffolded apps. The
 * command is intentionally hookable: future versions can layer doctor checks,
 * environment validation, or a managed dev-server here without touching the
 * user's `package.json` scripts.
 *
 * Defaults to a foreground/blocking child so Ctrl+C in the terminal kills the
 * Electron process and `pnpm dev` exits cleanly. Pass `--detach` to spawn it
 * in the background instead (returns immediately, Electron lives until quit).
 */
function parseArgs(argv: string[]): DevArgs {
  let pathArg: string | undefined
  let detach = false
  let verbose = false
  let watch = true
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--detach") detach = true
    else if (arg === "--verbose" || arg === "-v") verbose = true
    else if (arg === "--no-watch") watch = false
    else if (!arg.startsWith("-") && pathArg == null) pathArg = arg
    else {
      console.error(`zen dev: unknown flag "${arg}"`)
      console.error(`valid: zen dev [path] [--detach] [--verbose] [--no-watch]`)
      process.exit(1)
    }
  }

  const projectDir = pathArg
    ? resolvePath(process.cwd(), pathArg)
    : process.cwd()

  if (!existsSync(projectDir)) {
    console.error(`zen dev: path "${pathArg}" does not exist`)
    process.exit(1)
  }
  try {
    if (!statSync(projectDir).isDirectory()) {
      console.error(`zen dev: path "${pathArg}" is not a directory`)
      process.exit(1)
    }
  } catch {
    console.error(`zen dev: cannot stat "${pathArg}"`)
    process.exit(1)
  }

  return { projectDir, detach, verbose, watch }
}

function resolveLocalElectron(projectDir: string): string {
  const candidates = [
    path.join(projectDir, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
    path.join(projectDir, "node_modules", "electron", "dist", "electron.exe"),
    path.join(projectDir, "node_modules", ".bin", "electron"),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    `Electron is not installed in ${projectDir}. Run \`pnpm install\` in the app.`,
  )
}

function ensureSetupGate(projectDir: string): void {
  const setupGate = path.join(
    projectDir,
    "node_modules",
    "@zenbujs",
    "core",
    "dist",
    "setup-gate.mjs",
  )
  if (!existsSync(setupGate)) {
    throw new Error(
      `@zenbujs/core setup-gate not found at ${setupGate}. Run \`pnpm install\` in the app.`,
    )
  }
}

export async function runDev(argv: string[]) {
  const { projectDir, detach, verbose, watch } = parseArgs(argv)
  if (verbose) console.error("[zen dev] launching:", projectDir)
  const electron = resolveLocalElectron(projectDir)
  ensureSetupGate(projectDir)

  // Start the link watcher in parallel with Electron so registry types
  // stay fresh while the user edits services / `zenbu.config.ts`. The
  // watcher does an initial blocking link before subscribing, so types
  // are guaranteed up-to-date by the time Electron's main entry runs.
  // `--detach` skips this: detached `pnpm dev` returns immediately and
  // the user's terminal isn't around to host the watcher process.
  let watcher: LinkWatcherHandle | null = null
  if (watch && !detach) {
    try {
      watcher = await startLinkWatcher(projectDir, { verbose })
    } catch (err) {
      // Defensive: if the watcher itself can't even start (e.g.
      // @parcel/watcher native binding mismatch), don't take dev down.
      console.error(
        `[zen dev] link watcher disabled: ${
          err instanceof Error ? err.message : err
        }`,
      )
    }
  }

  // Pass the project directory as the app path. Electron then resolves
  // `package.json#main` from there (which points at
  // `node_modules/@zenbujs/core/dist/setup-gate.mjs`). Passing the
  // setup-gate path directly would make Electron treat its parent dir as
  // the app and break `app.getAppPath()` semantics inside setup-gate.
  const electronArgs = [projectDir, `--project=${projectDir}`]

  // Allow attaching a CDP debugger (e.g. agent-browser, Chrome devtools)
  // by exporting `ZENBU_CDP_PORT=9222`. Forwarded as `--remote-debugging-port`
  // which Electron picks up natively. The port is logged to stdout by
  // setup-gate once the renderer is ready so agents can grab it.
  const cdpPort = process.env.ZENBU_CDP_PORT
  if (cdpPort) {
    electronArgs.push(`--remote-debugging-port=${cdpPort}`)
  }

  if (detach) {
    const child = spawn(electron, electronArgs, {
      cwd: projectDir,
      detached: true,
      stdio: "ignore",
    })
    child.unref()
    return
  }

  const child = spawn(electron, electronArgs, { cwd: projectDir, stdio: "inherit" })
  process.on("SIGINT", () => child.kill("SIGINT"))
  process.on("SIGTERM", () => child.kill("SIGTERM"))
  child.on("exit", async (code, signal) => {
    if (watcher) await watcher.close().catch(() => {})
    process.exit(code ?? (signal ? 1 : 0))
  })
}

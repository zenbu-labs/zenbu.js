import { performance } from "node:perf_hooks"
import {
  createServer,
  type ViteDevServer,
  type Plugin as VitePlugin,
} from "vite"
import { createHash } from "node:crypto"
import path from "node:path"
import fsp from "node:fs/promises"
import { createServer as createNetServer } from "node:net"
import {
  Service,
  runtime,
  getAppEntrypoint,
  subscribeConfig,
} from "../runtime"
import { INTERNAL_DIR } from "../shared/paths"
import { bootTrace } from "../boot-trace"
import { createLogger } from "../shared/log"
import { zenbuVitePlugins } from "../vite-plugins"

const log = createLogger("vite")

// Boot-trace plugin: marks every Vite lifecycle hook + rolls up
// per-request timings so the boot flame surfaces what Vite is
// actually doing.
function bootTraceVitePlugin(): VitePlugin {
  type Counter = {
    count: number
    totalMs: number
    maxMs: number
    maxId: string
    top: Array<{ url: string; ms: number }>
  }
  const requests: Counter = {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    maxId: "",
    top: [],
  }
  const transforms: Counter = {
    count: 0,
    totalMs: 0,
    maxMs: 0,
    maxId: "",
    top: [],
  }
  ;(globalThis as any).__zenbu_vite_stats__ ??= new Map()
  ;(globalThis as any).__zenbu_vite_stats__.set("vite", {
    requests,
    transforms,
  })
  return {
    name: "zenbu-boot-trace-vite",
    enforce: "pre",
    config() {
      bootTrace.mark(`vite:hook:config`)
    },
    configResolved() {
      bootTrace.mark(`vite:hook:configResolved`)
    },
    configureServer(server) {
      bootTrace.mark(`vite:hook:configureServer`)
      const origListen = server.listen.bind(server)
      server.listen = (async (...args: any[]) => {
        return bootTrace.span(`vite:vite-server.listen`, () =>
          origListen(...args),
        )
      }) as any
      server.middlewares.use((req, res, next) => {
        const url = req.url || ""
        if (url.startsWith("/__inspect") || url.startsWith("/@vite/client"))
          return next()
        const t0 = performance.now()
        res.on("finish", () => {
          const dt = performance.now() - t0
          requests.count++
          requests.totalMs += dt
          if (dt > requests.maxMs) {
            requests.maxMs = dt
            requests.maxId = url
          }
          requests.top.push({ url, ms: dt })
          requests.top.sort((a, b) => b.ms - a.ms)
          if (requests.top.length > 10) requests.top.length = 10
        })
        next()
      })
    },
    buildStart() {
      bootTrace.mark(`vite:hook:buildStart`)
    },
  } as VitePlugin
}

function safeCacheSegment(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "entrypoint"
  )
}

function resolveCacheDir(root: string, configFile: string | false): string {
  const hash = createHash("sha256")
    .update(path.resolve(root))
    .update("\0")
    .update(configFile ? path.resolve(configFile) : "no-config")
    .digest("hex")
    .slice(0, 12)
  return path.resolve(
    INTERNAL_DIR,
    "vite-cache",
    `${safeCacheSegment(path.basename(root))}-${hash}`,
  )
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}

function getEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.listen(0, () => {
      const { port } = srv.address() as { port: number }
      srv.close(() => resolve(port))
    })
    srv.on("error", reject)
  })
}

// Walks deepest -> shallowest from `entrypointRoot` up to (and
// including) `projectDir`, returning the first `vite.config.ts`
// found. Bounded by path-segment count.
async function findViteConfigUp(
  entrypointRoot: string,
  projectDir: string,
): Promise<string | false> {
  const rel = path.relative(projectDir, entrypointRoot)
  const escaping = rel.startsWith("..") || path.isAbsolute(rel)
  const segments = escaping || rel === "" ? [] : rel.split(path.sep)
  for (let i = segments.length; i >= 0; i--) {
    const candidate = path.join(
      projectDir,
      ...segments.slice(0, i),
      "vite.config.ts",
    )
    if (await pathExists(candidate)) return candidate
  }
  return false
}

async function startServer(
  entrypointRoot: string,
  configFile: string | false,
): Promise<ViteDevServer> {
  const port = await getEphemeralPort()
  const cacheDir = resolveCacheDir(entrypointRoot, configFile)
  await fsp.mkdir(cacheDir, { recursive: true })

  const sharedConfig = {
    cacheDir,
    server: {
      port,
      strictPort: true,
      hmr: { protocol: "ws", host: "localhost" } as const,
      fs: { strict: false },
    },
    logLevel: "warn" as const,
  }

  // Framework plugins (injection prelude, advice transform) wired in
  // regardless of whether the entrypoint plugin ships a vite.config.
  const frameworkPlugins = zenbuVitePlugins()
  const tracePlugin = bootTraceVitePlugin()

  let server: ViteDevServer
  if (configFile) {
    server = await bootTrace.span(`vite:create-server`, () =>
      createServer({
        ...sharedConfig,
        root: entrypointRoot,
        configFile,
        plugins: [tracePlugin, ...frameworkPlugins],
      }),
    )
  } else {
    const plugins: any[] = [tracePlugin, ...frameworkPlugins]
    try {
      const react = await bootTrace.span(`vite:import-react-plugin`, () =>
        import("@vitejs/plugin-react"),
      )
      plugins.unshift(react.default())
    } catch {}
    server = await bootTrace.span(`vite:create-server`, () =>
      createServer({
        ...sharedConfig,
        root: entrypointRoot,
        plugins,
        configFile: false,
      }),
    )
  }

  await bootTrace.span(`vite:listen`, () => server.listen())

  // HMR client uses the assigned port (not the requested one) when
  // we asked for ephemeral.
  const addr = server.httpServer?.address()
  const assignedPort = typeof addr === "object" && addr ? addr.port : 0
  if (assignedPort) {
    const hmr = server.config.server.hmr
    if (typeof hmr === "object") {
      ;(hmr as any).clientPort = assignedPort
    }
  }

  return server
}

// Resolves once `registerAppEntrypoint(...)` has run (the loader-emitted
// barrel may not have evaluated yet when this service becomes
// eligible). Null after the timeout so callers can surface a real
// error instead of hanging.
function waitForAppEntrypoint(timeoutMs = 30000): Promise<string | null> {
  const immediate = getAppEntrypoint()
  if (immediate) return Promise.resolve(immediate)
  return new Promise((resolve) => {
    let settled = false
    const unsubscribe = subscribeConfig((snapshot) => {
      if (settled) return
      if (snapshot.appEntrypoint) {
        settled = true
        unsubscribe()
        clearTimeout(timer)
        resolve(snapshot.appEntrypoint)
      }
    }, "vite/waitForAppEntrypoint")
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      unsubscribe()
      resolve(getAppEntrypoint())
    }, timeoutMs)
  })
}

/**
 * Owns the single Vite dev server that serves the entrypoint plugin's
 * source files. Exposes `url`, `port`, and the live `viteServer`
 * handle for internal callers (window, http, advice-config).
 *
 * The entrypoint plugin is whichever plugin's directory matches the
 * `uiEntrypoint` field in `zenbu.config.ts`.
 */
export class ViteService extends Service.create({ key: "vite" }) {
  url = ""
  port = 0
  viteServer: ViteDevServer | null = null
  entrypointRoot = ""

  async evaluate() {
    const root = await waitForAppEntrypoint()
    if (!root) {
      throw new Error(
        "[vite] no `uiEntrypoint` registered. Set `uiEntrypoint` in zenbu.config.ts.",
      )
    }
    if (!(await pathExists(root))) {
      throw new Error(`[vite] uiEntrypoint directory does not exist: ${root}.`)
    }
    const configPath = process.env.ZENBU_CONFIG_PATH
    const projectDir = configPath ? path.dirname(configPath) : root
    const configFile = await findViteConfigUp(root, projectDir)

    const server = await startServer(root, configFile)
    const addr = server.httpServer?.address()
    const port = typeof addr === "object" && addr ? addr.port : 5173

    this.viteServer = server
    this.url = `http://localhost:${port}`
    this.port = port
    this.entrypointRoot = root
    log.verbose(`ready at ${this.url}`)

    this.setup("vite-cleanup", () => async () => {
      const s = this.viteServer
      this.viteServer = null
      if (!s) return
      try {
        await s.close()
      } catch (err) {
        // Don't cascade; a thrown close strands chokidar/fsevents
        // watchers and trips napi during V8 teardown.
        log.error("viteServer.close failed:", err)
      }
    })
  }
}

runtime.register(ViteService, import.meta)

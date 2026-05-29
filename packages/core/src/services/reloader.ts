import { performance } from "node:perf_hooks"
import { createServer, type ViteDevServer, type Plugin as VitePlugin } from "vite"
import { bootTrace } from "../boot-trace"

/**
 * Records when each Vite lifecycle hook fires, so the boot-trace flame
 * shows the actual phases inside `createServer` / `listen` / first
 * transform. Each hook emits a 0-duration span at its current
 * timestamp — the rendering logic then surfaces them on the timeline.
 */
function bootTraceVitePlugin(id: string): VitePlugin {
  // Aggregate per-request timing so the flame doesn't drown in hundreds
  // of per-file spans. Reported as a single roll-up at flush time.
  type Counter = { count: number; totalMs: number; maxMs: number; maxId: string; top: Array<{ url: string; ms: number }> }
  const requests: Counter = { count: 0, totalMs: 0, maxMs: 0, maxId: "", top: [] }
  const transforms: Counter = { count: 0, totalMs: 0, maxMs: 0, maxId: "", top: [] }
  ;(globalThis as any).__zenbu_vite_stats__ ??= new Map()
  ;(globalThis as any).__zenbu_vite_stats__.set(id, { requests, transforms })
  return {
    name: "zenbu-boot-trace-vite",
    enforce: "pre",
    config() {
      bootTrace.mark(`vite:${id}:hook:config`)
    },
    configResolved() {
      bootTrace.mark(`vite:${id}:hook:configResolved`)
    },
    configureServer(server) {
      bootTrace.mark(`vite:${id}:hook:configureServer`)
      const origListen = server.listen.bind(server)
      server.listen = (async (...args: any[]) => {
        const ret = await bootTrace.span(`vite:${id}:vite-server.listen`, () =>
          origListen(...args),
        )
        return ret
      }) as any
      // Tap the underlying http handler to measure full per-request
      // wall-clock (transform + send) for each /file Vite serves.
      server.middlewares.use((req, res, next) => {
        const url = req.url || ""
        // Skip noisy framework-internal probes.
        if (url.startsWith("/__inspect") || url.startsWith("/@vite/client")) return next()
        const t0 = performance.now()
        res.on("finish", () => {
          const dt = performance.now() - t0
          requests.count++
          requests.totalMs += dt
          if (dt > requests.maxMs) {
            requests.maxMs = dt
            requests.maxId = url
          }
          // Maintain a sorted top-N list. Capped at 10 to bound work.
          requests.top.push({ url, ms: dt })
          requests.top.sort((a, b) => b.ms - a.ms)
          if (requests.top.length > 10) requests.top.length = 10
        })
        next()
      })
    },
    buildStart() {
      bootTrace.mark(`vite:${id}:hook:buildStart`)
    },
  } as VitePlugin
}
import { createHash } from "node:crypto"
import { dirname, resolve } from "node:path"
import { access, mkdir, readdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createServer as createNetServer } from "node:net"
import { Service, runtime } from "../runtime"
import { INTERNAL_DIR } from "../shared/paths"
import { createLogger } from "../shared/log"
import { zenbuVitePlugins } from "../vite-plugins"

const log = createLogger("reloader")

interface RendererServerOptions {
  id: string
  root: string
  port?: number
  configFile?: string | false
  cacheDir?: string
  plugins?: any[]
  reactPlugin?: () => any
  resolve?: any
}

function safeCacheSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "renderer"
}

function resolveRendererCacheDir(options: RendererServerOptions): string {
  const hash = createHash("sha256")
    .update(options.id)
    .update("\0")
    .update(resolve(options.root))
    .update("\0")
    .update(options.configFile ? resolve(options.configFile) : "no-config")
    .digest("hex")
    .slice(0, 12)

  return resolve(INTERNAL_DIR, "vite-cache", `${safeCacheSegment(options.id)}-${hash}`)
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Files whose Vite transform cost dwarfs everything else on cold boot
 * and that the entrypoint's first paint always pulls in. Warmed before
 * the iframe ever requests them so the transforms run while the rest
 * of the framework is still booting (instead of competing with 200+
 * concurrent module transforms once the iframe lands).
 *
 * - `main.tsx` is the entry. Warming it primes its sync transform
 *   pipeline (advice + react + esbuild).
 * - `main.css` runs through `@tailwindcss/vite`; isolated it's 140ms
 *   but under contention it stretches to 1100ms.
 * - `allotment/dist/style.css` runs through the same Tailwind pass.
 */
async function rendererWarmupUrls(root: string): Promise<string[]> {
  const urls = new Set<string>()
  if (await fileExists(resolve(root, "main.tsx"))) {
    urls.add("/main.tsx")
  }
  if (await fileExists(resolve(root, "main.css"))) {
    urls.add("/main.css")
  }
  return [...urls]
}

/**
 * Pre-transform the entrypoint module so the iframe's first request
 * hits warm cache. We DO NOT walk `<root>/views/*` here — those sub
 * views are only loaded if the user actually opens them, and warming
 * 16 of them in parallel during boot blew up Vite's transform queue
 * (warmup went from ~200ms to ~1400ms under contention). View main.tsx
 * files are warmed by `warmupViewsAfter` once first paint is past.
 *
 * `transformRequest` is preferred over `warmupRequest` because the
 * former returns when the transform AND its module-graph dependencies
 * are resolved, which is what we actually want primed.
 */
async function warmupRendererEntrypoints(server: ViteDevServer, root: string): Promise<void> {
  try {
    const urls = await rendererWarmupUrls(root)
    await Promise.all(
      urls.map((url) =>
        server.transformRequest(url).catch((e) => {
          log.warn(`warmup transformRequest(${url}) failed:`, e)
        }),
      ),
    )
  } catch (e) {
    log.warn("renderer warmup failed:", e)
  }
}

/**
 * Pre-transform every `<root>/views/<name>/main.tsx` file. Fired off
 * fire-and-forget after the entrypoint is on screen so subsequent
 * View iframe loads are warm without blocking initial paint.
 */
export async function warmupViewsAfter(server: ViteDevServer, root: string): Promise<void> {
  try {
    const urls: string[] = []
    const viewsDir = resolve(root, "views")
    for (const entry of await readdir(viewsDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue
      if (await fileExists(resolve(viewsDir, entry.name, "main.tsx"))) {
        urls.push(`/views/${entry.name}/main.tsx`)
      }
    }
    await Promise.all(urls.map((url) => server.warmupRequest(url)))
  } catch (e) {
    log.warn("deferred view warmup failed:", e)
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

async function startRendererServer(options: RendererServerOptions): Promise<ViteDevServer> {
  let server: ViteDevServer

  const port = options.port || await getEphemeralPort()
  const cacheDir = options.cacheDir ?? resolveRendererCacheDir(options)
  await mkdir(cacheDir, { recursive: true })

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

  // Framework plugins (advice prelude + content-script injection + advice
  // babel transform) are injected for every renderer regardless of whether
  // the user supplies a `vite.config.ts`. Vite merges inline `plugins` with
  // the loaded config, so a user `vite.config.ts` keeps full control of its
  // own plugin stack while still picking up framework wiring for free.
  const frameworkPlugins = zenbuVitePlugins()

  const traceLabel = `vite:${options.id}`
  const traceVitePlugin = bootTraceVitePlugin(options.id)
  if (options.configFile) {
    server = await bootTrace.span(`${traceLabel}:create-server`, () =>
      createServer({
        ...sharedConfig,
        root: options.root,
        configFile: options.configFile,
        plugins: [traceVitePlugin, ...frameworkPlugins, ...(options.plugins ?? [])],
      }),
      { configFile: options.configFile },
    )
  } else {
    const plugins: any[] = [traceVitePlugin, ...frameworkPlugins, ...(options.plugins ?? [])]
    if (options.reactPlugin) {
      plugins.unshift(options.reactPlugin())
    } else {
      try {
        const react = await bootTrace.span(
          `${traceLabel}:import-react-plugin`,
          () => import("@vitejs/plugin-react"),
        )
        plugins.unshift(react.default())
      } catch {}
    }

    server = await bootTrace.span(`${traceLabel}:create-server`, () =>
      createServer({
        ...sharedConfig,
        root: options.root,
        plugins,
        resolve: options.resolve,
        configFile: false,
      }),
    )
  }

  await bootTrace.span(`${traceLabel}:listen`, () => server.listen())

  const addr = server.httpServer?.address()
  const assignedPort = typeof addr === "object" && addr ? addr.port : 0
  if (assignedPort) {
    const hmr = server.config.server.hmr
    if (typeof hmr === "object") {
      ;(hmr as any).clientPort = assignedPort
    }
  }

  // Skip warmup. Calling `transformRequest('/main.tsx')` here doesn't
  // recursively transform main.tsx's imports — Vite's transform pipeline
  // only caches what was directly requested. So the only thing this
  // saved was the main.tsx + main.css transforms themselves (~150-300ms
  // isolated), but running them here just steals CPU from the iframe's
  // concurrent module-graph requests, which need the SAME CPU and run
  // RIGHT AFTER this. Net wall-clock change was zero or negative.
  //
  // The right way to pre-bake the iframe's first paint is to crawl the
  // graph (which Vite doesn't expose on the dev server side) or to ship
  // a production bundle for boot. Both are out of scope for this fix.
  // void warmupRendererEntrypoints(server, options.root)

  return server
}

export interface ReloaderEntry {
  id: string
  root: string
  url: string
  port: number
  viteServer: ViteDevServer
}

/**
 * Owns the host renderer's Vite server.
 *
 * In one-DOM mode there's exactly one Vite server — the one serving
 * the host's `uiEntrypoint`. The legacy multi-server map and lazy
 * startup helpers (`registerLazy` / `ensure` / `has` / `remove`) were
 * iframe-era plumbing for per-view dev servers; they're gone.
 *
 * `id` survives as an opaque label in the API surface (`create(id, ...)`,
 * `get(id)`) so the small number of internal callers (`http`,
 * `advice-config`, `renderer-host`) didn't have to change shape, but
 * in practice only the framework-managed `"app"` id is ever used.
 */
export class ReloaderService extends Service.create({ key: "reloader" }) {
  private entry: ReloaderEntry | null = null

  async create(
    id: string,
    root: string,
    configFile?: string | false,
  ): Promise<ReloaderEntry> {
    if (this.entry) return this.entry
    const viteServer = await startRendererServer({
      id,
      root,
      configFile: configFile ?? false,
      port: 0,
    })
    const address = viteServer.httpServer?.address()
    const port =
      typeof address === "object" && address ? address.port : 5173
    this.entry = {
      id,
      root,
      url: `http://localhost:${port}`,
      port,
      viteServer,
    }
    log.verbose(`${id} ready at ${this.entry.url}`)
    return this.entry
  }

  get(_id?: string): ReloaderEntry | undefined {
    return this.entry ?? undefined
  }

  evaluate() {
    this.setup("vite-cleanup", () => async () => {
      const entry = this.entry
      this.entry = null
      if (!entry) return
      try {
        await entry.viteServer.close()
      } catch (err) {
        // Don't let close failures cascade — a thrown promise here
        // strands chokidar+fsevents watchers and trips
        // `napi_call_function` inside `fse_dispatch_event` during
        // V8 isolate teardown.
        log.error(`viteServer.close failed for ${entry.id}:`, err)
      }
    })
  }
}

runtime.register(ReloaderService, import.meta)

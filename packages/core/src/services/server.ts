import http from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { performance } from "node:perf_hooks"
import { WebSocketServer } from "ws"
import { Service, runtime } from "../runtime"
import { bootTrace } from "../boot-trace"
import { createLogger } from "../shared/log"

const log = createLogger("server")

type UpgradeHandler = (req: http.IncomingMessage, socket: import("stream").Duplex, head: Buffer) => boolean

export class ServerService extends Service.create({ key: "server" }) {
  server: http.Server | null = null
  wss: WebSocketServer | null = null
  port = 0
  authToken = randomBytes(32).toString("base64url")
  private upgradeHandlers: UpgradeHandler[] = []

  addUpgradeHandler(handler: UpgradeHandler): () => void {
    this.upgradeHandlers.push(handler)
    return () => { this.upgradeHandlers = this.upgradeHandlers.filter(h => h !== handler) }
  }

  async evaluate() {
    if (!this.server) {
      // Adopt the pre-bound server from setup-gate when available. The
      // bind itself is cheap (<1ms) but its callback is starved if it
      // has to share the event loop with the default-services import
      // chain, so setup-gate kicks it off before any of that work runs.
      const prealloc = (globalThis as unknown as {
        __zenbu_preallocated_server__?: {
          server: http.Server
          wss: WebSocketServer
          port: number
        }
      }).__zenbu_preallocated_server__
      if (prealloc) {
        bootTrace.spanSync("server:adopt-prealloc", () => {
          this.server = prealloc.server
          this.wss = prealloc.wss
          this.port = prealloc.port
        })
      } else {
        bootTrace.spanSync("server:createServer", () => {
          this.server = http.createServer()
        })
        bootTrace.spanSync("server:new-WebSocketServer", () => {
          this.wss = new WebSocketServer({ noServer: true })
        })
      }
      this.server!.on("upgrade", (req, socket, head) => {
        for (const handler of this.upgradeHandlers) {
          if (handler(req, socket, head)) return
        }
        if (!this.isAuthorizedUpgrade(req)) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
          socket.destroy()
          return
        }
        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          this.wss!.emit("connection", ws, req)
        })
      })
      if (!prealloc) {
        this.port = await bootTrace.span("server:listen(0)", () => {
          const t0 = performance.now()
          return new Promise<number>((resolve) => {
            this.server!.listen(0, () => {
              const tCb = performance.now()
              bootTrace.mark("server:listen-callback-fired", {
                latencyMs: +(tCb - t0).toFixed(1),
              })
              const addr = this.server!.address()
              resolve(typeof addr === "object" && addr ? addr.port : 0)
            })
          })
        })
      }
      log.verbose(`listening on port ${this.port}`)
    }

    this.setup("server-cleanup", () => {
      return () => {
        this.wss?.close()
        this.server?.close()
        this.server?.closeAllConnections()
        this.server = null
        this.wss = null
      }
    })
  }

  private isAuthorizedUpgrade(req: http.IncomingMessage): boolean {
    const rawUrl = req.url ?? "/"
    const token = new URL(rawUrl, "http://127.0.0.1").searchParams.get("token")
    if (!token) return false

    const expected = Buffer.from(this.authToken)
    const actual = Buffer.from(token)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
}

runtime.register(ServerService, import.meta)

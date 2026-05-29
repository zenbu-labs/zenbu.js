import http from "node:http"
import type { WebSocket } from "ws"
import { nanoid } from "nanoid"
import { Service, runtime } from "../runtime"
import { ServerService } from "./server"
import { ViteService } from "./vite"
import { createLogger } from "../shared/log"
import type { Duplex } from "stream"

const log = createLogger("http")

type ConnectedCallback = (id: string, ws: WebSocket) => void
type DisconnectedCallback = (id: string) => void

type RequestHandler = (req: http.IncomingMessage, res: http.ServerResponse) => void

export class HttpService extends Service.create({
  key: "http",
  deps: { server: ServerService, vite: ViteService },
}) {
  connectedCallbacks: ConnectedCallback[] = []
  disconnectedCallbacks: DisconnectedCallback[] = []
  activeConnections = new Map<string, WebSocket>()
  private requestHandlers = new Map<string, RequestHandler>()

  get port() { return this.ctx.server.port }
  get authToken() { return this.ctx.server.authToken }

  addRequestHandler(prefix: string, handler: RequestHandler): () => void {
    this.requestHandlers.set(prefix, handler)
    return () => { this.requestHandlers.delete(prefix) }
  }

  onConnected(cb: ConnectedCallback) {
    this.connectedCallbacks.push(cb)
    return () => { this.connectedCallbacks = this.connectedCallbacks.filter(f => f !== cb) }
  }

  onDisconnected(cb: DisconnectedCallback) {
    this.disconnectedCallbacks.push(cb)
    return () => { this.disconnectedCallbacks = this.disconnectedCallbacks.filter(f => f !== cb) }
  }

  evaluate() {
    this.connectedCallbacks = []
    this.disconnectedCallbacks = []

    const { server } = this.ctx

    const startTime = performance.now()

    this.setup("proxy", () => {
      const viteAgent = new http.Agent({ keepAlive: true, maxSockets: 20 })

      const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
        const url = req.url ?? "/"
        for (const [prefix, routeHandler] of this.requestHandlers) {
          if (url.startsWith(prefix)) {
            routeHandler(req, res)
            return
          }
        }

        const viteUrl = this.ctx.vite.url
        if (!viteUrl) {
          res.writeHead(503)
          res.end("Vite server not ready")
          return
        }
        const target = new URL(url, viteUrl.replace(/\/$/, ""))
        const proxyHeaders = { ...req.headers, host: target.host }
        const proxyReq = http.request(
          target,
          { method: req.method, headers: proxyHeaders, agent: viteAgent },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
            proxyRes.pipe(res)
          },
        )
        proxyReq.on("error", () => {
          res.writeHead(502)
          res.end("Bad Gateway")
        })
        req.pipe(proxyReq)
      }

      server.server!.on("request", handler)
      return () => {
        server.server!.off("request", handler)
        viteAgent.destroy()
      }
    })

    this.setup("vite-hmr-proxy", () => {
      const removeHandler = server.addUpgradeHandler((req, socket, head) => {
        const protocols = req.headers["sec-websocket-protocol"]
        if (!protocols || !protocols.includes("vite-hmr")) return false

        const viteUrl = this.ctx.vite.url
        if (!viteUrl) {
          socket.destroy()
          return true
        }

        const target = new URL(viteUrl)
        const proxyReq = http.request({
          hostname: target.hostname,
          port: target.port,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: target.host },
        })
        proxyReq.on("upgrade", (_res, proxySocket, proxyHead) => {
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\n` +
            Object.entries(_res.headers).map(([k, v]) => `${k}: ${v}`).join("\r\n") +
            "\r\n\r\n",
          )
          if (proxyHead.length) socket.write(proxyHead)
          proxySocket.pipe(socket as Duplex).pipe(proxySocket)
        })
        // 
        proxyReq.on("error", () => socket.destroy())
        proxyReq.end(head)
        return true
      })
      return removeHandler
    })

    this.setup("ws-dispatch", () => {
      const onConnection = (ws: WebSocket, req: http.IncomingMessage) => {
        const id = nanoid()

        this.activeConnections.set(id, ws)
        for (const cb of this.connectedCallbacks) cb(id, ws)

        ws.on("close", () => {
          this.activeConnections.delete(id)
          for (const cb of this.disconnectedCallbacks) cb(id)
        })
      }

      server.wss!.on("connection", onConnection)
      return () => {
        server.wss!.off("connection", onConnection)
      }
    })

    log.verbose(`service ready on port ${this.port}`)
  }
}

runtime.register(HttpService, import.meta)

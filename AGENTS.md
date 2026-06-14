- use pnpm publish to publish packages, not npm

This is a repo for the framework zenbu.js, below are the docs
# Overview
Source: https://zenbulabs.mintlify.app/api-reference/overview



## Packages

| Package                  | Description                                          |
| ------------------------ | ---------------------------------------------------- |
| `@zenbujs/core/runtime`  | Service base class and runtime.                      |
| `@zenbujs/core/services` | Built-in core services (Window, DB, RPC, HTTP, etc). |
| `@zenbujs/core/config`   | `defineConfig`, `definePlugin`, `defineBuildConfig`. |
| `@zenbujs/core/db`       | Database schema authoring (`createSchema`, `z`).     |
| `@zenbujs/core/advice`   | Advice types and helpers.                            |
| `@zenbujs/core/react`    | React hooks for the renderer.                        |
| `create-zenbu-app`       | CLI scaffolding tool.                                |

## Runtime

```typescript theme={null}
import { Service } from "@zenbujs/core/runtime"
```

## Config

```typescript theme={null}
import {
  defineConfig,
  definePlugin,
  defineBuildConfig,
} from "@zenbujs/core/config"
```

## Database

```typescript theme={null}
import { createSchema } from "@zenbujs/core/db"
import { z } from "zod"
```

## React hooks

```typescript theme={null}
import {
  useDb,
  useDbClient,
  useCollection,
  useRpc,
  useEvents,
  useViewArgs,
} from "@zenbujs/core/react"
```

## CLI

```bash theme={null}
# Create a new app
npx create-zenbu-app

# Dev server with hot reload
pnpm run dev

# Regenerate types
pnpm run link

# Generate a database migration
pnpm run db:generate

# Build for production
pnpm run build:source
pnpm run build:electron
```


# Concepts
Source: https://zenbulabs.mintlify.app/concepts



Zenbu.js apps are Electron apps. The two processes you work with most are:

* **Main process** - a Node.js process that has access to the file system and operating system.
* **Renderer process** - a Chromium browser window that runs your React UI.

The two processes communicate through Zenbu's RPC and event system instead of raw [Electron IPC](https://www.electronjs.org/docs/latest/tutorial/ipc).

## Supported runtimes

| Runtime  | Status |
| -------- | ------ |
| Electron | ✅      |
| Tauri    | ⏳      |
| Web      | ⏳      |

## Plugins

Every Zenbu.js application is itself a plugin. Your app and any third-party plugin that extends it share the same set of capabilities. Everything described below applies equally to both.

## Services

Services are shared objects that run in the main process. They hold state, manage resources, and can depend on other services ([dependency injection](https://en.wikipedia.org/wiki/Dependency_injection)). Every public method on a service is automatically available to the renderer process via type-safe RPC.

```typescript src/main/services/counter.ts theme={null}
import { Service } from "@zenbujs/core/runtime"

export class CounterService extends Service.create({
  key: "counter",
}) {
  private count = 0

  evaluate() {
    // Called when the service starts
  }

  increment() {
    this.count++
    return this.count
  }

  getCount() {
    return this.count
  }
}
```

When you edit a service file and save, `evaluate()` re-runs immediately without restarting the app.

## Database

Zenbu.js includes a JSON database that syncs across every process. Components that read from the database automatically re-render when the data they depend on changes.

```typescript theme={null}
import { useDb, useDbClient } from "@zenbujs/core/react"

function Counter() {
  const count = useDb(root => root.app.count)
  const client = useDbClient()

  return (
    <button onClick={() => {
      client.update(root => { root.app.count++ })
    }}>
      Count: {count}
    </button>
  )
}
```

## [RPC](https://en.wikipedia.org/wiki/Remote_procedure_call)

Every public method on a service becomes callable from the renderer process with full TypeScript inference. You define a service class in the main process and call it from React through `useRpc()`.

```typescript theme={null}
import { useRpc } from "@zenbujs/core/react"

function App() {
  const rpc = useRpc()

  const handleClick = async () => {
    const newCount = await rpc.counter.increment()
    console.log(newCount)
  }

  return <button onClick={handleClick}>Increment</button>
}
```

## Events

Services in the main process can emit events that the renderer process subscribes to. Events cross process boundaries automatically.

A service emits an event through `this.ctx.rpc.emit`:

```typescript src/main/services/notifications.ts theme={null}
export class NotificationService extends Service.create({
  key: "notifications",
}) {
  send(message: string) {
    this.ctx.rpc.emit.app.notification({ message })
  }
}
```

The renderer process listens with `useEvents()`:

```typescript theme={null}
import { useEvents } from "@zenbujs/core/react"
import { useEffect, useState } from "react"

function Notifications() {
  const events = useEvents()
  const [message, setMessage] = useState("")

  useEffect(() => {
    const unsubscribe = events.app.notification.subscribe((data) => {
      setMessage(data.message)
    })
    return unsubscribe
  }, [])

  return message ? <div className="toast">{message}</div> : null
}
```


# Advice
Source: https://zenbulabs.mintlify.app/core/advice



Advice lets a plugin wrap or replace a function or React component owned by another plugin, without modifying the original source.

This API is inspired from Emacs, where [`defadvice`](https://www.gnu.org/software/emacs/manual/html_node/elisp/Advising-Functions.html) is used to modify existing functions without editing their source.

## Registering advice

Call `this.advise(...)` from inside a service:

```typescript theme={null}
import { Service } from "@zenbujs/core/runtime"

export class ChromeService extends Service.create({ key: "chrome" }) {
  evaluate() {
    this.setup("wrap-counter", () =>
      this.advise({
        view: "entrypoint",
        moduleId: "App.tsx",
        name: "Counter",
        type: "around",
        modulePath: "src/content/wrap-counter.tsx",
        exportName: "WrapCounter",
      }),
    )
  }
}
```

| Field        | Meaning                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| `view`       | View type to apply the advice in. `"*"` for every view.                 |
| `moduleId`   | Suffix of the source file that exports the target.                      |
| `name`       | Name of the export to advise.                                           |
| `type`       | One of `"replace"`, `"before"`, `"after"`, `"around"`.                  |
| `modulePath` | Path to your wrapper module, relative to the plugin root (or absolute). |
| `exportName` | Named export inside the wrapper module.                                 |

Returns an unregister function. Use it as a `setup` cleanup.

## Around advice

Receives the original as `__original` in props, making it the most flexible advice type.

```tsx src/content/wrap-counter.tsx theme={null}
export function WrapCounter(props) {
  const Original = props.__original
  return (
    <div className="bordered">
      <Original {...props} />
    </div>
  )
}
```

Use this when you want to render the original but add structure around it or change its props.

## Replace advice

Substitutes the export entirely. The wrapper is used in place of the original.

```tsx theme={null}
export function WrapCounter() {
  return <button>Replaced</button>
}
```

## Before / After

`before` and `after` advice run extra logic around the original function.

```typescript theme={null}
// before: runs your function, then calls the original
export function beforeSave(args: { path: string }) {
  console.log("saving", args.path)
}

// after: calls the original, then runs your function with the result
export function afterSave(result: void, args: { path: string }) {
  console.log("saved", args.path)
}
```

## Hot reloading

Adding, removing, or editing a `this.advise(...)` call reloads the affected views so the new advice takes effect. Edits inside the advice module itself hot-replace through Vite's normal HMR.


# Content Scripts
Source: https://zenbulabs.mintlify.app/core/content-scripts



A content script is JavaScript that gets injected into a page at runtime. It runs in the same environment as the page, so it can use React hooks, read from the database, and call RPC methods. Content scripts target views by type, so you can inject into specific views or use `"*"` to inject into all of them.

## Use cases

* Add UI that appears on every page, like a devtools panel or a chat overlay.
* Add UI to a specific page without modifying that page's source code.
* Let a plugin contribute visible elements to the host app.

## Registering a content script

Call `this.injectContentScript(...)` from a service:

```typescript theme={null}
import { Service } from "@zenbujs/core/runtime"

export class DevtoolsService extends Service.create({ key: "devtools" }) {
  evaluate() {
    this.setup("inject", () =>
      this.injectContentScript({
        view: "*",
        modulePath: "src/content/toolbar.tsx",
      }),
    )
  }
}
```

| Field        | Meaning                                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `view`       | The view type to inject into. Pass `"*"` to inject into every view.                                                        |
| `modulePath` | Path to the script. Relative paths resolve against the plugin's directory; absolute paths are accepted as an escape hatch. |

The call returns an unsubscribe function, so wrapping it in `this.setup()` ensures cleanup on hot reload.

## Authoring a content script

A content script is a module that runs when the page loads. It can mount its own React tree into the DOM. This example adds a toolbar using a shadow root to keep its styles separate from the host page:

```tsx src/content/toolbar.tsx theme={null}
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ZenbuProvider } from "@zenbujs/core/react"
import { Toolbar } from "./Toolbar"

function mount() {
  if (document.body?.dataset.myToolbarMounted === "1") return
  document.body.dataset.myToolbarMounted = "1"

  const host = document.createElement("div")
  document.body.appendChild(host)
  const shadow = host.attachShadow({ mode: "closed" })
  const reactRoot = document.createElement("div")
  shadow.appendChild(reactRoot)

  createRoot(reactRoot).render(
    <StrictMode>
      <ZenbuProvider>
        <Toolbar />
      </ZenbuProvider>
    </StrictMode>
  )
}

mount()
```

## Content scripts vs advice

Content scripts add new UI alongside the host view's component tree. They cannot replace or wrap existing components. For that, use [advice](/guides/advice-functions) instead.


# Events
Source: https://zenbulabs.mintlify.app/core/events



Events let the main process send messages to the renderer process. They're useful for things like push notifications, streaming output, or reacting to something that happened on the server side. Unlike RPC (where the renderer calls the main process and waits for a response), events are one-way: the main process fires them and any listener in the renderer process receives them.

## Defining events

You define events in a TypeScript file as a type with a name and payload for each event. This file needs to be registered in your config via `definePlugin({ events: "./src/main/events.ts" })` so the framework can keep everything type-safe.

```typescript src/main/events.ts theme={null}
export type Events = {
  todoCreated: { id: string; title: string }
  todoCompleted: { id: string }
  todoDeleted: { id: string }
}
```

## Emitting events

From a service, emit events through `this.ctx.rpc.emit`:

```typescript theme={null}
import { Service } from "@zenbujs/core/runtime"
import { RpcService } from "@zenbujs/core/services"

export class TodoService extends Service.create({
  key: "todo",
  deps: { rpc: RpcService },
}) {
  create(args: { title: string }) {
    const id = crypto.randomUUID()
    // ... create the todo
    // emit.<plugin name>.<event name>(payload)
    this.ctx.rpc.emit.app.todoCreated({ id, title: args.title })
  }
}
```

## Listening to events

From React, use the `useEvents` hook to subscribe:

```typescript theme={null}
import { useEvents } from "@zenbujs/core/react"

function Notifications() {
  const events = useEvents()

  useEffect(() => {
    const off = events.app.todoCreated.subscribe(({ title }) => {
      showToast(`New todo: ${title}`)
    })
    return off
  }, [events])

  return null
}
```

The returned function unsubscribes the listener, so return it from your effect's cleanup to avoid accumulating subscriptions across renders.

## Events vs RPC vs database

* **Events** are for transient updates that don't need to be persisted, like streaming terminal output or push notifications.
* **RPC** is for getting the main process to run code the renderer process can't, like reading a file or calling a system API.
* **Database** is for state that should persist and drive your UI.


# Plugins
Source: https://zenbulabs.mintlify.app/core/plugins



Every Zenbu.js application is itself a plugin. Your app is defined with `definePlugin()` the same way any third-party extension would be, and it has the same capabilities. The only thing that makes the main application special is the `uiEntrypoint` in `defineConfig()`, which tells the framework which plugin's code to load in the renderer process first.

## Defining a plugin

Plugins are declared with `definePlugin()` from `@zenbujs/core/config`:

```typescript zenbu.config.ts theme={null}
import { defineConfig, definePlugin } from "@zenbujs/core/config"

export default defineConfig({
  db: "./.zenbu/db",
  uiEntrypoint: "./src/renderer",
  plugins: [
    definePlugin({
      name: "app",
      services: ["./src/main/services/*.ts"],
      schema: "./src/main/schema.ts",
      events: "./src/main/events.ts",
      migrations: "./migrations",
    }),
  ],
})
```

| Field        | Required | Description                                                                                                                                                                                                                                 |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`       | yes      | Unique plugin identifier. Used as the top-level namespace for the plugin's database section, RPC services, and events (e.g. `db.<name>`, `rpc.<name>.<service>`, `events.<name>.<event>`). Reserved value: `core` belongs to the framework. |
| `services`   | yes      | Glob patterns for main process service files.                                                                                                                                                                                               |
| `schema`     | no       | Path to the database schema definition.                                                                                                                                                                                                     |
| `events`     | no       | Path to event type definitions.                                                                                                                                                                                                             |
| `migrations` | no       | Directory of generated migration files.                                                                                                                                                                                                     |
| `dependsOn`  | no       | Declares which other plugins this plugin needs type definitions from. See [Type dependencies](#type-dependencies).                                                                                                                          |

## Scaffolding a plugin

`create-zenbu-app` can scaffold a plugin folder from anywhere on disk:

```bash theme={null}
pnpm create zenbu-app --plugin my-plugin
```

| Flag               | Description                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| `--plugin`         | Use the plugin template instead of the app template. Skips app-only prompts (Tailwind, build config).   |
| `--no-add-to-host` | Skip the interactive prompt that offers to add the new plugin to each upstream host's `plugins:` array. |
| `--no-git`         | Skip the git init prompt. Git init is auto-skipped when an ancestor already has a `.git/`.              |
| `--yes` / `-y`     | Auto-confirm every prompt with the default.                                                             |

The command scaffolds the plugin folder and installs its dependencies.

## Adding a plugin

Plugins can be inlined with `definePlugin()` or referenced by path to a `zenbu.plugin.ts` file:

```typescript theme={null}
plugins: [
  definePlugin({ name: "app", services: ["./src/main/services/*.ts"] }),
  "./plugins/devtools/zenbu.plugin.ts",
]
```

Adding or removing a plugin in `zenbu.config.ts` is a hot-reloadable change that takes effect without restarting the app.

## Plugin capabilities

A plugin has the same capabilities as the host application:

* **Services** run in the main process and expose methods via RPC.
* **Database schemas** define sections of the shared database.
* **Events** can be emitted and listened to across plugins.
* **Views** are iframe-mounted renderer entry points other plugins can embed.
* **Content scripts** inject JavaScript into any view.
* **Advice** lets a plugin wrap or replace any React component in the renderer.

## Type dependencies

If a plugin needs to call another plugin's RPC methods, read its database, or subscribe to its events, it needs that plugin's type definitions. You declare this with `dependsOn`:

```typescript zenbu.plugin.ts theme={null}
import { definePlugin } from "@zenbujs/core/config"

export default definePlugin({
  name: "devtools",
  services: ["./src/main/services/*.ts"],
  dependsOn: [
    { name: "app", from: "../../zenbu.config.ts" },
  ],
})
```

`name` is the plugin you depend on, and `from` is the path to the file that defines it. With this in place, you get typed access to that plugin's API:

```typescript theme={null}
// Read app's database
const count = useDb(root => root.app.count)

// Call app's RPC methods
const rpc = useRpc()
await rpc.app.counter.increment()

// Subscribe to app's events
events.app.notification.subscribe(data => { ... })
```

This is a type-only dependency. `dependsOn` tells `zen link` where to find the other plugin's service, schema, and event definitions so it can generate TypeScript types under `<plugin>/.zenbu/types/`. The generated files are `import type` pointers to the actual source on disk, and the entire `.zenbu/types/` directory is gitignored.

`zen link` runs automatically inside `zen dev`. Outside dev, run it manually before typechecking:

```bash theme={null}
zen link
```


# RPC
Source: https://zenbulabs.mintlify.app/core/rpc



When you define a service class in the main process, every public method becomes callable from the renderer process. Zenbu.js handles all the wiring between processes for you, so you just call methods like normal functions.

Under the hood, communication happens over a WebSocket, which means the same RPC system works whether your app runs in Electron or in the browser. The transport is pluggable, so you can swap it for Electron IPC, WebRTC, or anything else.

Services are scoped under their owning plugin's name. For a plugin named `app`, the call site is `rpc.app.<service>.<method>(...)`. Core's own services live under `rpc.core.<service>`.

```typescript theme={null}
// Main process — declared inside the `app` plugin
export class MathService extends Service.create({
  key: "math",
}) {
  add(args: { a: number; b: number }) {
    return args.a + args.b
  }
}

// Renderer
const rpc = useRpc()
const result = await rpc.app.math.add({ a: 1, b: 2 }) // 3
```

## Type inference

TypeScript types flow from the service definition to the renderer call site. Parameters, return types, and method names are all inferred.

Types are generated by `zen link` (runs automatically during `zen dev`) and stored in `.zenbu/types/`, so if you rename a method or change its signature, the renderer code shows a type error immediately.

## Async

All RPC calls are async from the renderer's perspective, even if the service method is synchronous. This is because calls cross a process boundary.

```typescript theme={null}
// This service method is synchronous
getCount() {
  return this.count
}

// But from React, it returns a Promise
const count = await rpc.app.counter.getCount()
```

## Error handling

Errors thrown in service methods are serialized and re-thrown in the renderer.

```typescript theme={null}
// Main process
export class AuthService extends Service.create({ key: "auth" }) {
  login(args: { email: string; password: string }) {
    if (!args.email) throw new Error("Email is required")
    // ...
  }
}

// Renderer
try {
  await rpc.app.auth.login({ email: "", password: "pass" })
} catch (e) {
  console.log(e.message) // "Email is required"
}
```

## Method conventions

* **Take a single object argument.** This keeps argument signatures stable as the API grows.
* **Return JSON-serializable values.** Anything that round-trips through `JSON.stringify` works.


# Services
Source: https://zenbulabs.mintlify.app/core/services



A service is a class that extends `Service.create()` from `@zenbujs/core/runtime`. It runs in the main process.

```typescript src/main/services/files.ts theme={null}
import { Service } from "@zenbujs/core/runtime"
import fs from "fs/promises"

export class FilesService extends Service.create({
  key: "files",
}) {
  evaluate() {
    // Called when the service starts.
  }

  async readFile(args: { path: string }) {
    return fs.readFile(args.path, "utf-8")
  }

  async writeFile(args: { path: string; content: string }) {
    await fs.writeFile(args.path, args.content)
  }
}
```

Every public method is automatically exposed to the renderer process via RPC. You call them through `rpc.<plugin>.<service>.<method>`, so if this service belongs to a plugin named `app`, `readFile` is available as `rpc.app.files.readFile(...)`.

## Calling from React

```typescript theme={null}
import { useRpc } from "@zenbujs/core/react"

function Editor() {
  const rpc = useRpc()

  const load = async () => {
    const content = await rpc.app.files.readFile({ path: "/path/to/file.txt" })
    console.log(content)
  }

  return <button onClick={load}>Load</button>
}
```

The call is fully type-safe. Parameters and return types are inferred from the service class.

## Dependencies

Services declare dependencies on other services through the `deps` field. The framework automatically figures out the right order to start them in, so each service's dependencies are ready before it runs.

```typescript theme={null}
import { Service } from "@zenbujs/core/runtime"
import { WindowService } from "@zenbujs/core/services"

export class AppService extends Service.create({
  key: "app",
  deps: { window: WindowService },
}) {
  async evaluate() {
    await this.ctx.window.openView({ type: "entrypoint" })
  }
}
```

By the time `evaluate()` runs, all dependencies in `this.ctx` are fully initialized.

## Setups and cleanups

Inside `evaluate()`, anything that needs to be torn down on hot reload or shutdown should be wrapped in `this.setup()`:

```typescript theme={null}
evaluate() {
  this.setup("interval", () => {
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  })
}
```

The returned function is the cleanup. It runs before the next setup with the same name, or when the service is torn down.

## Hot reloading

When you edit a service file and save, the framework re-evaluates affected services automatically. This works in both development and production.


# Database
Source: https://zenbulabs.mintlify.app/core/state



Zenbu.js includes a JSON database that syncs across every process. Every process (main and renderer) holds an in-memory copy (also known as a replica) of the database. Reads are always local and synchronous. When a write happens in any process, it syncs to all other replicas automatically.

This means both the main process and the renderer read and write through the same interface. The only difference is how you access the client: through `DbService` in a service, or through React hooks in the renderer.

## Schema

Each plugin defines a schema using zod that describes the shape of its data.

```typescript src/main/schema.ts theme={null}
import { createSchema } from "@zenbujs/core/db"
import { z } from "zod"

export default createSchema({
  todos: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        done: z.boolean(),
      })
    )
    .default([]),
  settings: z
    .object({
      theme: z.string(),
      fontSize: z.number(),
    })
    .default({ theme: "dark", fontSize: 14 }),
})
```

Fields without a `default()` will be `undefined` initially. Use `.default()` to set an initial value for a field when the database is first created.

## Reading data

The database is a single JSON object called the `root`. Each plugin's data lives under its name, so `root.app` holds everything defined by the `app` plugin.

In the renderer, use the `useDb` hook to read from the database.

```typescript theme={null}
import { useDb } from "@zenbujs/core/react"

function TodoList() {
  const todos = useDb(root => root.app.todos)

  return (
    <ul>
      {todos.map(todo => (
        <li key={todo.id}>{todo.title}</li>
      ))}
    </ul>
  )
}
```

`useDb` is a subscription. When the selected value changes, the component re-renders automatically. Unrelated changes don't trigger re-renders.

> [!WARNING]
> **Reference Equality & Selector Rules**: Selectors must return values or slices owned by the database (or primitive types). Synthesizing/constructing a new object or array shape inside the selector (e.g. `root => root.app.items.map(...)` or returning a new object literal) will return a new reference on every call, triggering an infinite re-render loop (`Maximum update depth exceeded`).
>
> If you need to transform or project the database slice into a new shape, return the raw database slice from `useDb` and perform the transformation inside a React `useMemo` hook:
>
> ```typescript
> // Return raw slice from useDb
> const rawItems = useDb(root => root.app.items);
> // Project/map in useMemo
> const processedItems = useMemo(() => {
>   return rawItems.map(item => ({ id: item.id, label: item.name }));
> }, [rawItems]);
> ```

In a service, read through `DbService.client`:

```typescript theme={null}
const root = this.ctx.db.client.readRoot()
const todos = root.app.todos
```

`readRoot()` returns a synchronous snapshot since the entire root is held in memory. You can also subscribe to a specific field to react when it changes:

```typescript theme={null}
const unsubscribe = this.ctx.db.client.app.todos.subscribe(todos => {
  console.log("todos changed", todos)
})
```

The returned function unsubscribes. Wrap it in `this.setup()` so it cleans up on hot reload.

## Writing data

In the renderer, use `useDbClient` to get a client that can write to the database:

```typescript theme={null}
import { useDbClient } from "@zenbujs/core/react"

function AddTodo() {
  const client = useDbClient()

  const add = () => {
    client.update(root => {
      root.app.todos.push({
        id: crypto.randomUUID(),
        title: "New todo",
        done: false,
      })
    })
  }

  return <button onClick={add}>Add</button>
}
```

In a service, write through `DbService.client`:

```typescript theme={null}
await this.ctx.db.client.update(root => {
  root.app.todos.push({
    id: crypto.randomUUID(),
    title: "New todo",
    createdAt: Date.now(),
  })
})
```

Inside `update()`, you mutate the root object directly, the same way you would with a regular JavaScript object. The database tracks these mutations and syncs them to other processes in the background.

## Collections

Regular data fields are always held in memory across every process. Collections are for data that can grow large (like agent messages or logs) and should only be loaded into memory when needed.

Define a collection in your schema with `f.collection()`:

```typescript src/main/schema.ts theme={null}
import { createSchema, f } from "@zenbujs/core/db"
import { z } from "zod"

export default createSchema({
  messages: f.collection(
    z.object({
      text: z.string(),
      author: z.string(),
    }),
    { debugName: "messages" }
  ),
})
```

Collections are append-only. In a service, use `concat` to add items:

```typescript theme={null}
await this.ctx.db.client.app.messages.concat([
  { text: "Hello", author: "alice" },
])
```

In the renderer, use `useCollection` to subscribe to a collection's data:

```typescript theme={null}
import { useDb, useCollection } from "@zenbujs/core/react"

function Messages() {
  const messagesRef = useDb(root => root.app.messages)
  const { items, concat } = useCollection(messagesRef)
  const [text, setText] = useState("")

  return (
    <div>
      {items.map((msg, i) => (
        <div key={i}>{msg.author}: {msg.text}</div>
      ))}
      <input value={text} onChange={e => setText(e.target.value)} />
      <button onClick={() => {
        concat([{ text, author: "alice" }])
        setText("")
      }}>Send</button>
    </div>
  )
}
```

Collection data is only loaded into memory when you subscribe or read from it. This keeps the in-memory footprint small for data that can grow without bound.

## Blobs

Blobs store binary data (`Uint8Array`) like files or images. Like collections, they live on disk and are only loaded into memory when you read them.

Define a blob in your schema with `f.blob()`:

```typescript src/main/schema.ts theme={null}
import { createSchema, f } from "@zenbujs/core/db"
import { z } from "zod"

export default createSchema({
  avatar: f.blob({ debugName: "avatar" }),
})
```

Write binary data with `set`:

```typescript theme={null}
const data = new TextEncoder().encode("hello")
await this.ctx.db.client.app.avatar.set(data)
```

Read it back with `read`:

```typescript theme={null}
const data = await this.ctx.db.client.app.avatar.read()
```

## Migrations

When you change your schema, existing databases need to be updated to match the new shape. Running `pnpm run db:generate` compares your current schema to the previous version and creates a migration file that describes what changed.

```bash theme={null}
pnpm run db:generate
```

The generated file is placed in your plugin's `migrations/` directory. Here's an example of what one looks like after adding a new `activeTabId` field to the schema:

```typescript migrations/0003.ts theme={null}
import type { KyjuMigration } from "@zenbu/kyju"

export const migration: KyjuMigration = {
  // Each migration increments the version number.
  version: 3,
  // The operations array describes the changes to apply.
  operations: [
    // "add" introduces a new key with a default value.
    { op: "add", key: "activeTabId", kind: "data", hasDefault: true, default: null },
  ],
}
```

Three operation types cover most schema changes:

* **add**: introduces a new key, optionally with a default value.
* **remove**: drops an existing key.
* **alter**: updates the metadata of an existing key, like changing its default.

For more complex changes, add a `migrate` function to transform the data with custom logic. Use `ctx.apply` to run the declared operations first, then modify the result:

```typescript migrations/0004.ts theme={null}
import type { KyjuMigration } from "@zenbu/kyju"

export const migration: KyjuMigration = {
  version: 4,
  operations: [
    { op: "add", key: "fullName", kind: "data", hasDefault: true, default: "" },
  ],
  migrate: (prev, { apply }) => {
    // Runs the auto-generated operations above
    const result = apply(prev)
    result.fullName = `${prev.firstName} ${prev.lastName}`
    return result
  },
}
```

Migrations run automatically when the app starts. Each migration runs at most once, and during development, adding or editing a migration file triggers a reload without restarting the app.


# Views
Source: https://zenbulabs.mintlify.app/core/views



<Warning>The Views API is under construction</Warning>

A view is the rendering primitive in Zenbu.js. Every page your app renders is a view, including the main application itself, which is a view called `entrypoint` defined by your `uiEntrypoint` config.

The `entrypoint` view runs directly in the renderer process. Additional views run in [out of process iframes](https://www.chromium.org/developers/design-documents/oop-iframes/), and connect to the same [RPC](/core/rpc), [events](/core/events), and [database](/core/state).

Additional views are useful for:

* Letting a plugin embed content into your app.
* Isolating heavy features so a slow render in one view doesn't block the rest of the app.
* Letting teams or plugins develop parts of the app independently.

## Registering a view

From a service, use `ViewRegistryService` to register a view type:

```typescript theme={null}
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Service } from "@zenbujs/core/runtime"
import { ViewRegistryService } from "@zenbujs/core/services"

export class TerminalService extends Service.create({
  key: "terminal",
  deps: { viewRegistry: ViewRegistryService },
}) {
  async evaluate() {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const viewRoot = path.resolve(here, "..", "..", "views", "terminal")
    await this.ctx.viewRegistry.register({
      type: "terminal",
      root: viewRoot,
      configFile: false,
      meta: { kind: "view", label: "Terminal" },
    })
  }
}
```

The view directory must contain an `index.html` and a `main.tsx` that mounts a React tree wrapped in `<ZenbuProvider>`.

## Embedding a view

```tsx theme={null}
import { View } from "@zenbujs/core/react"

<View type="terminal" args={{ tabId }} />
```

## Reading view args

Inside the child view, use `useViewArgs` to read the args passed by the parent:

```tsx theme={null}
import { useViewArgs } from "@zenbujs/core/react"

function TerminalApp() {
  const { tabId } = useViewArgs<{ tabId: string }>()
  // ...
}
```

When the parent updates `args`, the hook re-renders with the new values.


# Releasing to Production
Source: https://zenbulabs.mintlify.app/guides/production



A Zenbu.js app ships in two pieces:

* **The Electron app.** A small `.app` that contains a launcher and a bundled package manager. This is what the user installs.
* **A git repository (the mirror).** A separate git repository that mirrors your development repo. It contains only the files needed to run the app. On first launch the Electron app clones the mirror, and on subsequent launches it pulls the latest version.

Because the source lives in a separate repository, you can push updates without rebuilding or re-distributing the Electron app. Auto-updates can be implemented through git pulls, so shipping a new version is as fast as pushing a commit.

## Build config

The build is configured inside `zenbu.config.ts` using `defineBuildConfig`:

```typescript zenbu.config.ts theme={null}
import {
  defineConfig,
  definePlugin,
  defineBuildConfig,
} from "@zenbujs/core/config";

export default defineConfig({
  // ...
  build: defineBuildConfig({
    include: [
      "src/**/*",
      "package.json",
      "pnpm-lock.yaml",
      "tsconfig.json",
      "zenbu.config.ts",
      "vite.config.ts",
    ],
    ignore: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    mirror: {
      target: "your-org/your-app",
      branch: "main",
    },
  }),
});
```

### include and ignore

`include` is an array of glob patterns that determines which files from your project end up in the staged source. Everything else is excluded. Use `ignore` to filter out files that match an include pattern but shouldn't ship, like tests or dev-only code.

### Transforms

Build plugins let you transform files during staging or emit new files. Each plugin receives every file and can modify its contents, drop it entirely, or leave it unchanged.

```typescript theme={null}
import { defineBuildConfig } from "@zenbujs/core/config";
import type { BuildPlugin } from "@zenbujs/core/config";

const injectLicense: BuildPlugin = {
  name: "inject-license",
  done(ctx) {
    ctx.emit("LICENSE", "MIT License\n...");
  },
};

export default defineBuildConfig({
  // ...
  plugins: [injectLicense],
});
```

A build plugin can define a `transform(path, contents)` function that runs on each file. Returning a string replaces the file's contents, returning `null` drops the file, and returning nothing leaves it as-is. The `done` function runs after all files are processed and can emit additional files with `ctx.emit()`.

## Git repository

Any git remote works as the source repository, for example GitHub, GitLab, or a self-hosted server.

When the user launches the app for the first time, the Electron app clones this repository into `~/.zenbu/<app-name>/`. On subsequent launches, it fetches the latest commits and checks out the most recent compatible version. This is also how updates are delivered: push new source to the mirror, and users pick it up on their next launch.

The staged source is published to the mirror with:

```bash theme={null}
# First time
pnpm run publish:source init

# Subsequent pushes
pnpm run publish:source push
```

## Host version

The Electron app's version number comes from `package.json#version`. `zen build:electron` reads it at build time and bakes it into the `.app` so subsequent `git pull`s of the source can't change it. Bump `package.json#version` whenever you ship a new `.app`.

The source declares which Electron app versions it's compatible with through a semver range in the same `package.json`:

```json package.json theme={null}
{
  "version": "0.0.6",
  "zenbu": {
    "host": ">=0.0.0 <0.1.0"
  }
}
```

When the launcher fetches new source, it checks whether the latest commit is compatible with the installed Electron app. If it is, it checks out that commit. If not, it searches backwards through the git history to find the most recent compatible commit. This means you can push source that requires a newer Electron app without breaking users who haven't updated yet.

## Package manager

The Electron app bundles a package manager that runs `install` on first launch and whenever the lockfile changes. By default it bundles pnpm, but you can change it in the build config:

```typescript theme={null}
defineBuildConfig({
  // ...
  packageManager: { type: "bun", version: "1.3.12" },
});
```

Supported options are `pnpm`, `npm`, `yarn`, and `bun`. The specified version is downloaded and cached during `zen build:electron`, then packaged into the `.app` bundle so the user's machine doesn't need a package manager installed.

## Installing screen

The first launch requires cloning the source and installing dependencies, which can take a few seconds. You can provide an `installing.html` file that the launcher shows during this process.

Drop it next to your renderer entry:

```
src/renderer/
├─ index.html
├─ main.tsx
└─ installing.html
```

`zen build:electron` picks it up automatically. The page receives progress events through a small API exposed on `window.zenbuInstall`:

```html installing.html theme={null}
<!doctype html>
<html>
  <head>
    <style>
      body {
        background: #111;
        color: #e5e5e5;
        font-family: system-ui, sans-serif;
      }
      .progress {
        width: 280px;
        height: 4px;
        background: #222;
        border-radius: 2px;
        overflow: hidden;
      }
      .bar {
        background: #6a59ff;
        height: 100%;
        transition: width 200ms;
      }
    </style>
  </head>
  <body>
    <div id="step">Starting...</div>
    <div class="progress"><div class="bar" id="bar"></div></div>
    <script>
      window.zenbuInstall.on("step", ({ label }) => {
        document.getElementById("step").textContent = label;
      });
      window.zenbuInstall.on("progress", ({ ratio }) => {
        if (ratio != null)
          document.getElementById("bar").style.width = `${ratio * 100}%`;
      });
      window.zenbuInstall.on("error", ({ message }) => {
        document.getElementById("step").textContent = message;
      });
    </script>
  </body>
</html>
```

The available events are:

| Event      | Payload                                                               |
| ---------- | --------------------------------------------------------------------- |
| `step`     | `{ id: "clone" \| "fetch" \| "install" \| "handoff", label: string }` |
| `message`  | `{ text: string }`                                                    |
| `progress` | `{ phase?: string, loaded?: number, total?: number, ratio?: number }` |
| `done`     | `{ id: string }`                                                      |
| `error`    | `{ id?: string, message: string }`                                    |

The window closes automatically once the app is ready. This screen only runs in production. It never appears during development.

## Building

There are two build steps:

```bash theme={null}
# 1. Stage source files (apply include/ignore/transforms)
pnpm run build:source

# 2. Build the Electron binary
pnpm run build:electron
```

`build:source` walks your project, applies the include and ignore patterns, runs any transform plugins, and writes the staged output. `build:electron` bundles the launcher, the toolchain, and the installing screen into an Electron `.app` using electron-builder.

You can pass flags through to electron-builder:

```bash theme={null}
pnpm run build:electron -- --mac dmg
pnpm run build:electron -- --publish always
```


# Introduction
Source: https://zenbulabs.mintlify.app/introduction



Zenbu.js is a framework for building hackable desktop apps.

Apps built with Zenbu.js are designed to be modified after they ship. Users can edit the source code directly, or install plugins that extend the app with new functionality.

The framework also handles the hard parts of desktop development for you, like syncing state between processes, RPC, and hot-reloading everything as you make changes.

### Why build a hackable app

* Coding agents can generate and customize software on demand for a specific use case. A hackable app gives them full access to do that.
* Letting people modify your app means more directions get explored than you could reach on your own.
* Extensible code tends to be more maintainable, because it's already written to be changed.

## Quick links

<CardGroup>
  <Card title="Quickstart" icon="rocket" href="/quickstart">
    Create your first Zenbu.js app in under a minute.
  </Card>

  <Card title="Concepts" icon="book" href="/concepts">
    Understand the plugin model, state, and RPC.
  </Card>
</CardGroup>


# Quickstart
Source: https://zenbulabs.mintlify.app/quickstart



<Steps>
  <Step title="Scaffold the project">
    <Tabs>
      <Tab title="npm">
        ```bash theme={null}
        npx create-zenbu-app my-app
        ```
      </Tab>

      <Tab title="pnpm">
        ```bash theme={null}
        pnpx create-zenbu-app my-app
        ```
      </Tab>

      <Tab title="yarn">
        ```bash theme={null}
        yarn dlx create-zenbu-app my-app
        ```
      </Tab>

      <Tab title="bun">
        ```bash theme={null}
        bunx create-zenbu-app my-app
        ```
      </Tab>
    </Tabs>

    This creates a new directory with everything you need to get started.
  </Step>

  <Step title="Install dependencies">
    <Tabs>
      <Tab title="pnpm">
        ```bash theme={null}
        cd my-app && pnpm install
        ```
      </Tab>

      <Tab title="npm">
        ```bash theme={null}
        cd my-app && npm install
        ```
      </Tab>

      <Tab title="yarn">
        ```bash theme={null}
        cd my-app && yarn
        ```
      </Tab>

      <Tab title="bun">
        ```bash theme={null}
        cd my-app && bun install
        ```
      </Tab>
    </Tabs>
  </Step>

  <Step title="Start the app">
    <Tabs>
      <Tab title="pnpm">
        ```bash theme={null}
        pnpm run dev
        ```
      </Tab>

      <Tab title="npm">
        ```bash theme={null}
        npm run dev
        ```
      </Tab>

      <Tab title="yarn">
        ```bash theme={null}
        yarn dev
        ```
      </Tab>

      <Tab title="bun">
        ```bash theme={null}
        bun run dev
        ```
      </Tab>
    </Tabs>

    Your app will open in a new window, and any changes you make will hot-reload.
  </Step>
</Steps>

## Project structure

After scaffolding, your project looks like this:

```
my-app/
├── zenbu.config.ts       # The only required config file
├── package.json
├── vite.config.ts
├── tsconfig.json
└── src/
    ├── main/
    │   ├── schema.ts     # Zod schema for the database
    │   └── services/
    │       └── app.ts    # Opens the main window on boot
    └── renderer/
        ├── index.html
        ├── main.tsx
        └── App.tsx
```

The `zenbu.config.ts` file is the entry point. It tells Zenbu.js where everything in your project is.

```typescript zenbu.config.ts theme={null}
import { defineConfig, definePlugin } from "@zenbujs/core/config"

export default defineConfig({
  db: "./.zenbu/db",
  uiEntrypoint: "./src/renderer",
  plugins: [
    definePlugin({
      name: "app",
      services: ["./src/main/services/*.ts"],
      schema: "./src/main/schema.ts",
    }),
  ],
})
```

## Available scripts

| Script                    | What it does                                            |
| ------------------------- | ------------------------------------------------------- |
| `pnpm run dev`            | Run the app locally with hot reloading.                 |
| `pnpm run link`           | Regenerate types after changing your project structure. |
| `pnpm run db:generate`    | Create a migration after changing your database schema. |
| `pnpm run build:source`   | Stage the source tree for publishing.                   |
| `pnpm run build:electron` | Produce a signed `.app` / installer.                    |

## Next steps

<CardGroup>
  <Card title="Concepts" icon="book" href="/concepts">
    Learn the plugin model, state, and RPC.
  </Card>
</CardGroup>


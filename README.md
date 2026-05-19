<p align="center">
  <img src="./packages/website/app/icon.png" alt="Zenbu.js Logo" width="100" />
</p>

<div align="center">

[![CI](https://img.shields.io/github/actions/workflow/status/zenbu-labs/zenbu.js/ci.yml?branch=main&label=CI)](https://github.com/zenbu-labs/zenbu.js/actions)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/zenbu-labs/zenbu.js/blob/main/LICENSE)
[![npm version](https://img.shields.io/npm/v/@zenbujs/core.svg?label=npm%20package)](https://www.npmjs.com/package/@zenbujs/core)
![Status: Alpha](https://img.shields.io/badge/status-alpha-orange)

</div>

<p align="center">

  <br/>

  <span>
      <a href="https://zenbu.dev" style="text-decoration: none;">Zenbu.js</a> is a JavaScript framework for building hackable software.
  </span>

</p>

<p align="center">
  <a href="https://zenbulabs.mintlify.app" style="text-decoration: none;">Documentation</a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="https://deepwiki.com/zenbu-labs/zenbu.js" style="text-decoration: none;">DeepWiki</a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="https://discord.gg/t3jzHHfc6z" style="text-decoration: none;">Discord</a>
  &nbsp;&nbsp;·&nbsp;&nbsp;
  <a href="https://www.zenbu.dev/demo" style="text-decoration: none;">Try the demo&nbsp;→</a>
</p>

<br />

<p align="center">
  <b>Get started in 5 seconds</b>
</p>

```bash
npx create-zenbu-app
```

<br />

## Why Zenbu.js

1. Coding agents can generate and customize software on demand for a specific use case. A hackable app gives them full access to do that.

2. Letting people modify your app means more directions get explored than you could reach on your own.

3. Extensible code tends to be more maintainable, because it’s already written to be changed.

## How does it work

Users can modify Zenbu apps in 2 ways:

### Modifying the raw source code

When a Zenbu app is built for production, there is no TypeScript compilation or bundling step. The same source code you wrote in development will be downloaded by the user and stored in `~/.zenbu/<app-name>`. When the app launches, it discovers the app code, dynamically compiles it, and runs the JavaScript using Electron's Node.js runtime.

All the source code in this directory is being watched for changes. When there is a change, the app will re-run affected code nearly instantly (also known as hot reloading). Hot reloading is implemented both in the main process and the renderer process.

The codebase stored inside `~/.zenbu/<app-name>` is tracked by git. This makes it possible for a user to edit the source code without losing changes when the application code gets updated. The git repo is linked to a remote repository owned by the developer, so updates are represented as running `git pull` on the user's device.

### Injecting plugins

Editing the raw source code of the application can be risky. If a user and the developer have conflicting edits, the user needs to spend time merging changes. This motivates plugins - a way to inject code into the application that can modify behavior without editing the raw source code.

Plugins run in the same process as the application code and get access to the same APIs. This means any feature written in the main app could be written as a plugin.

When you write an app in Zenbu your code is **extensible by default**, so plugins can extend it without you designing a plugin API up front. For more complex parts of your app that need a richer extension model, you can define your own on top.

Plugins hot reload just like application code, because application code is itself implemented as a plugin.

## What this is not

Zenbu.js is not a one-size-fits-all model for building extensible applications. It provides a general-purpose way to load external code, with primitives for hot reloading, sharing state, and extending UI. For more complex behavior that isn't covered by Zenbu's architecture, you'll need your own conventions and systems for how that part gets extended, defined inside your Zenbu app.

## Compatibility

| Runtime        | Status       |
| -------------- | ------------ |
| Electron       | 🧪 Alpha     |
| Node.js        | 🚧 WIP       |
| Tauri          | 🚧 WIP       |
| Browser-native | 🚧 WIP       |

## Roadmap

- Non sandboxed out-of-process plugins
- Improved sandboxing controls for plugins
- Performance work
- Migrate custom node HMR to Vite's [environments API](https://vite.dev/guide/api-environment)
- HMR for `node_modules`, advice, and content scripts
- Windows and Linux support
- Automatic CLI per app
- Git-based auto updater
- WebRTC adapter for zenrpc and kyju (the database)
- Add optimized production mode that pre-compiles and bundles the typescript to javascript (would opt project out of allowing its source code edited at runtime by user)
- Support for running outside of electron (local node.js process + website, within tauri, natively on the web)
- Plugin devtools

## Project

Zenbu.js is a project from [Zenbu Labs](https://github.com/zenbu-labs).

## FAQ

<details>
<summary><b>What happens if a user edits the app and it conflicts with a future update?</b></summary>

<br/>

The source code on the user's device is tracked by git, so you can alert them when there's a conflict. In practice the user can use their coding agent to resolve the conflict

Users also have the option to make changes only via plugins, which can never have merge conflicts.

</details>

<details>
<summary><b>How does my app become extensible?</b></summary>

<br/>

Zenbu.js organizes your app so new code can be loaded into your application. The APIs are designed with the expectation that new unknown code will want to plug into your application to access and modify functionality you defined.

</details>

<details>
<summary><b>Do I need to use Electron?</b></summary>

<br/>

For now, yes. But support for other runtimes like Tauri and pure Node.js is coming soon.

</details>

<details>
<summary><b>Is it ready for production usage?</b></summary>

<br/>

No - Zenbu.js is still in alpha, so it may still contain bugs and have large API changes

</details>

<br />

<p align="center">
  <a href="https://zenbulabs.mintlify.app" style="text-decoration: none;">Read the docs&nbsp;→</a>
</p>

import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: {
      "setup-gate": "src/setup-gate.ts",
      index: "src/index.ts",
      "env-bootstrap": "src/env-bootstrap.ts",
      registry: "src/registry.ts",
      "registry-generated": "src/registry-generated.ts",
      events: "src/events.ts",
      runtime: "src/runtime.ts",
      schema: "src/schema.ts",
      "node-loader": "../advice/src/node-loader.ts",
      "advice-runtime": "../advice/src/runtime/index.ts",
      "loaders/zenbu": "src/loaders/zenbu.ts",
      "prelude/theme-listener": "src/prelude/theme-listener.ts",
      "prelude/shortcut-bridge": "src/prelude/shortcut-bridge.ts",
      "prelude/boot-trace": "src/prelude/boot-trace.ts",
      "prelude/view-args": "src/prelude/view-args.ts",
      "boot-trace": "src/boot-trace.ts",
      "services/index": "src/services/index.ts",
      "services/default": "src/services/default.ts",
      db: "src/db.ts",
      rpc: "src/rpc.ts",
      react: "src/react.ts",
      advice: "src/advice.ts",
      vite: "src/vite.ts",
      "cli/bin": "src/cli/bin.ts",
      "cli/build": "src/cli/build.ts",
      "cli/resolve-config": "src/cli/resolve-config.ts",
      config: "src/config.ts",
    },
    format: "esm",
    dts: { eager: true },
    platform: "node",
    target: "node20",
    clean: true,
    outDir: "dist",
    outExtensions: () => ({ js: ".mjs" }),
    deps: {
      alwaysBundle: [
        "@zenbu/advice",
        "@zenbu/kyju",
        "@zenbu/zenrpc",
      ],
    },
  },
  {
    entry: {
      launcher: "src/launcher.ts",
    },
    format: "esm",
    platform: "node",
    target: "node20",
    deps: {
      // Inline isomorphic-git (and its node-only http transport) plus
      // semver (used by shared/range-resolver.ts) into the launcher
      // bundle. The .app ships a bundle package.json with NO declared
      // deps, so anything not inlined here will fail to resolve at
      // runtime. `electron` is the lone exception — Electron's main
      // process provides it natively.
      alwaysBundle: ["isomorphic-git", "isomorphic-git/http/node", "semver"],
      neverBundle: ["electron"],
    },
    clean: false,
    dts: false,
    outDir: "dist",
    outExtensions: () => ({ js: ".mjs" }),
  },
  {
    // Sandboxed Electron preloads MUST be CommonJS — Electron disables
    // ESM in sandboxed contexts. Built into a separate bundle so the rest
    // of dist stays ESM.
    entry: {
      "installing-preload": "src/installing-preload.ts",
    },
    format: "cjs",
    platform: "node",
    target: "node20",
    deps: {
      neverBundle: ["electron"],
    },
    clean: false,
    dts: false,
    outDir: "dist",
    outExtensions: () => ({ js: ".cjs" }),
  },
]);

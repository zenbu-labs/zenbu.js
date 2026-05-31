import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs"
import fsp from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  collectArgvPlugins,
  loadConfig,
} from "../src/cli/lib/load-config"

/**
 * Tests for the `--plugin=<path>` argv loader path. The flag is the
 * runtime contract the in-app "Run in Dev" button relies on — the host
 * spawns itself with `--plugin=<manifest>` and the framework loads
 * that plugin alongside whatever the JSONC manifests declare.
 *
 * The unit-level checks (`collectArgvPlugins`) are cheap and
 * deterministic; the integration check (`loadConfig`) writes a
 * tiny `zenbu.config.ts` + `zenbu.plugins.jsonc` + plugin manifest
 * into `os.tmpdir()` and runs the loader end-to-end.
 */

describe("collectArgvPlugins", () => {
  it("returns [] when no --plugin flags are present", () => {
    expect(collectArgvPlugins([])).toEqual([])
    expect(
      collectArgvPlugins(["node", "main.mjs", "--project=/tmp/x"]),
    ).toEqual([])
  })

  it("captures every --plugin= value in order", () => {
    expect(
      collectArgvPlugins([
        "--plugin=./a.ts",
        "--something=else",
        "--plugin=/abs/b.ts",
      ]),
    ).toEqual(["./a.ts", "/abs/b.ts"])
  })

  it("ignores empty values", () => {
    expect(
      collectArgvPlugins(["--plugin=", "--plugin=ok.ts"]),
    ).toEqual(["ok.ts"])
  })
})

describe("loadConfig --plugin= integration", () => {
  let sandbox: string
  let originalArgv: string[]
  let originalCwd: string

  const configModuleAbs = path.resolve(
    __dirname,
    "..",
    "src",
    "config.ts",
  )

  beforeEach(async () => {
    sandbox = await fsp.mkdtemp(
      path.join(os.tmpdir(), "zenbu-argv-plugins-"),
    )
    await fsp.mkdir(path.join(sandbox, "ui"), { recursive: true })
    await fsp.writeFile(
      path.join(sandbox, "ui", "index.html"),
      "<!doctype html><html><body></body></html>",
    )
    // Base plugin file referenced by the tracked manifest.
    await fsp.writeFile(
      path.join(sandbox, "base.plugin.ts"),
      `import { definePlugin } from "${configModuleAbs}"\n` +
        `export default definePlugin({ name: "base", services: [] })\n`,
    )
    await fsp.writeFile(
      path.join(sandbox, "zenbu.plugins.jsonc"),
      JSON.stringify(
        { plugins: [{ path: "./base.plugin.ts", enabled: true }] },
        null,
        2,
      ),
    )
    await fsp.writeFile(
      path.join(sandbox, "zenbu.config.ts"),
      `import { defineConfig } from "${configModuleAbs}"\n` +
        `export default defineConfig({\n` +
        `  uiEntrypoint: "./ui",\n` +
        `  pluginsFiles: ["./zenbu.plugins.jsonc"],\n` +
        `})\n`,
    )
    originalArgv = process.argv.slice()
    originalCwd = process.cwd()
  })

  afterEach(async () => {
    process.argv = originalArgv
    process.chdir(originalCwd)
    if (!process.env.ZENBU_KEEP_ARGV_SANDBOX) {
      await fsp.rm(sandbox, { recursive: true, force: true })
    }
  })

  it("loads a --plugin=<absolute path> alongside the manifest plugins", async () => {
    const extra = path.join(sandbox, "extra.plugin.ts")
    await fsp.writeFile(
      extra,
      `import { definePlugin } from "${configModuleAbs}"\n` +
        `export default definePlugin({ name: "extra", services: [] })\n`,
    )

    process.argv = [...originalArgv, `--plugin=${extra}`]
    const { resolved, pluginSourceFiles } = await loadConfig(sandbox)

    expect(resolved.plugins.map((p) => p.name)).toEqual(["base", "extra"])
    expect(pluginSourceFiles).toContain(extra)
  })

  it("hard-fails when --plugin= points at a nonexistent path", async () => {
    process.argv = [
      ...originalArgv,
      `--plugin=${path.join(sandbox, "does-not-exist.plugin.ts")}`,
    ]
    await expect(loadConfig(sandbox)).rejects.toThrow(/does not exist/)
  })

  it("hard-fails when --plugin= points at a non-.ts/.js file", async () => {
    const badPath = path.join(sandbox, "plugin.json")
    fs.writeFileSync(badPath, "{}")
    process.argv = [...originalArgv, `--plugin=${badPath}`]
    await expect(loadConfig(sandbox)).rejects.toThrow(
      /must point at a \.ts\/\.js file/,
    )
  })

  it("skips --plugin= when called with skipLocalManifests (build path)", async () => {
    const extra = path.join(sandbox, "extra.plugin.ts")
    await fsp.writeFile(
      extra,
      `import { definePlugin } from "${configModuleAbs}"\n` +
        `export default definePlugin({ name: "extra", services: [] })\n`,
    )
    process.argv = [...originalArgv, `--plugin=${extra}`]
    const { resolved } = await loadConfig(sandbox, {
      skipLocalManifests: true,
    })
    expect(resolved.plugins.map((p) => p.name)).toEqual(["base"])
  })
})

describe("loadConfig JSONC manifest semantics", () => {
  let sandbox: string
  const configModuleAbs = path.resolve(__dirname, "..", "src", "config.ts")

  beforeEach(async () => {
    sandbox = await fsp.mkdtemp(
      path.join(os.tmpdir(), "zenbu-jsonc-manifests-"),
    )
    await fsp.mkdir(path.join(sandbox, "ui"), { recursive: true })
    await fsp.writeFile(
      path.join(sandbox, "ui", "index.html"),
      "<!doctype html><html><body></body></html>",
    )
    await fsp.writeFile(
      path.join(sandbox, "a.plugin.ts"),
      `import { definePlugin } from "${configModuleAbs}"\n` +
        `export default definePlugin({ name: "a", services: [] })\n`,
    )
    await fsp.writeFile(
      path.join(sandbox, "b.plugin.ts"),
      `import { definePlugin } from "${configModuleAbs}"\n` +
        `export default definePlugin({ name: "b", services: [] })\n`,
    )
    await fsp.writeFile(
      path.join(sandbox, "zenbu.config.ts"),
      `import { defineConfig } from "${configModuleAbs}"\n` +
        `export default defineConfig({\n` +
        `  uiEntrypoint: "./ui",\n` +
        `  pluginsFiles: ["./tracked.jsonc", "./local.jsonc"],\n` +
        `})\n`,
    )
  })

  afterEach(async () => {
    await fsp.rm(sandbox, { recursive: true, force: true })
  })

  it("tolerates comments and trailing commas", async () => {
    await fsp.writeFile(
      path.join(sandbox, "tracked.jsonc"),
      `// header comment\n` +
        `{\n` +
        `  /* both kinds of comments */\n` +
        `  "plugins": [\n` +
        `    { "path": "./a.plugin.ts", "enabled": true, }, // trailing comma\n` +
        `  ],\n` +
        `}\n`,
    )
    const { resolved } = await loadConfig(sandbox)
    expect(resolved.plugins.map((p) => p.name)).toEqual(["a"])
  })

  it("filters out entries with enabled: false", async () => {
    await fsp.writeFile(
      path.join(sandbox, "tracked.jsonc"),
      JSON.stringify(
        {
          plugins: [
            { path: "./a.plugin.ts", enabled: true },
            { path: "./b.plugin.ts", enabled: false },
          ],
        },
        null,
        2,
      ),
    )
    const { resolved } = await loadConfig(sandbox)
    expect(resolved.plugins.map((p) => p.name)).toEqual(["a"])
  })

  it("local manifest overrides tracked manifest's enabled flag", async () => {
    await fsp.writeFile(
      path.join(sandbox, "tracked.jsonc"),
      JSON.stringify(
        { plugins: [{ path: "./a.plugin.ts", enabled: true }] },
        null,
        2,
      ),
    )
    await fsp.writeFile(
      path.join(sandbox, "local.jsonc"),
      JSON.stringify(
        { plugins: [{ path: "./a.plugin.ts", enabled: false }] },
        null,
        2,
      ),
    )
    const { resolved } = await loadConfig(sandbox)
    expect(resolved.plugins).toEqual([])
  })

  it("watches missing manifest files for creation", async () => {
    await fsp.writeFile(
      path.join(sandbox, "tracked.jsonc"),
      JSON.stringify(
        { plugins: [{ path: "./a.plugin.ts", enabled: true }] },
        null,
        2,
      ),
    )
    // local.jsonc deliberately absent
    const { pluginSourceFiles } = await loadConfig(sandbox)
    expect(pluginSourceFiles).toContain(path.join(sandbox, "local.jsonc"))
  })

  it("passes args through to ResolvedPlugin", async () => {
    await fsp.writeFile(
      path.join(sandbox, "tracked.jsonc"),
      JSON.stringify(
        {
          plugins: [
            { path: "./a.plugin.ts", enabled: true, args: { x: 42 } },
          ],
        },
        null,
        2,
      ),
    )
    const { resolved } = await loadConfig(sandbox)
    expect(resolved.plugins[0]!.args).toEqual({ x: 42 })
  })

  it("rejects the legacy `plugins` array with a migration hint", async () => {
    await fsp.writeFile(
      path.join(sandbox, "zenbu.config.ts"),
      `import { defineConfig, definePlugin } from "${configModuleAbs}"\n` +
        `export default defineConfig({\n` +
        `  uiEntrypoint: "./ui",\n` +
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        `  plugins: [definePlugin({ name: "a", services: [] })],\n` +
        `} as any)\n`,
    )
    await expect(loadConfig(sandbox)).rejects.toThrow(
      /\`plugins\` array is no longer supported/,
    )
  })
})

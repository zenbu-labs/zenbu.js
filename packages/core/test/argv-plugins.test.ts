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
 * Tests for the `--plugin=<path>` argv loader path added alongside
 * `localPlugins`. The flag is the runtime contract the in-app
 * "Run in Dev" button relies on \u2014 the host spawns itself with
 * `--plugin=<manifest>` and the framework loads that plugin
 * alongside the configured set.
 *
 * The unit-level checks (`collectArgvPlugins`) are cheap and
 * deterministic; the integration check (`loadConfig`) writes a
 * tiny zenbu.config + plugin manifest into `os.tmpdir()` and runs
 * the loader end-to-end so we exercise the resolve-and-validate
 * path, including the "file doesn't exist" failure mode.
 */

describe("collectArgvPlugins", () => {
  it("returns [] when no --plugin flags are present", () => {
    expect(collectArgvPlugins([])).toEqual([])
    expect(
      collectArgvPlugins(["node", "main.mjs", "--project=/tmp/x"]),
    ).toEqual([])
  })

  it("extracts a single --plugin path", () => {
    expect(
      collectArgvPlugins(["node", "main.mjs", "--plugin=/abs/path.ts"]),
    ).toEqual(["/abs/path.ts"])
  })

  it("extracts multiple --plugin paths in argv order", () => {
    expect(
      collectArgvPlugins([
        "--plugin=/a/zenbu.plugin.ts",
        "--project=/proj",
        "--plugin=./relative/zenbu.plugin.ts",
      ]),
    ).toEqual(["/a/zenbu.plugin.ts", "./relative/zenbu.plugin.ts"])
  })

  it("ignores empty values (e.g. `--plugin=` with no value)", () => {
    expect(
      collectArgvPlugins(["--plugin=", "--plugin=ok.ts"]),
    ).toEqual(["ok.ts"])
  })
})

describe("loadConfig --plugin= integration", () => {
  let sandbox: string
  let originalArgv: string[]
  let originalCwd: string

  // Resolve once: the config file the sandbox writes imports
  // `defineConfig` / `definePlugin` by absolute path so it works
  // regardless of where the tmpdir lives.
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
    // Minimal project: config + uiEntrypoint + one inline plugin so the
    // happy path returns a usable ResolvedConfig.
    await fsp.mkdir(path.join(sandbox, "ui"), { recursive: true })
    await fsp.writeFile(
      path.join(sandbox, "ui", "index.html"),
      "<!doctype html><html><body></body></html>",
    )
    await fsp.writeFile(
      path.join(sandbox, "zenbu.config.ts"),
      `import { defineConfig, definePlugin } from "${configModuleAbs}"\n` +
        `export default defineConfig({\n` +
        `  uiEntrypoint: "./ui",\n` +
        `  plugins: [\n` +
        `    definePlugin({ name: "base", services: [] }),\n` +
        `  ],\n` +
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

  it("loads a --plugin=<absolute path> alongside the configured plugins", async () => {
    // Drop an extra plugin manifest somewhere off-tree to make sure
    // we resolve absolute paths and the result lands in `plugins[]`.
    const extra = path.join(sandbox, "extra.plugin.ts")
    await fsp.writeFile(
      extra,
      `import { definePlugin } from "${configModuleAbs}"\n` +
        `export default definePlugin({ name: "extra", services: [] })\n`,
    )

    process.argv = [...originalArgv, `--plugin=${extra}`]
    const { resolved, pluginSourceFiles } = await loadConfig(sandbox)

    expect(resolved.plugins.map(p => p.name)).toEqual(["base", "extra"])
    expect(pluginSourceFiles).toContain(extra)
  })

  it("hard-fails when --plugin= points at a nonexistent path", async () => {
    process.argv = [
      ...originalArgv,
      `--plugin=${path.join(sandbox, "does-not-exist.plugin.ts")}`,
    ]
    await expect(loadConfig(sandbox)).rejects.toThrow(
      /does not exist/,
    )
  })

  it("hard-fails when --plugin= points at a non-.ts/.js file", async () => {
    const badPath = path.join(sandbox, "plugin.json")
    fs.writeFileSync(badPath, "{}")
    process.argv = [...originalArgv, `--plugin=${badPath}`]
    await expect(loadConfig(sandbox)).rejects.toThrow(
      /must point at a \.ts\/\.js file/,
    )
  })

  it("skips --plugin= when called with skipLocalPlugins (build path)", async () => {
    const extra = path.join(sandbox, "extra.plugin.ts")
    await fsp.writeFile(
      extra,
      `import { definePlugin } from "${configModuleAbs}"\n` +
        `export default definePlugin({ name: "extra", services: [] })\n`,
    )
    process.argv = [...originalArgv, `--plugin=${extra}`]
    const { resolved } = await loadConfig(sandbox, {
      skipLocalPlugins: true,
    })
    expect(resolved.plugins.map(p => p.name)).toEqual(["base"])
  })
})

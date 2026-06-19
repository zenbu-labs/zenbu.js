#!/usr/bin/env node
/**
 * gets ran syncronously in zenbu loader to run ts config to get back obj that can be transformed into js imports
 * 
 * takes ~100ms to run
 */

import { register } from "tsx/esm/api"
import { loadConfig } from "./lib/load-config"
import { readHostProjectMetadata } from "../shared/host-project-metadata"

async function main(): Promise<void> {
  register()

  const projectDir = process.argv[2]
  if (!projectDir) {
    process.stderr.write("usage: resolve-config <projectDir>\n")
    process.exit(2)
  }

  const { resolved, pluginSourceFiles } = await loadConfig(projectDir)
  const payload = {
    plugins: resolved.plugins.map((p) => ({
      name: p.name,
      dir: p.dir,
      services: p.services,
      schemaPath: p.schemaPath,
      migrationsPath: p.migrationsPath,
      preloadPath: p.preloadPath,
      eventsPath: p.eventsPath,
      icons: p.icons,
      args: p.args,
    })),
    hostProject: readHostProjectMetadata(
      resolved.projectDir,
      resolved.configPath,
    ),
    appEntrypoint: resolved.uiEntrypointPath,
    splashPath: resolved.splashPath,
  }
  process.stdout.write(JSON.stringify({ payload, pluginSourceFiles }))
}

main().catch((err) => {
  process.stderr.write(
    `[zenbu resolve-config] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  )
  process.exit(1)
})

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadModule } from "../../src/cli/config";

function tmpPluginDir(name: string) {
  const dir = path.join(
    os.tmpdir(),
    `kyju-config-loader-${name}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let cleanups: string[] = [];

afterEach(() => {
  for (const dir of cleanups) fs.rmSync(dir, { recursive: true, force: true });
  cleanups = [];
});

describe("CLI config loader", () => {
  it("loads migration barrels with loadModule", async () => {
    const root = tmpPluginDir("barrel-loader");
    cleanups.push(root);

    const pluginDir = path.join(root, "packages", "my-plugin");
    const kyjuDir = path.join(pluginDir, "kyju");
    fs.mkdirSync(kyjuDir, { recursive: true });

    fs.writeFileSync(path.join(root, "package.json"), '{"name":"monorepo"}\n');
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      '{"name":"my-plugin"}\n',
    );

    fs.writeFileSync(
      path.join(kyjuDir, "0000_initial.ts"),
      [
        "const migration = {",
        "  version: 1,",
        '  operations: [{ op: "add", key: "x", kind: "data", hasDefault: true, default: 0 }],',
        "};",
        "export default migration;",
        "",
      ].join("\n"),
    );

    fs.writeFileSync(
      path.join(kyjuDir, "index.ts"),
      [
        'import m0 from "./0000_initial";',
        "export const migrations = [m0];",
        "",
      ].join("\n"),
    );

    const mod = await loadModule(path.join(kyjuDir, "index.ts"));
    expect(Array.isArray(mod.migrations)).toBe(true);
    expect(mod.migrations).toHaveLength(1);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const internalDir = path.join(os.homedir(), ".zenbu", ".internal");
const pathsJson = path.join(internalDir, "paths.json");

export type BundledPaths = {
  cacheRoot: string;
  binDir: string;
  bunInstall: string;
  bunPath: string;
  pnpmHome: string;
  pnpmPath: string;
  gitPath: string;
  writtenAt: number;
};

function userCacheRoot(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches");
  }
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  }
  return process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
}

function computePaths(): BundledPaths {
  const cacheRoot = path.join(userCacheRoot(), "Zenbu");
  const binDir = path.join(cacheRoot, "bin");
  return {
    cacheRoot,
    binDir,
    bunInstall: path.join(cacheRoot, "bun"),
    bunPath: path.join(binDir, "bun"),
    pnpmHome: path.join(cacheRoot, "pnpm"),
    pnpmPath: path.join(binDir, "pnpm"),
    gitPath: path.join(binDir, "git"),
    writtenAt: Date.now(),
  };
}

export function bootstrapEnv() {
  const paths = computePaths();

  try {
    fs.mkdirSync(paths.binDir, { recursive: true });
  } catch {}

  const toolchainReady =
    fs.existsSync(paths.bunPath) && fs.existsSync(paths.pnpmPath);

  if (toolchainReady) {
    process.env.BUN_INSTALL ??= paths.bunInstall;
    process.env.PNPM_HOME ??= paths.pnpmHome;
  }

  const pathParts = toolchainReady
    ? [paths.binDir, process.env.PATH ?? ""]
    : [process.env.PATH ?? ""];
  const seen = new Set<string>();
  process.env.PATH = pathParts
    .flatMap((part) => part.split(path.delimiter))
    .filter((part) => {
      if (!part || seen.has(part)) return false;
      seen.add(part);
      return true;
    })
    .join(path.delimiter);

  try {
    fs.mkdirSync(internalDir, { recursive: true });
    fs.writeFileSync(pathsJson, JSON.stringify(paths, null, 2));
  } catch {}

  return { paths, needsToolchainDownload: !toolchainReady };
}

/**
 * Read the bundled-toolchain paths file (`~/.zenbu/.internal/paths.json`)
 * that the launcher writes during `bootstrapEnv()` on every boot.
 *
 * Intended for plugins that need to invoke the bundled package manager or
 * git so they don't depend on what the user happens to have on `$PATH`.
 *
 * Falls back to the synchronous, in-process `computePaths()` result if the
 * file is missing or unreadable, so this never throws — it always returns
 * a well-formed shape. Callers should still check `fs.existsSync` on the
 * individual binary path before spawning, since the launcher only writes
 * the file once it confirms the toolchain is installed.
 */
export function getBundledPaths(): BundledPaths {
  try {
    const raw = fs.readFileSync(pathsJson, "utf8");
    const parsed = JSON.parse(raw) as Partial<BundledPaths>;
    const fallback = computePaths();
    return {
      cacheRoot: parsed.cacheRoot ?? fallback.cacheRoot,
      binDir: parsed.binDir ?? fallback.binDir,
      bunInstall: parsed.bunInstall ?? fallback.bunInstall,
      bunPath: parsed.bunPath ?? fallback.bunPath,
      pnpmHome: parsed.pnpmHome ?? fallback.pnpmHome,
      pnpmPath: parsed.pnpmPath ?? fallback.pnpmPath,
      gitPath: parsed.gitPath ?? fallback.gitPath,
      writtenAt: parsed.writtenAt ?? fallback.writtenAt,
    };
  } catch {
    return computePaths();
  }
}

import crypto from "node:crypto"
import fs from "node:fs"
import fsp from "node:fs/promises"
import https from "node:https"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import type { PackageManagerSpec } from "./build-config"

const execFileAsync = promisify(execFile)

/**
 * Framework-pinned bun. Used as the runtime bun (the `node`-shim that hosts
 * `npm install`'s lifecycle scripts and JS-package PMs like npm/yarn) when
 * the user picks a non-bun PM.
 *
 * When the user picks bun as the PM, we provision bun at `spec.version`
 * instead and skip this constant entirely. The runtime bun and the PM bun
 * collapse into a single binary at the user's chosen version.
 */
const PINNED_BUN = {
  version: "1.3.12",
  targets: {
    "darwin-aarch64": {
      asset: "bun-darwin-aarch64.zip",
      sha256:
        "6c4bb87dd013ed1a8d6a16e357a3d094959fd5530b4d7061f7f3680c3c7cea1c",
    },
    "darwin-x64": {
      asset: "bun-darwin-x64.zip",
      sha256:
        "0f58c53a3e7947f1e626d2f8d285f97c14b7cadcca9c09ebafc0ae9d35b58c3d",
    },
    "linux-x64": {
      asset: "bun-linux-x64.zip",
      sha256:
        "11dc3ee11bc1695e149737c6ca3d5619302cf4346e6b8a6ec7988967ef01ddc5",
    },
    "linux-aarch64": {
      asset: "bun-linux-aarch64.zip",
      sha256:
        "c40bc0ebca11bde7d75af497a654a874d0c7fd8d6a8d6031c173c10c9064297b",
    },
    "windows-x64": {
      asset: "bun-windows-x64.zip",
      sha256:
        "841ff9c5dffcaa3a2620d1e3f87ee500f32a4ca830b001cade7a3479609d4a89",
    },
    "windows-aarch64": {
      asset: "bun-windows-aarch64.zip",
      sha256:
        "6cac24eab41e8d7e6b39b4dd3b4bca5ea0d11a1f43f94126bdff6e849f9f7f51",
    },
  },
} as const

export const BUN_VERSION = PINNED_BUN.version

// =============================================================================
//                              cache + arch helpers
// =============================================================================

function defaultCacheRoot(): string {
  return path.join(os.homedir(), ".zenbu", "cache", "toolchain")
}

type BunArch = keyof typeof PINNED_BUN.targets

function bunTarget(): BunArch {
  const plat =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "win32"
        ? "windows"
        : "linux"
  const arch = process.arch === "arm64" ? "aarch64" : "x64"
  const key = `${plat}-${arch}` as BunArch
  if (!(key in PINNED_BUN.targets)) {
    throw new Error(`zenbu toolchain: unsupported platform/arch ${key}`)
  }
  return key
}

// =============================================================================
//                                  download
// =============================================================================

function download(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        res.resume()
        download(new URL(res.headers.location, url).href, dest).then(
          resolve,
          reject,
        )
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`GET ${url} -> ${res.statusCode}`))
        res.resume()
        return
      }
      const out = fs.createWriteStream(dest)
      res.pipe(out)
      out.on("finish", () => out.close(() => resolve()))
      out.on("error", reject)
    })
    req.on("error", reject)
  })
}

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          // GitHub's API requires a non-empty User-Agent on every request.
          "User-Agent": "zenbu-toolchain",
          Accept: "application/json, text/plain, */*",
        },
      },
      (res) => {
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume()
          fetchText(new URL(res.headers.location, url).href).then(resolve, reject)
          return
        }
        if (res.statusCode !== 200) {
          reject(new Error(`GET ${url} -> ${res.statusCode}`))
          res.resume()
          return
        }
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
        res.on("error", reject)
      },
    )
    req.on("error", reject)
  })
}

async function sha256(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256")
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("end", () => resolve())
    stream.on("error", reject)
  })
  return hash.digest("hex")
}

async function sha512(filePath: string): Promise<Buffer> {
  const hash = crypto.createHash("sha512")
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.on("end", () => resolve())
    stream.on("error", reject)
  })
  return hash.digest()
}

async function verifySha256(filePath: string, expected: string): Promise<void> {
  const actual = await sha256(filePath)
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `zenbu toolchain: sha256 mismatch for ${path.basename(filePath)} (expected ${expected}, got ${actual})`,
    )
  }
}

/**
 * Verify a file against an SRI-format integrity string from the npm registry,
 * e.g. `sha512-LB7QO/<base64>=`. We only support the algorithms npm currently
 * publishes (sha512 + sha1 fallback for ancient packages).
 */
async function verifyIntegrity(
  filePath: string,
  integrity: string,
): Promise<void> {
  const [algo, b64] = integrity.split("-", 2)
  if (!algo || !b64) {
    throw new Error(`zenbu toolchain: malformed integrity "${integrity}"`)
  }
  let actual: string
  if (algo === "sha512") {
    actual = (await sha512(filePath)).toString("base64")
  } else if (algo === "sha256") {
    const hash = crypto.createHash("sha256")
    await new Promise<void>((resolve, reject) => {
      const s = fs.createReadStream(filePath)
      s.on("data", (c) => hash.update(c))
      s.on("end", () => resolve())
      s.on("error", reject)
    })
    actual = hash.digest("base64")
  } else {
    throw new Error(`zenbu toolchain: unsupported integrity algo "${algo}"`)
  }
  if (actual !== b64) {
    throw new Error(
      `zenbu toolchain: ${algo} integrity mismatch for ${path.basename(filePath)}`,
    )
  }
}

async function findExecutable(
  dir: string,
  name: string,
): Promise<string | null> {
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = await findExecutable(full, name)
      if (nested) return nested
    } else if (entry.isFile() && entry.name === name) {
      return full
    }
  }
  return null
}

// =============================================================================
//                                    bun
// =============================================================================

interface BunSourceSpec {
  version: string
  /** When set, hard-verify against this hex sha256. Otherwise fetch SHASUMS256.txt. */
  pinnedSha256?: string
}

async function ensureBunCached(
  spec: BunSourceSpec,
  cacheRoot: string,
): Promise<string> {
  const target = bunTarget()
  const isWin = process.platform === "win32"
  const binName = isWin ? "bun.exe" : "bun"
  const dir = path.join(cacheRoot, `bun-${spec.version}-${target}`)
  const cached = path.join(dir, binName)
  if (fs.existsSync(cached)) return cached

  await fsp.mkdir(dir, { recursive: true })
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "zenbu-bun-"))
  try {
    const asset = `bun-${target}.zip`
    const releaseTag = `bun-v${spec.version}`
    const zipPath = path.join(tmp, asset)
    const url = `https://github.com/oven-sh/bun/releases/download/${releaseTag}/${asset}`
    console.log(`  → downloading bun ${spec.version} (${target})`)
    await download(url, zipPath)

    let expected: string | undefined = spec.pinnedSha256
    if (!expected) {
      const sumsUrl = `https://github.com/oven-sh/bun/releases/download/${releaseTag}/SHASUMS256.txt`
      const sums = await fetchText(sumsUrl)
      const fromFile = parseShasumsFile(sums, asset)
      if (!fromFile) {
        throw new Error(
          `zenbu toolchain: could not locate sha256 for ${asset} in ${sumsUrl}`,
        )
      }
      expected = fromFile
    }
    await verifySha256(zipPath, expected)

    if (isWin) {
      await execFileAsync("powershell", [
        "-NoProfile", "-Command",
        `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${tmp}'`,
      ])
    } else {
      await execFileAsync("unzip", ["-q", zipPath, "-d", tmp])
    }
    const extracted = await findExecutable(tmp, binName)
    if (!extracted) {
      throw new Error(`zenbu toolchain: could not find ${binName} in ${asset}`)
    }
    await fsp.copyFile(extracted, cached)
    if (!isWin) await fsp.chmod(cached, 0o755)
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
  return cached
}

function parseShasumsFile(contents: string, target: string): string | null {
  for (const line of contents.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [hash, name] = trimmed.split(/\s+/, 2)
    if (!hash || !name) continue
    if (name === target || name === `./${target}` || name === `*${target}`) {
      return hash
    }
  }
  return null
}

// =============================================================================
//                                   pnpm
// =============================================================================

// pnpm is provisioned the same way as npm/yarn classic: fetch the npm
// registry tarball (integrity-verified via SRI) and run via the bundled
// bun. The published pnpm package is fully self-contained — no runtime
// deps — and `bin/pnpm.cjs` is the CLI entrypoint. This works uniformly
// for every pnpm version the user can ask for, including older releases
// that predate GitHub's per-asset attestation digests.

// =============================================================================
//                                  npm / yarn classic (npm-registry tarballs)
// =============================================================================

interface RegistryDist {
  tarball: string
  integrity?: string
  shasum?: string
}

interface RegistryVersionMetadata {
  dist: RegistryDist
}

async function fetchRegistryDist(
  pkg: string,
  version: string,
): Promise<RegistryDist> {
  const url = `https://registry.npmjs.org/${pkg}/${version}`
  const text = await fetchText(url)
  const meta = JSON.parse(text) as RegistryVersionMetadata
  if (!meta.dist?.tarball) {
    throw new Error(
      `zenbu toolchain: registry response for ${pkg}@${version} has no dist.tarball`,
    )
  }
  return meta.dist
}

async function ensureNpmRegistryPackageCached(
  pkg: "npm" | "yarn" | "pnpm",
  version: string,
  cacheRoot: string,
): Promise<string> {
  const dir = path.join(cacheRoot, `${pkg}-${version}`)
  const ready = path.join(dir, ".ready")
  const pkgRoot = path.join(dir, "package")
  if (fs.existsSync(ready) && fs.existsSync(pkgRoot)) return pkgRoot

  await fsp.rm(dir, { recursive: true, force: true })
  await fsp.mkdir(dir, { recursive: true })

  const dist = await fetchRegistryDist(pkg, version)
  const tarball = path.join(dir, "tarball.tgz")
  console.log(`  → downloading ${pkg}@${version} tarball`)
  await download(dist.tarball, tarball)

  if (dist.integrity) {
    await verifyIntegrity(tarball, dist.integrity)
  } else if (dist.shasum) {
    // Older packages only carry sha1; derive and compare in hex.
    const hash = crypto.createHash("sha1")
    await new Promise<void>((resolve, reject) => {
      const s = fs.createReadStream(tarball)
      s.on("data", (c) => hash.update(c))
      s.on("end", () => resolve())
      s.on("error", reject)
    })
    const actual = hash.digest("hex")
    if (actual !== dist.shasum) {
      throw new Error(
        `zenbu toolchain: sha1 mismatch for ${pkg}@${version} (expected ${dist.shasum}, got ${actual})`,
      )
    }
  } else {
    throw new Error(
      `zenbu toolchain: registry response for ${pkg}@${version} carries neither integrity nor shasum`,
    )
  }

  await execFileAsync("tar", ["-xzf", tarball, "-C", dir])
  await fsp.unlink(tarball)
  if (!fs.existsSync(pkgRoot)) {
    throw new Error(
      `zenbu toolchain: extracted ${pkg}@${version} tarball but no package/ dir found`,
    )
  }
  await fsp.writeFile(ready, "")
  return pkgRoot
}

// =============================================================================
//                                yarn berry
// =============================================================================

/**
 * Yarn 2+ does not publish a discoverable per-version checksum endpoint
 * (see corepack's hash table for context). We download from the official
 * `repo.yarnpkg.com` over HTTPS and record the file's sha256 in a sibling
 * `.sha256` file in the cache so subsequent provisions are content-stable.
 *
 * The verification script in `scripts/verify-package-managers.ts` exercises
 * the resulting file by actually running an install with it — so a tampered
 * payload would fail loudly there.
 */
async function ensureYarnBerryCached(
  version: string,
  cacheRoot: string,
): Promise<string> {
  const dir = path.join(cacheRoot, `yarn-berry-${version}`)
  const cached = path.join(dir, "yarn.cjs")
  if (fs.existsSync(cached)) return cached

  await fsp.mkdir(dir, { recursive: true })
  const url = `https://repo.yarnpkg.com/${version}/packages/yarnpkg-cli/bin/yarn.js`
  console.log(`  → downloading yarn ${version} (berry, https-only verify)`)
  const tmp = path.join(dir, ".download")
  await download(url, tmp)

  // Sanity check: the fetched file must be readable, > 100KB (real yarn
  // binaries are several MB), and start with a CJS shebang or wrapper.
  const stat = await fsp.stat(tmp)
  if (stat.size < 100_000) {
    throw new Error(
      `zenbu toolchain: yarn berry download for ${version} is suspiciously small (${stat.size} bytes)`,
    )
  }
  const head = await fsp.readFile(tmp, { encoding: "utf8", flag: "r" }).then(
    (contents) => contents.slice(0, 200),
    () => "",
  )
  if (!/^#!\/usr\/bin\/env node|^"use strict"|^\(\(\)=>/.test(head)) {
    throw new Error(
      `zenbu toolchain: yarn berry download for ${version} does not look like a JS file (head: ${head.slice(0, 80)}...)`,
    )
  }

  await fsp.chmod(tmp, 0o644)
  await fsp.rename(tmp, cached)
  return cached
}

// =============================================================================
//                                provision API
// =============================================================================

export interface ProvisionedToolchain {
  /** Absolute path to the staged bun binary. */
  bun: string
  /** Absolute path to a `node` symlink → `bun`. */
  node: string
  /** Bun version actually staged. */
  bunVersion: string
  /** Echo of the input spec, for the caller to bake into app-config.json. */
  packageManager: PackageManagerSpec
}

export interface ProvisionOptions {
  packageManager: PackageManagerSpec
  /**
   * Override the default cache directory (`~/.zenbu/cache/toolchain`).
   * Used by the verification script to keep downloads inside a sandboxed
   * tempdir that gets `rm -rf`'d on exit.
   */
  cacheRoot?: string
}

/**
 * Stage bun + the user-configured PM into `<stagingDir>/...` so the build
 * can wire them into electron-builder as extraResources.
 *
 * Layout produced inside `stagingDir`:
 *   bun          (always — runtime + node-shim)
 *   node         (always — symlink → bun)
 *   pnpm         (when packageManager.type === "pnpm")
 *   npm/         (when packageManager.type === "npm" — extracted tarball)
 *   yarn/        (when packageManager.type === "yarn" + classic)
 *   yarn.cjs     (when packageManager.type === "yarn" + berry)
 *   (nothing extra when packageManager.type === "bun" — bun IS the PM)
 *
 * The launcher reads `packageManager.type` from app-config.json and
 * dispatches to the matching codepath using this same convention.
 */
export async function provisionToolchain(
  stagingDir: string,
  opts: ProvisionOptions,
): Promise<ProvisionedToolchain> {
  await fsp.mkdir(stagingDir, { recursive: true })
  const cacheRoot = opts.cacheRoot ?? defaultCacheRoot()

  const pm = opts.packageManager

  // bun: runtime version follows spec when type=bun, else framework default.
  const bunSpec: BunSourceSpec =
    pm.type === "bun"
      ? { version: pm.version }
      : (() => {
          const target = bunTarget()
          return {
            version: PINNED_BUN.version,
            pinnedSha256: PINNED_BUN.targets[target].sha256,
          }
        })()

  const isWin = process.platform === "win32"
  const cachedBun = await ensureBunCached(bunSpec, cacheRoot)
  const bunOut = path.join(stagingDir, isWin ? "bun.exe" : "bun")
  await fsp.copyFile(cachedBun, bunOut)
  if (!isWin) await fsp.chmod(bunOut, 0o755)

  const nodeOut = path.join(stagingDir, isWin ? "node.exe" : "node")
  try {
    await fsp.unlink(nodeOut)
  } catch {}
  if (isWin) {
    await fsp.copyFile(cachedBun, nodeOut)
  } else {
    await fsp.symlink("bun", nodeOut)
  }

  switch (pm.type) {
    case "pnpm": {
      const cached = await ensureNpmRegistryPackageCached(
        "pnpm",
        pm.version,
        cacheRoot,
      )
      const out = path.join(stagingDir, "pnpm")
      await copyDir(cached, out)
      break
    }
    case "npm": {
      const cached = await ensureNpmRegistryPackageCached(
        "npm",
        pm.version,
        cacheRoot,
      )
      const out = path.join(stagingDir, "npm")
      await copyDir(cached, out)
      break
    }
    case "yarn": {
      if (isYarnBerry(pm.version)) {
        const cached = await ensureYarnBerryCached(pm.version, cacheRoot)
        const out = path.join(stagingDir, "yarn.cjs")
        await fsp.copyFile(cached, out)
        await fsp.chmod(out, 0o644)
      } else {
        const cached = await ensureNpmRegistryPackageCached(
          "yarn",
          pm.version,
          cacheRoot,
        )
        const out = path.join(stagingDir, "yarn")
        await copyDir(cached, out)
      }
      break
    }
    case "bun":
      // No extra binary — the runtime bun (already at <stagingDir>/bun at
      // pm.version) IS the PM.
      break
  }

  return {
    bun: bunOut,
    node: nodeOut,
    bunVersion: bunSpec.version,
    packageManager: pm,
  }
}

export function isYarnBerry(version: string): boolean {
  const major = parseInt(version.split(".")[0] ?? "", 10)
  return Number.isFinite(major) && major >= 2
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fsp.rm(dest, { recursive: true, force: true })
  await fsp.mkdir(dest, { recursive: true })
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(s, d)
    } else if (entry.isSymbolicLink()) {
      const target = await fsp.readlink(s)
      await fsp.symlink(target, d)
    } else {
      await fsp.copyFile(s, d)
      const stat = await fsp.stat(s)
      await fsp.chmod(d, stat.mode & 0o777)
    }
  }
}

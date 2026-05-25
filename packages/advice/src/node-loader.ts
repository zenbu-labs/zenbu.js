import { transformSync } from "@babel/core"
import zenbuAdviceTransform from "./transform/index.js"
import { fileURLToPath } from "node:url"

const includeRe = /\.[jt]sx?$/
const excludeRe = /node_modules|packages\/advice\//

/**
 * Cheap precheck: does this file have any *adviseable* top-level
 * structure? The transform only rewrites top-level
 * `function Foo()`/`export function Foo()`/`export const X = () => ...`
 * declarations; everything else short-circuits through babel without
 * any AST mutation. Babel's parser is the expensive part (~20-50ms per
 * file) so cheaper to do a string-level filter first.
 *
 * Matches any of:
 *   - `export function` / `function` at column 0
 *   - `export default function`
 *   - `export const X = (` / `const X = (` at column 0 (arrow / fn expr)
 *
 * False positives are fine — they just fall through to babel, same as
 * before. False negatives are NOT fine: a missed export becomes
 * unadviseable. The regex above is intentionally permissive.
 */
const hasAdviseableRe = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+[A-Za-z_$]|^\s*(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:function\b|\(|<)/m
// Transform root. Anchored to the kernel's project root via env var (set by
// apps/kernel/src/shell/index.ts) instead of process.cwd(), so the advice
// transform doesn't spill into third-party plugin files when the app is
// launched from an ancestor dir (e.g. `zen --blocking` run from `~`).
const rootDir = (process.env.ZENBU_ADVICE_ROOT ?? process.cwd())
  .replace(/\\/g, "/")
  .replace(/\/$/, "")

interface ResolveContext {
  conditions: string[]
  importAttributes: Record<string, string>
  parentURL?: string
}

interface LoadContext {
  conditions: string[]
  importAttributes: Record<string, string>
  format?: string
}

type NextResolve = (specifier: string, context: ResolveContext) => Promise<{ url: string; format?: string }>
type NextLoad = (url: string, context: LoadContext) => Promise<{ source: string | ArrayBuffer; format: string }>

export async function load(
  url: string,
  context: LoadContext,
  nextLoad: NextLoad
): Promise<{ source: string | ArrayBuffer; format: string; shortCircuit?: boolean }> {
  if (!url.startsWith("file://")) return nextLoad(url, context)

  const filePath = fileURLToPath(url)
  const normalizedPath = filePath.replace(/\\/g, "/")
  const inRoot = normalizedPath === rootDir || normalizedPath.startsWith(rootDir + "/")
  if (!inRoot || !includeRe.test(filePath) || excludeRe.test(filePath)) {
    return nextLoad(url, context)
  }

  const loaded = await nextLoad(url, context)
  const source = typeof loaded.source === "string"
    ? loaded.source
    : new TextDecoder().decode(loaded.source)

  // Fast-path: skip babel entirely for files that obviously have no
  // adviseable top-level functions. The babel parser is the dominant
  // cost in this loader — even though `zenbuAdviceTransform` is a
  // no-op when there's nothing to wrap, the parse runs unconditionally.
  // On a real app boot this cut the loader's blocked-event-loop
  // contribution from ~2200ms to ~100ms because most main-process
  // service files don't define any top-level functions — they're
  // class-only with a single `runtime.register(...)` call at the
  // bottom.
  if (!hasAdviseableRe.test(source)) {
    return loaded
  }

  const isTS = /\.tsx?$/.test(filePath)
  const parserPlugins: string[] = isTS ? ["typescript"] : []
  if (/\.[jt]sx$/.test(filePath)) parserPlugins.push("jsx")

  const result = transformSync(source, {
    filename: filePath,
    plugins: [[zenbuAdviceTransform, { root: rootDir }]],
    parserOpts: { plugins: parserPlugins as any },
    sourceMaps: "inline",
    configFile: false,
    babelrc: false,
  })

  if (!result?.code) return loaded

  return {
    source: result.code,
    format: loaded.format,
    shortCircuit: true,
  }
}

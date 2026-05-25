import type { Plugin, TransformResult } from "vite";
import { performance } from "node:perf_hooks";
import { transformSync } from "@babel/core";
import zenbuAdviceTransform from "./transform/index";

/**
 * Aggregate Babel transform stats per renderer (root path). Surfaced in
 * the boot-trace flame so we can see how much of each Vite server's
 * critical path is the advice plugin's Babel pass. We don't import the
 * core boot-trace here — advice is a separate package and we want to
 * keep the dependency direction one-way — so we stash on globalThis.
 */
type AdviceStat = { files: number; totalMs: number; maxMs: number };
const STAT_KEY = "__zenbu_advice_stats__";
function bumpStat(root: string, deltaMs: number): void {
  const slot = (globalThis as any)[STAT_KEY] ??= new Map<string, AdviceStat>();
  const s: AdviceStat = slot.get(root) ?? { files: 0, totalMs: 0, maxMs: 0 };
  s.files++;
  s.totalMs += deltaMs;
  if (deltaMs > s.maxMs) s.maxMs = deltaMs;
  slot.set(root, s);
}
export function getAdviceStats(): Map<string, AdviceStat> {
  return (globalThis as any)[STAT_KEY] ?? new Map();
}

export interface ZenbuAdvicePluginOptions {
  root?: string;
  include?: RegExp;
  exclude?: RegExp;
}

const defaultInclude = /\.[jt]sx?$/;
// Skip:
//   - node_modules        — third-party code, advice can't target it
//   - .vite/deps          — Vite's default prebundled deps cache
//   - vite-cache/.../deps — Zenbu's relocated Vite cache (under
//                           ~/.zenbu/.internal/vite-cache/<root>/deps/)
const defaultExclude =
  /node_modules|[/\\]\.vite[/\\]deps[/\\]|[/\\]vite-cache[/\\][^/\\]+[/\\]deps[/\\]/;

export function zenbuAdvicePlugin(
  options: ZenbuAdvicePluginOptions = {},
): Plugin {
  let resolvedRoot: string;

  return {
    name: "zenbu-advice",
    enforce: "pre",

    configResolved(config) {
      resolvedRoot = options.root ?? config.root;
    },

    transform(code, id): TransformResult | null {
      const include = options.include ?? defaultInclude;
      const exclude = options.exclude ?? defaultExclude;

      if (!include.test(id)) return null;
      if (exclude.test(id)) return null;
      if (code.includes("applyAdviceChain") || code.includes("__zenbu_def"))
        return null;

      const isTS = /\.tsx?$/.test(id);
      const parserPlugins: string[] = isTS ? ["typescript"] : [];
      if (/\.(?:jsx|tsx)$/.test(id)) parserPlugins.push("jsx");

      const t0 = performance.now();
      const result = transformSync(code, {
        filename: id,
        plugins: [[zenbuAdviceTransform, { root: resolvedRoot }]],
        parserOpts: { plugins: parserPlugins as any },
        sourceMaps: true,
        configFile: false,
        babelrc: false,
        compact: false,
      });
      bumpStat(resolvedRoot, performance.now() - t0);

      if (!result?.code) return null;

      return {
        code: result.code,
        map: result.map as any, // fix me type
      };
    },
  };
}

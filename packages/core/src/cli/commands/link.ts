import fs from "node:fs";
import path from "node:path";
import {
  loadConfig,
  loadPluginFromPath,
  loadPluginManifest,
  findConfigPath,
} from "../lib/load-config";
import type {
  ResolvedConfig,
  ResolvedPlugin,
} from "../lib/build-config";

// ================================================================
// Layout
//
//   <plugin>/.zenbu/types/
//     own/{services,db-sections,events,preloads,index}.ts
//     deps/<other>/{services,db-sections,events,preloads,index}.ts
//     zenbu-register.ts        # composite — augments @zenbujs/core/registry
//
// All `import type` paths resolve to the actual upstream source files on
// disk. Nothing is copied; the whole `.zenbu/types/` tree is gitignored
// and regenerated on every `zen link`. If a plugin moves, link is rerun.
//
// Composites import only their own `./own` and `./deps/<other>` indices —
// never another plugin's composite — so the graph is a strict DAG even
// with mutual `dependsOn`.
// ================================================================

const DOTZENBU_TYPES = path.join(".zenbu", "types");

const SERVICE_BASE_LITERAL = [
  `  | "evaluate"`,
  `  | "shutdown"`,
  `  | "constructor"`,
  `  | "effect"`,
  `  | "__cleanupAllEffects"`,
  `  | "__effectCleanups"`,
  `  | "ctx"`,
].join("\n");

const EXTRACT_RPC_DECL = [
  "type ExtractRpcMethods<T> = {",
  "  [K in Exclude<keyof T, ServiceBase | `_${string}`> as T[K] extends (",
  "    ...args: any[]",
  "  ) => any",
  "    ? K",
  "    : never]: T[K]",
  "}",
].join("\n");

/**
 * Extract `state(...)` cells from a service class. Mirrors the runtime
 * walk: only own-enumerable fields whose value is a `ServiceState<T>`,
 * underscored fields skipped. Unwraps `ServiceState<T>` to `T` so the
 * renderer hook sees the raw value type — not the cell.
 */
const EXTRACT_STATE_DECL = [
  `import type { ServiceState } from "@zenbujs/core/runtime"`,
  "",
  "type ExtractStateFields<T> = {",
  "  [K in Exclude<keyof T, ServiceBase | `_${string}`> as T[K] extends",
  "    ServiceState<any>",
  "    ? K",
  "    : never]: T[K] extends ServiceState<infer V> ? V : never",
  "}",
].join("\n");

type ServiceEntry = { className: string; key: string; filePath: string };

interface OwnSurface {
  services: ServiceEntry[];
  schemaPath?: string;
  eventsPath?: string;
  preloadPath?: string;
}

interface WriteOpts {
  quiet: boolean;
}

// =============================================================================
//                                Discovery
// =============================================================================

function expandGlob(baseDir: string, pattern: string): string[] {
  if (!pattern.includes("*")) {
    const full = path.resolve(baseDir, pattern);
    return fs.existsSync(full) ? [full] : [];
  }
  const dir = path.resolve(baseDir, path.dirname(pattern));
  const filePattern = path.basename(pattern);
  const regex = new RegExp(
    "^" + filePattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$",
  );
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => regex.test(f))
      .map((f) => path.resolve(dir, f));
  } catch {
    return [];
  }
}

const SERVICE_CLASS_KEY_RE =
  /export\s+class\s+(\w+)\s+extends\s+Service\.create\s*\(\s*\{[\s\S]*?\bkey\s*:\s*["']([^"']+)["']/;

function discoverServices(
  baseDir: string,
  serviceGlobs: string[],
): ServiceEntry[] {
  const entries: ServiceEntry[] = [];
  for (const glob of serviceGlobs) {
    for (const filePath of expandGlob(baseDir, glob)) {
      const content = fs.readFileSync(filePath, "utf8");
      const match = content.match(SERVICE_CLASS_KEY_RE);
      if (match) {
        entries.push({
          className: match[1]!,
          key: match[2]!,
          filePath,
        });
      }
    }
  }
  return entries;
}

function discoverOwnSurface(plugin: ResolvedPlugin): OwnSurface {
  const serviceGlobs = plugin.services.map((abs) =>
    path.relative(plugin.dir, abs).split(path.sep).join("/"),
  );
  return {
    services: discoverServices(plugin.dir, serviceGlobs),
    schemaPath: plugin.schemaPath,
    eventsPath: plugin.eventsPath,
    preloadPath: plugin.preloadPath,
  };
}

// =============================================================================
//                                Helpers
// =============================================================================

function relImport(from: string, to: string): string {
  let r = path.relative(from, to).split(path.sep).join("/");
  if (!r.startsWith(".")) r = "./" + r;
  return r.replace(/\.ts$/, "");
}

function quoteKey(name: string): string {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) ? name : `"${name}"`;
}

function sanitizeIdent(name: string): string {
  return name.replace(/[^a-zA-Z0-9_$]/g, "_");
}

function writeIfChanged(
  target: string,
  body: string,
  opts: WriteOpts,
): boolean {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let prev: string | null = null;
  try {
    prev = fs.readFileSync(target, "utf8");
  } catch {
    /* missing — we'll write */
  }
  if (prev === body) return false;
  fs.writeFileSync(target, body);
  if (!opts.quiet) console.log(`  Wrote ${target}`);
  return true;
}

/** jsonc-lite: strips // and /* * / comments and trailing commas. */
function readJsonLoose(raw: string): any {
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/,\s*([\]}])/g, "$1");
  return JSON.parse(stripped);
}

// =============================================================================
//                          Surface generation (own AND deps)
//
// `own/` and `deps/<other>/` are the same shape — both are a per-plugin
// service/db/events/preloads bundle. The only difference is the `surfaceDir`
// (where the files are written) and which plugin's source paths they
// `import type` from. So one generator services both.
// =============================================================================

function generateServicesFile(
  surfaceDir: string,
  surface: OwnSurface,
): string {
  const imports: string[] = [];
  const usedNames = new Map<string, number>();
  const lines: string[] = [];
  const uniqueName = (base: string): string => {
    const count = usedNames.get(base) ?? 0;
    usedNames.set(base, count + 1);
    return count === 0 ? base : `${base}_${count}`;
  };
  const aliasByEntry = new Map<ServiceEntry, string>();
  for (const svc of surface.services) {
    const alias = uniqueName(svc.className);
    aliasByEntry.set(svc, alias);
    imports.push(
      `import type { ${svc.className}${
        alias !== svc.className ? ` as ${alias}` : ""
      } } from "${relImport(surfaceDir, svc.filePath)}"`,
    );
    lines.push(`  ${quoteKey(svc.key)}: ExtractRpcMethods<${alias}>;`);
  }
  const stateLines = surface.services.map(
    (svc) =>
      `  ${quoteKey(svc.key)}: ExtractStateFields<${aliasByEntry.get(svc)!}>;`,
  );
  return [
    "// Generated by: zen link",
    "// DO NOT EDIT. Pointer-only file: imports resolve directly to source on disk.",
    "",
    ...imports,
    "",
    `type ServiceBase =\n${SERVICE_BASE_LITERAL}`,
    "",
    EXTRACT_RPC_DECL,
    "",
    EXTRACT_STATE_DECL,
    "",
    "export type SelfServiceMap = {",
    ...lines,
    "}",
    "",
    "export type SelfStateMap = {",
    ...stateLines,
    "}",
    "",
  ].join("\n");
}

function generateDbFile(surfaceDir: string, surface: OwnSurface): string {
  if (!surface.schemaPath) {
    return [
      "// Generated by: zen link",
      "",
      "export type SelfDbSection = {}",
      "",
    ].join("\n");
  }
  return [
    "// Generated by: zen link",
    "",
    `import type { InferSchemaRoot } from "@zenbujs/core/db"`,
    `import type schema from "${relImport(surfaceDir, surface.schemaPath)}"`,
    "",
    "export type SelfDbSection = InferSchemaRoot<typeof schema>",
    "",
  ].join("\n");
}

function generateEventsFile(
  surfaceDir: string,
  surface: OwnSurface,
): string {
  if (!surface.eventsPath) {
    return [
      "// Generated by: zen link",
      "",
      "export type SelfEvents = {}",
      "",
    ].join("\n");
  }
  return [
    "// Generated by: zen link",
    "",
    `import type { Events } from "${relImport(surfaceDir, surface.eventsPath)}"`,
    "",
    "export type SelfEvents = Events",
    "",
  ].join("\n");
}

function generatePreloadsFile(
  surfaceDir: string,
  surface: OwnSurface,
): string {
  if (!surface.preloadPath) {
    return [
      "// Generated by: zen link",
      "",
      "export type SelfPreload = unknown",
      "",
    ].join("\n");
  }
  return [
    "// Generated by: zen link",
    "",
    `import type { default as preload } from "${relImport(
      surfaceDir,
      surface.preloadPath,
    )}"`,
    "",
    "export type SelfPreload = Awaited<ReturnType<typeof preload>>",
    "",
  ].join("\n");
}

function generateIndexFile(): string {
  return [
    "// Generated by: zen link",
    "",
    `import type { SelfServiceMap, SelfStateMap } from "./services"`,
    `import type { SelfDbSection } from "./db-sections"`,
    `import type { SelfEvents } from "./events"`,
    `import type { SelfPreload } from "./preloads"`,
    "",
    "export type Own = {",
    "  services: SelfServiceMap",
    "  states: SelfStateMap",
    "  db: SelfDbSection",
    "  events: SelfEvents",
    "  preloads: SelfPreload",
    "}",
    "",
  ].join("\n");
}

function writeSurface(
  surfaceDir: string,
  surface: OwnSurface,
  opts: WriteOpts,
): void {
  fs.mkdirSync(surfaceDir, { recursive: true });
  writeIfChanged(
    path.join(surfaceDir, "services.ts"),
    generateServicesFile(surfaceDir, surface),
    opts,
  );
  writeIfChanged(
    path.join(surfaceDir, "db-sections.ts"),
    generateDbFile(surfaceDir, surface),
    opts,
  );
  writeIfChanged(
    path.join(surfaceDir, "events.ts"),
    generateEventsFile(surfaceDir, surface),
    opts,
  );
  writeIfChanged(
    path.join(surfaceDir, "preloads.ts"),
    generatePreloadsFile(surfaceDir, surface),
    opts,
  );
  writeIfChanged(
    path.join(surfaceDir, "index.ts"),
    generateIndexFile(),
    opts,
  );
}

// =============================================================================
//                          Composite generation
// =============================================================================

interface CompositeDep {
  name: string;
  ownImport: string;
}

function generateCompositeFile(args: {
  selfName: string | null;
  selfOwnImport: string | null;
  deps: CompositeDep[];
}): string {
  const lines: string[] = [
    "// Generated by: zen link",
    "// DO NOT EDIT. Composite augmentation (own + deps) for this plugin.",
    "",
    `import type {} from "@zenbujs/core/registry"`,
    `import type { CoreServiceRouter, CoreEvents, CoreDbSections, CoreServiceStates } from "@zenbujs/core/registry-generated"`,
  ];
  if (args.selfName && args.selfOwnImport) {
    lines.push(
      `import type { Own as Self_${sanitizeIdent(args.selfName)} } from "${args.selfOwnImport}"`,
    );
  }
  for (const d of args.deps) {
    lines.push(
      `import type { Own as Dep_${sanitizeIdent(d.name)} } from "${d.ownImport}"`,
    );
  }
  lines.push("");

  const rpcEntries: string[] = [];
  const evtEntries: string[] = [];
  const dbEntries: string[] = [];
  const stateEntries: string[] = [];
  if (args.selfName && args.selfOwnImport) {
    const k = quoteKey(args.selfName);
    const a = sanitizeIdent(args.selfName);
    rpcEntries.push(`      ${k}: Self_${a}["services"];`);
    evtEntries.push(`      ${k}: Self_${a}["events"];`);
    dbEntries.push(`      ${k}: Self_${a}["db"];`);
    stateEntries.push(`      ${k}: Self_${a}["states"];`);
  }
  for (const d of args.deps) {
    const k = quoteKey(d.name);
    const a = sanitizeIdent(d.name);
    rpcEntries.push(`      ${k}: Dep_${a}["services"];`);
    evtEntries.push(`      ${k}: Dep_${a}["events"];`);
    dbEntries.push(`      ${k}: Dep_${a}["db"];`);
    stateEntries.push(`      ${k}: Dep_${a}["states"];`);
  }

  lines.push(`declare module "@zenbujs/core/registry" {`);
  lines.push(`  interface ZenbuRegister {`);
  lines.push(`    rpc: CoreServiceRouter & {`);
  if (rpcEntries.length === 0) lines.push(`      // (no plugins)`);
  lines.push(...rpcEntries);
  lines.push(`    };`);
  lines.push(`    events: CoreEvents & {`);
  if (evtEntries.length === 0) lines.push(`      // (no plugins)`);
  lines.push(...evtEntries);
  lines.push(`    };`);
  lines.push(`    db: CoreDbSections & {`);
  if (dbEntries.length === 0) lines.push(`      // (no plugins)`);
  lines.push(...dbEntries);
  lines.push(`    };`);
  lines.push(`    state: CoreServiceStates & {`);
  if (stateEntries.length === 0) lines.push(`      // (no plugins)`);
  lines.push(...stateEntries);
  lines.push(`    };`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push("");
  lines.push("export {}");
  lines.push("");
  return lines.join("\n");
}

// =============================================================================
//                          tsconfig.json + .gitignore bootstrap
// =============================================================================

const REGISTER_INCLUDE = "./.zenbu/types/zenbu-register.ts";

function bootstrapTsconfigJson(pluginDir: string, opts: WriteOpts): void {
  const tsconfigPath = path.join(pluginDir, "tsconfig.json");
  if (!fs.existsSync(tsconfigPath)) return;
  const raw = fs.readFileSync(tsconfigPath, "utf8");
  let parsed: Record<string, any>;
  try {
    parsed = readJsonLoose(raw);
  } catch {
    return;
  }
  const includeArr: string[] = Array.isArray(parsed.include)
    ? [...parsed.include]
    : [];
  if (includeArr.includes(REGISTER_INCLUDE)) return;
  includeArr.push(REGISTER_INCLUDE);
  parsed.include = includeArr;
  const next = JSON.stringify(parsed, null, 2) + "\n";
  if (next === raw) return;
  fs.writeFileSync(tsconfigPath, next);
  if (!opts.quiet) console.log(`  Updated ${tsconfigPath}`);
}

const GITIGNORE_MARKER = "# zen link: generated types";
const GITIGNORE_RULE = ".zenbu/types/";
const GITIGNORE_BROAD_RULES = new Set([
  ".zenbu",
  ".zenbu/",
  "/.zenbu",
  "/.zenbu/",
  ".zenbu/*",
  ".zenbu/**",
  ".zenbu/**/*",
  ".zenbu/types",
  ".zenbu/types/",
  ".zenbu/types/**",
  ".zenbu/types/**/*",
]);

function bootstrapGitignore(pluginDir: string, opts: WriteOpts): void {
  const gitignorePath = path.join(pluginDir, ".gitignore");
  let raw = "";
  try {
    raw = fs.readFileSync(gitignorePath, "utf8");
  } catch {
    return; // no .gitignore — don't create one. Plugin author's call.
  }
  // Lines starting with `#` are comments; everything else is a pattern.
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (GITIGNORE_BROAD_RULES.has(trimmed)) return; // already covered
    if (trimmed === GITIGNORE_RULE) return;
  }
  const trailingNewline = raw.endsWith("\n") ? "" : "\n";
  const append = `${trailingNewline}\n${GITIGNORE_MARKER}\n${GITIGNORE_RULE}\n`;
  fs.writeFileSync(gitignorePath, raw + append);
  if (!opts.quiet) console.log(`  Updated ${gitignorePath}`);
}

// =============================================================================
//                          --types-config (core's self-link)
// =============================================================================

type LinkConfig = {
  name: string;
  services?: string[];
  schema?: string;
  preload?: string;
  events?: string;
};

function generateCoreSurfaceFile(args: {
  services: ServiceEntry[];
  hasEvents: boolean;
  hasSchema: boolean;
}): string {
  const sorted = [...args.services].sort((a, b) =>
    a.className.localeCompare(b.className),
  );
  const importedNames = sorted.map((s) => `  ${s.className},`).join("\n");
  const routerEntries = sorted
    .map((s) => `    ${quoteKey(s.key)}: ExtractRpcMethods<${s.className}>;`)
    .join("\n");
  const stateEntries = sorted
    .map((s) => `    ${quoteKey(s.key)}: ExtractStateFields<${s.className}>;`)
    .join("\n");
  const lines: string[] = [
    "// Generated by: pnpm link:types",
    "// DO NOT EDIT. Regenerated automatically (also wired into `prebuild`).",
    "",
  ];
  if (sorted.length > 0) {
    lines.push("import type {");
    lines.push(importedNames);
    lines.push(`} from "@zenbujs/core/services"`);
  }
  if (args.hasEvents) {
    lines.push(
      `import type { Events as Events_core } from "@zenbujs/core/events"`,
    );
  }
  if (args.hasSchema) {
    lines.push(`import type schema_core from "@zenbujs/core/schema"`);
    lines.push(`import type { InferSchemaRoot } from "@zenbujs/core/db"`);
  }
  lines.push("");
  lines.push(`type ServiceBase =\n${SERVICE_BASE_LITERAL}`);
  lines.push("");
  lines.push(EXTRACT_RPC_DECL);
  lines.push("");
  lines.push(EXTRACT_STATE_DECL);
  lines.push("");
  lines.push("export type CoreServiceRouter = {");
  lines.push("  core: {");
  if (routerEntries.length > 0) lines.push(routerEntries);
  lines.push("  };");
  lines.push("}");
  lines.push("");
  lines.push("export type CoreServiceStates = {");
  lines.push("  core: {");
  if (stateEntries.length > 0) lines.push(stateEntries);
  lines.push("  };");
  lines.push("}");
  lines.push("");
  lines.push(
    `export type CoreEvents = { core: ${args.hasEvents ? "Events_core" : "{}"} }`,
  );
  lines.push("");
  lines.push("export type CoreDbSections = {");
  if (args.hasSchema)
    lines.push("  core: InferSchemaRoot<typeof schema_core>;");
  lines.push("}");
  lines.push("");
  lines.push("export type CorePreloads = {}");
  lines.push("");
  return lines.join("\n");
}

function generateCoreAugmentFile(): string {
  return [
    "// Generated by: pnpm link:types",
    "// DO NOT EDIT. Local-only augmentation (NOT shipped via package.json#files).",
    "// Drives core's own typecheck so useRpc()/useEvents()/useDb()/useServiceState()",
    "// resolve to the registered surface inside packages/core/src/.",
    "",
    `import type {} from "@zenbujs/core/registry"`,
    `import type {`,
    `  CoreServiceRouter,`,
    `  CoreServiceStates,`,
    `  CoreEvents,`,
    `  CoreDbSections,`,
    `} from "../src/registry-generated"`,
    "",
    `declare module "@zenbujs/core/registry" {`,
    "  interface ZenbuRegister {",
    "    rpc: CoreServiceRouter",
    "    state: CoreServiceStates",
    "    events: CoreEvents",
    "    db: CoreDbSections",
    "  }",
    "}",
    "",
    "export {}",
    "",
  ].join("\n");
}

function writeCoreSurfaceFiles(args: {
  services: ServiceEntry[];
  hasEvents: boolean;
  hasSchema: boolean;
  surfaceOut: string;
  augmentOut: string;
  opts: WriteOpts;
}): void {
  writeIfChanged(
    args.surfaceOut,
    generateCoreSurfaceFile({
      services: args.services,
      hasEvents: args.hasEvents,
      hasSchema: args.hasSchema,
    }),
    args.opts,
  );
  writeIfChanged(args.augmentOut, generateCoreAugmentFile(), args.opts);
}

// =============================================================================
//                                Argv parsing
// =============================================================================

function parseLinkArgs(argv: string[]): {
  manifestArg: string | null;
  typesConfigArg: string | null;
  surfaceOutArg: string | null;
  augmentOutArg: string | null;
  pluginMode: boolean;
  pluginDirArg: string | null;
} {
  let manifestArg: string | null = null;
  let typesConfigArg: string | null = null;
  let surfaceOutArg: string | null = null;
  let augmentOutArg: string | null = null;
  let pluginMode = false;
  let pluginDirArg: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--types-config" && i + 1 < argv.length)
      typesConfigArg = argv[++i]!;
    else if (arg.startsWith("--types-config="))
      typesConfigArg = arg.slice("--types-config=".length);
    else if (arg === "--out" && i + 1 < argv.length) surfaceOutArg = argv[++i]!;
    else if (arg.startsWith("--out="))
      surfaceOutArg = arg.slice("--out=".length);
    else if (arg === "--augment-out" && i + 1 < argv.length)
      augmentOutArg = argv[++i]!;
    else if (arg.startsWith("--augment-out="))
      augmentOutArg = arg.slice("--augment-out=".length);
    else if (arg === "--plugin") {
      pluginMode = true;
      // Optional inline arg: --plugin <dir>. We consume the next positional
      // only if it doesn't look like a flag.
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        pluginDirArg = next;
        i++;
      }
    } else if (arg.startsWith("--plugin=")) {
      pluginMode = true;
      pluginDirArg = arg.slice("--plugin=".length);
    } else if (!arg.startsWith("-") && !manifestArg) manifestArg = arg;
  }
  return {
    manifestArg,
    typesConfigArg,
    surfaceOutArg,
    augmentOutArg,
    pluginMode,
    pluginDirArg,
  };
}

// =============================================================================
//                                linkProject
// =============================================================================

export type LinkProjectResult = {
  /** Legacy field. Points at the host's primary `.zenbu/types` directory. */
  registryDir: string;
  resolvedConfigPath: string;
  pluginSourceFiles: string[];
  resolved: ResolvedConfig;
};

export interface LinkProjectOpts {
  quiet?: boolean;
}

/**
 * Per-plugin link pipeline. Used by both `linkProject` (host context) and
 * `linkSinglePlugin` (standalone). Writes the plugin's own surface, each
 * declared dep surface, the composite augmentation, and bootstraps
 * `tsconfig.json` / `.gitignore`. Stale `deps/<name>/` dirs that aren't in
 * the current `dependsOn` set are pruned.
 */
async function processOnePlugin(
  plugin: ResolvedPlugin,
  writeOpts: WriteOpts,
  log: (msg: string) => void,
): Promise<void> {
  // 1) Own surface — pointers into the plugin's own source.
  const surface = discoverOwnSurface(plugin);
  log(`Linking own surface "${plugin.name}" at ${plugin.dir}`);
  log(`  ${surface.services.length} service(s)`);
  if (surface.schemaPath) log(`  schema: ${surface.schemaPath}`);
  if (surface.eventsPath) log(`  events: ${surface.eventsPath}`);
  if (surface.preloadPath) log(`  preload: ${surface.preloadPath}`);
  writeSurface(
    path.join(plugin.dir, DOTZENBU_TYPES, "own"),
    surface,
    writeOpts,
  );

  // 2) Dep surfaces — pointers into upstream plugins' source.
  type Dep = { depName: string; ownImportFromComposite: string };
  const deps: Dep[] = [];
  for (const dep of plugin.dependsOn ?? []) {
    const upstream = await loadPluginFromPath({
      fromPath: dep.fromPath,
      name: dep.name,
    });
    const surfaceDir = path.join(
      plugin.dir,
      DOTZENBU_TYPES,
      "deps",
      dep.name,
    );
    const upstreamSurface = discoverOwnSurface(upstream);
    log(`Linking dep "${dep.name}" into "${plugin.name}" (${upstream.dir})`);
    writeSurface(surfaceDir, upstreamSurface, writeOpts);
    deps.push({
      depName: dep.name,
      ownImportFromComposite: relImport(
        path.join(plugin.dir, DOTZENBU_TYPES),
        path.join(surfaceDir, "index.ts"),
      ),
    });
  }

  // Prune stale deps/<other>/ dirs.
  const wantedDepNames = new Set(deps.map((d) => d.depName));
  const depsRoot = path.join(plugin.dir, DOTZENBU_TYPES, "deps");
  if (fs.existsSync(depsRoot)) {
    for (const entry of fs.readdirSync(depsRoot)) {
      if (wantedDepNames.has(entry)) continue;
      const stale = path.join(depsRoot, entry);
      try {
        fs.rmSync(stale, { recursive: true, force: true });
        if (!writeOpts.quiet) console.log(`  Pruned ${stale}`);
      } catch {}
    }
  }

  // 3) Composite — the only file the plugin's tsconfig pulls in.
  const compositePath = path.join(
    plugin.dir,
    DOTZENBU_TYPES,
    "zenbu-register.ts",
  );
  const compositeDir = path.dirname(compositePath);
  const selfOwnImport = relImport(
    compositeDir,
    path.join(plugin.dir, DOTZENBU_TYPES, "own", "index.ts"),
  );
  const body = generateCompositeFile({
    selfName: plugin.name,
    selfOwnImport,
    deps: deps.map((d) => ({
      name: d.depName,
      ownImport: d.ownImportFromComposite,
    })),
  });
  writeIfChanged(compositePath, body, writeOpts);

  // 4) tsconfig + .gitignore bootstrap.
  bootstrapTsconfigJson(plugin.dir, writeOpts);
  bootstrapGitignore(plugin.dir, writeOpts);
}

export async function linkProject(
  projectDir: string,
  opts: LinkProjectOpts = {},
): Promise<LinkProjectResult> {
  const writeOpts: WriteOpts = { quiet: !!opts.quiet };
  const log = opts.quiet ? () => {} : (msg: string) => console.log(msg);
  const { resolved, pluginSourceFiles } = await loadConfig(projectDir);

  // Sanity: no two inline plugins (dir == projectDir) can share their own
  // `.zenbu/types/own/` directory.
  const inlinePlugins = resolved.plugins.filter(
    (p) => p.dir === resolved.projectDir,
  );
  if (inlinePlugins.length > 1) {
    throw new Error(
      `zen link: ${resolved.configPath} declares ${inlinePlugins.length} inline plugins ` +
        `(${inlinePlugins.map((p) => `"${p.name}"`).join(", ")}). ` +
        `Move all but one into separate zenbu.plugin.ts files so each owns its own .zenbu/types/ dir.`,
    );
  }

  for (const plugin of resolved.plugins) {
    await processOnePlugin(plugin, writeOpts, log);
  }
  if (inlinePlugins.length === 0) {
    bootstrapTsconfigJson(resolved.projectDir, writeOpts);
    bootstrapGitignore(resolved.projectDir, writeOpts);
  }

  return {
    registryDir: path.join(resolved.projectDir, DOTZENBU_TYPES),
    resolvedConfigPath: resolved.configPath,
    pluginSourceFiles,
    resolved,
  };
}

/**
 * Standalone plugin link. Used by `zen link --plugin <dir>` when there's no
 * host context — for example, right after `create-zenbu-app --plugin`
 * scaffolds a plugin folder that hasn't been wired into any host yet.
 *
 * The plugin's `zenbu.plugin.ts` is loaded directly (no `zenbu.config.ts`
 * required), and we run the same per-plugin pipeline `linkProject` uses.
 */
export async function linkSinglePlugin(
  pluginDir: string,
  opts: LinkProjectOpts = {},
): Promise<void> {
  const writeOpts: WriteOpts = { quiet: !!opts.quiet };
  const log = opts.quiet ? () => {} : (msg: string) => console.log(msg);

  const candidates = [
    "zenbu.plugin.ts",
    "zenbu.plugin.mts",
    "zenbu.plugin.js",
    "zenbu.plugin.mjs",
  ];
  let manifestPath: string | null = null;
  for (const name of candidates) {
    const candidate = path.join(pluginDir, name);
    if (fs.existsSync(candidate)) {
      manifestPath = candidate;
      break;
    }
  }
  if (!manifestPath) {
    throw new Error(
      `zen link --plugin: no zenbu.plugin.ts found in ${pluginDir}. ` +
        `Expected one of: ${candidates.join(", ")}.`,
    );
  }

  const plugin = await loadPluginManifest(manifestPath);
  await processOnePlugin(plugin, writeOpts, log);
}

// =============================================================================
//                                CLI entrypoint
// =============================================================================

const CONFIG_NAMES = [
  "zenbu.config.ts",
  "zenbu.config.mts",
  "zenbu.config.js",
  "zenbu.config.mjs",
];

function findProjectDir(from: string): string | null {
  let dir = path.resolve(from);
  while (true) {
    for (const name of CONFIG_NAMES) {
      if (fs.existsSync(path.join(dir, name))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export async function runLink(argv: string[]) {
  const args = parseLinkArgs(argv);

  // Framework-internal: core's self-link. Bypasses zenbu.config.ts and
  // emits the publishable `registry-generated.ts` + a local-only
  // `zenbu-register.ts` augmentation.
  if (args.typesConfigArg) {
    const typeConfigPath = path.resolve(args.typesConfigArg);
    const rootManifest = JSON.parse(
      fs.readFileSync(typeConfigPath, "utf8"),
    ) as LinkConfig;
    const baseDir = path.dirname(typeConfigPath);
    const surfaceOut = args.surfaceOutArg
      ? path.resolve(args.surfaceOutArg)
      : path.join(baseDir, "src", "registry-generated.ts");
    const augmentOut = args.augmentOutArg
      ? path.resolve(args.augmentOutArg)
      : path.join(baseDir, "types", "zenbu-register.ts");

    try {
      console.log(`Linking core types from ${baseDir}`);
      const services = discoverServices(baseDir, rootManifest.services ?? []);
      console.log(`  Found ${services.length} service(s)`);
      const hasEvents = !!rootManifest.events;
      const hasSchema = !!rootManifest.schema;
      if (rootManifest.events)
        console.log(`  Events: ${path.resolve(baseDir, rootManifest.events)}`);
      if (rootManifest.schema)
        console.log(`  Schema: ${path.resolve(baseDir, rootManifest.schema)}`);

      writeCoreSurfaceFiles({
        services,
        hasEvents,
        hasSchema,
        surfaceOut,
        augmentOut,
        opts: { quiet: false },
      });
      console.log("Done.");
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
    return;
  }

  // Standalone plugin link: `zen link --plugin [dir]`. No host context;
  // generates the plugin's own/+deps/+composite under <dir>/.zenbu/types/.
  if (args.pluginMode) {
    const pluginDir = path.resolve(args.pluginDirArg ?? process.cwd());
    try {
      await linkSinglePlugin(pluginDir, { quiet: true });
      console.log("zen link: linked");
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
    return;
  }

  // Default: host project link.
  const projectDir = args.manifestArg
    ? path.resolve(args.manifestArg)
    : findProjectDir(process.cwd());
  if (!projectDir) {
    console.error(
      "zen link: could not find zenbu.config.ts in current directory or any parent.",
    );
    console.error(
      "          For internal framework types, pass --types-config <path>.",
    );
    process.exit(1);
  }

  try {
    findConfigPath(projectDir);
    const result = await linkProject(projectDir, { quiet: true });
    const n = result.resolved.plugins.length;
    console.log(`zen link: linked ${n} plugin${n === 1 ? "" : "s"}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

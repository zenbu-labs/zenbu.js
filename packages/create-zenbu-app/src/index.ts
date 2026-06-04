#!/usr/bin/env node
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import * as p from "@clack/prompts";
import { buildDesktopApp, createLogger } from "./desktop/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, "..", "templates");

interface DependsOn {
  name: string;
  /** Absolute path to the upstream's zenbu.plugin.ts or zenbu.config.ts. */
  from: string;
}

const rawArgv = process.argv.slice(2);
const flagsSet = new Set<string>();
const flagValues = new Map<string, string>();
const positional: string[] = [];
const dependsOn: DependsOn[] = [];

const VALUE_FLAGS = new Set([
  "--icon",
  "--electron-version",
  "--bundle-id",
]);

/**
 * Parse flags. `--depends-on NAME=PATH` is consumed positionally because it
 * carries a value; `--icon <path>` / `--electron-version <range>` /
 * `--bundle-id <id>` likewise consume the next argv entry; everything else
 * is a boolean flag or a positional arg.
 */
for (let i = 0; i < rawArgv.length; i++) {
  const arg = rawArgv[i]!;
  if (arg === "--depends-on" || arg === "--dependsOn") {
    const value = rawArgv[++i];
    if (!value) {
      console.error("create-zenbu-app: --depends-on requires NAME=PATH");
      process.exit(1);
    }
    dependsOn.push(parseDependsOn(value));
  } else if (
    arg.startsWith("--depends-on=") ||
    arg.startsWith("--dependsOn=")
  ) {
    dependsOn.push(parseDependsOn(arg.slice(arg.indexOf("=") + 1)));
  } else if (VALUE_FLAGS.has(arg)) {
    const value = rawArgv[++i];
    if (!value) {
      console.error(`create-zenbu-app: ${arg} requires a value`);
      process.exit(1);
    }
    flagValues.set(arg, value);
  } else if (arg.startsWith("--") && arg.includes("=")) {
    const eq = arg.indexOf("=");
    const name = arg.slice(0, eq);
    if (VALUE_FLAGS.has(name)) {
      flagValues.set(name, arg.slice(eq + 1));
    } else {
      flagsSet.add(arg);
    }
  } else if (arg.startsWith("-")) {
    flagsSet.add(arg);
  } else {
    positional.push(arg);
  }
}

const yes = flagsSet.has("--yes") || flagsSet.has("-y");
const noInstall = flagsSet.has("--no-install");
const noGit = flagsSet.has("--no-git");
const pluginMode = flagsSet.has("--plugin");
const noAddToHost = flagsSet.has("--no-add-to-host");
const desktopMode = flagsSet.has("--desktop");
const desktopForce = flagsSet.has("--force");
const desktopDryRun = flagsSet.has("--dry-run");
const desktopVerbose = flagsSet.has("--verbose");
const desktopIcon = flagValues.get("--icon");
const desktopElectronVersion = flagValues.get("--electron-version");
const desktopBundleId = flagValues.get("--bundle-id");

if (desktopMode && pluginMode) {
  console.error("create-zenbu-app: --desktop is not compatible with --plugin");
  process.exit(1);
}

if (dependsOn.length > 0 && !pluginMode) {
  console.error("create-zenbu-app: --depends-on is only valid with --plugin");
  process.exit(1);
}

function parseDependsOn(raw: string): DependsOn {
  const eq = raw.indexOf("=");
  if (eq < 0) {
    console.error(
      `create-zenbu-app: --depends-on must be of the form NAME=PATH (got "${raw}")`,
    );
    process.exit(1);
  }
  const name = raw.slice(0, eq).trim();
  const rel = raw.slice(eq + 1).trim();
  if (!name) {
    console.error("create-zenbu-app: --depends-on NAME may not be empty");
    process.exit(1);
  }
  if (!rel) {
    console.error("create-zenbu-app: --depends-on PATH may not be empty");
    process.exit(1);
  }
  const abs = path.isAbsolute(rel) ? rel : path.resolve(process.cwd(), rel);
  if (!fs.existsSync(abs)) {
    console.error(`create-zenbu-app: --depends-on path does not exist: ${abs}`);
    process.exit(1);
  }
  return { name, from: abs };
}

// Internal/dev-only: when set to an absolute path of a local `@zenbujs/core`
// checkout, the scaffold rewrites `@zenbujs/core` to `link:<path>` before the
// initial git commit. Not advertised to end users.
const ZENBU_LOCAL_CORE = process.env.ZENBU_LOCAL_CORE;

// Internal/dev-only: when truthy, truncate the scaffolded `AGENTS.md` so the
// total file fits under ~40k characters. Some downstream tools cap the size
// of agent context files; this lets us scaffold without hitting that limit.
const TRIM_AGENTS_MD = process.env.TRIM_AGENTS_MD === "1";
const AGENTS_MD_MAX_CHARS = 40_000;

function trimAgentsMdIfRequested(projectDir: string): void {
  if (!TRIM_AGENTS_MD) return;
  const target = path.join(projectDir, "AGENTS.md");
  if (!fs.existsSync(target)) return;
  const original = fs.readFileSync(target, "utf8");
  if (original.length <= AGENTS_MD_MAX_CHARS) return;
  fs.writeFileSync(target, original.slice(0, AGENTS_MD_MAX_CHARS));
}

// config options
// Each entry is one user-facing scaffolding choice; `--yes` skips every
// `ask()` and uses the declared `default`.

interface ConfigOption<T> {
  id: string;
  default: T;
  ask: () => Promise<T | symbol>;
  /** Contributes a fragment (or `null`) to the resolved template slug. */
  slug: (value: T) => string | null;
}

const CONFIG_OPTIONS: ConfigOption<boolean>[] = [
  {
    id: "tailwind",
    default: true,
    ask: () =>
      p.confirm({
        message: "Use Tailwind CSS?",
        initialValue: true,
      }) as Promise<boolean | symbol>,
    slug: (v) => (v ? "tailwind" : null),
  },
];

interface ResolvedAnswers {
  [optionId: string]: unknown;
}

function resolveSlug(answers: ResolvedAnswers): string {
  const parts: string[] = [];
  for (const opt of CONFIG_OPTIONS) {
    const value = answers[opt.id] as never;
    const fragment = opt.slug(value);
    if (fragment) parts.push(fragment);
  }
  return parts.length > 0 ? parts.join("-") : "vanilla";
}

// package manager detection

type PmType = "pnpm" | "npm" | "yarn" | "bun";

interface DetectedPm {
  type: PmType;
  version: string;
  /** True when we fell back to a default (no actual detection succeeded). */
  fallback: boolean;
}

/**
 * Detect the PM that invoked `create-zenbu-app`. Order:
 *   1. `process.versions.bun` → bun (covers `bunx create-zenbu-app`).
 *   2. `npm_config_user_agent` → "<pm>/<version> ..." (set by all of npm,
 *      pnpm, yarn classic, yarn berry).
 *   3. Shell out to `<detected-name> --version` if user_agent only carries
 *      the bare name without a parseable version.
 *   4. Fallback to pnpm with a hardcoded sane default.
 */
function detectPackageManager(): DetectedPm {
  if (process.versions.bun) {
    return { type: "bun", version: process.versions.bun, fallback: false };
  }
  const ua = process.env.npm_config_user_agent;
  if (ua) {
    const first = ua.split(" ")[0];
    if (first) {
      const slash = first.indexOf("/");
      const name = (slash >= 0 ? first.slice(0, slash) : first).toLowerCase();
      const version = slash >= 0 ? first.slice(slash + 1) : "";
      if (
        name === "pnpm" ||
        name === "npm" ||
        name === "yarn" ||
        name === "bun"
      ) {
        if (version && /^\d/.test(version)) {
          return { type: name, version, fallback: false };
        }
        const probed = probeVersion(name);
        if (probed) return { type: name, version: probed, fallback: false };
      }
    }
  }
  return { type: "pnpm", version: "10.33.0", fallback: true };
}

function probeVersion(pm: PmType): string | null {
  const res = spawnSync(pm, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (res.status !== 0) return null;
  const out = (res.stdout ?? "").trim();
  // pnpm/npm just print the version. yarn classic prints "1.22.22"; yarn
  // berry prints "4.6.0". bun prints "1.3.12".
  const match = out.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/);
  return match ? match[0] : null;
}

/**
 * `npx`, `npm create`, and `npm exec` all set the same `npm/<version>`
 * user agent, so when `detectPackageManager` reports `npm` the user may
 * actually prefer a different installed pm. Probe all four candidates,
 * present only the ones present on the machine, and let the user pick
 * (or pick automatically when only one is installed / `--yes`).
 */
async function resolveNpmAmbiguity(
  detected: DetectedPm,
  opts: { yes: boolean },
): Promise<DetectedPm> {
  const candidates: PmType[] = ["pnpm", "npm", "yarn", "bun"];
  const installed: DetectedPm[] = [];
  for (const c of candidates) {
    if (c === "npm") {
      installed.push({
        type: "npm",
        version: detected.version,
        fallback: false,
      });
      continue;
    }
    const v = probeVersion(c);
    if (v) installed.push({ type: c, version: v, fallback: false });
  }

  if (installed.length === 1) return installed[0]!;

  const preferPnpm = installed.find((p) => p.type === "pnpm");
  if (opts.yes) return preferPnpm ?? installed.find((p) => p.type === "npm")!;

  const pick = await p.select<PmType>({
    message: "Which package manager should this app use?",
    initialValue: (preferPnpm?.type ?? "npm") as PmType,
    options: installed.map((p) => ({
      value: p.type,
      label: p.type === "pnpm" ? "pnpm (recommended)" : p.type,
    })),
  });
  if (p.isCancel(pick)) bail("Scaffolding cancelled.");
  return installed.find((p) => p.type === pick)!;
}

// template rendering helpers

type TemplateCtx = Record<string, string>;

function renderTemplate(value: string, ctx: TemplateCtx): string {
  return value.replace(/\{\{(\w+)\}\}/g, (full, key: string) => {
    return Object.prototype.hasOwnProperty.call(ctx, key) ? ctx[key]! : full;
  });
}

/**
 * Copy a template directory tree to `dest`. Both file *contents* and
 * file/directory *names* go through `renderTemplate`, so a template can
 * place a file at e.g. `src/main/services/{{projectName}}.ts.tmpl` and have
 * it land at `src/main/services/<projectName>.ts`. `.tmpl` is stripped.
 */
function copyDirSync(src: string, dest: string, ctx: TemplateCtx): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    let destName = entry.name.endsWith(".tmpl")
      ? entry.name.slice(0, -".tmpl".length)
      : entry.name;
    destName = renderTemplate(destName, ctx);
    const destPath = path.join(dest, destName);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath, ctx);
    } else {
      const content = fs.readFileSync(srcPath, "utf8");
      fs.writeFileSync(destPath, renderTemplate(content, ctx));
    }
  }
}

function toPascalCase(s: string): string {
  return s
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function relPosix(fromDir: string, toFile: string): string {
  let r = path.relative(fromDir, toFile).split(path.sep).join("/");
  if (!r.startsWith(".")) r = "./" + r;
  return r;
}

/**
 * Render a plugin's `dependsOn` literal for the scaffolded `zenbu.plugin.ts`.
 * Returns either an empty string (no deps → field omitted) or a leading-`\n`
 * fragment that slots in after the `services:` line, e.g.
 *
 *   \n  dependsOn: [\n    { name: "app", from: "../../zenbu.config.ts" },\n  ],
 *
 * Each `from` is rewritten relative to `pluginDir` so the generated file is
 * stable across moves of the surrounding workspace.
 */
function renderDependsOn(pluginDir: string, deps: DependsOn[]): string {
  if (deps.length === 0) return "";
  const lines: string[] = [];
  lines.push("");
  lines.push("  dependsOn: [");
  for (const d of deps) {
    const fromRel = relPosix(pluginDir, d.from);
    lines.push(
      `    { name: ${JSON.stringify(d.name)}, from: ${JSON.stringify(
        fromRel,
      )} },`,
    );
  }
  lines.push("  ],");
  return lines.join("\n");
}

/**
 * Replace the `// {{packageManager}}` marker in the scaffolded
 * `zenbu.config.ts` with a real `packageManager: { ... }` line. Idempotent
 * — running this twice yields the same file.
 */
function seedPackageManager(projectDir: string, pm: DetectedPm): void {
  const configPath = path.join(projectDir, "zenbu.config.ts");
  if (!fs.existsSync(configPath)) return;
  const original = fs.readFileSync(configPath, "utf8");
  const literal = `packageManager: { type: "${pm.type}", version: "${pm.version}" },`;
  const replaced = original.replace(/\/\/\s*\{\{packageManager\}\}/, literal);
  if (replaced !== original) {
    fs.writeFileSync(configPath, replaced);
  }
}

/**
 * Pin `@zenbujs/core` to a local checkout. For apps the dep lives in
 * `dependencies`; for plugins it's in `devDependencies` (plugins peer on
 * core).
 */
function rewireToLocalCore(
  projectDir: string,
  corePath: string,
  isPlugin: boolean,
): void {
  const pkgPath = path.join(projectDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const bucket = isPlugin ? "devDependencies" : "dependencies";
  pkg[bucket] = pkg[bucket] ?? {};
  pkg[bucket]["@zenbujs/core"] = `link:${corePath}`;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

/** Walk upward from `fromDir` looking for an ancestor with a `.git` dir. */
function findGitRoot(fromDir: string): string | null {
  let dir = path.resolve(fromDir);
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function gitInitWithInitialCommit(projectDir: string): void {
  const initRes = spawnSync("git", ["init", "-b", "main"], {
    cwd: projectDir,
    stdio: "ignore",
  });
  if (initRes.status !== 0) return;

  spawnSync("git", ["add", "-A"], { cwd: projectDir, stdio: "ignore" });

  const commitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "create-zenbu-app",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "create-zenbu-app@local",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "create-zenbu-app",
    GIT_COMMITTER_EMAIL:
      process.env.GIT_COMMITTER_EMAIL || "create-zenbu-app@local",
  };
  spawnSync("git", ["commit", "-m", "chore: scaffold via create-zenbu-app"], {
    cwd: projectDir,
    stdio: "ignore",
    env: commitEnv,
  });
}

// Host zenbu.config.ts mutation

/**
 * Append a path-form plugin entry to the host's `plugins: [ ... ]` array.
 * Idempotent — if the entry is already there, returns "already-present" and
 * doesn't rewrite. Returns "unsafe-shape" when the file's `plugins: [...]`
 * doesn't look like the scaffolded shape (spread syntax, missing array, etc.)
 * — caller logs a warning and prints the entry to add manually.
 */
type HostEditResult =
  | "added"
  | "already-present"
  | "unsafe-shape"
  | "missing-file";

function appendPluginToHostConfig(
  hostConfigPath: string,
  entry: string,
): HostEditResult {
  if (!fs.existsSync(hostConfigPath)) return "missing-file";
  const raw = fs.readFileSync(hostConfigPath, "utf8");
  // Find `plugins:` followed by `[`. We tolerate whitespace and a comment
  // between them.
  const pluginsMatch = raw.match(/\bplugins\s*:\s*\[/);
  if (!pluginsMatch) return "unsafe-shape";
  const openIdx = pluginsMatch.index! + pluginsMatch[0].length - 1;
  // Walk balanced brackets to find the matching `]`. Skips over strings and
  // single-line + block comments so we don't get tricked by `]` inside them.
  let depth = 1;
  let i = openIdx + 1;
  while (i < raw.length && depth > 0) {
    const ch = raw[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < raw.length && raw[i] !== quote) {
        if (raw[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i < raw.length - 1 && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    i++;
  }
  if (depth !== 0) return "unsafe-shape";
  const closeIdx = i - 1;
  const arrayBody = raw.slice(openIdx + 1, closeIdx);
  if (/\.\.\./.test(arrayBody)) return "unsafe-shape";
  // Already present (string match against the literal we'd add)?
  if (arrayBody.includes(JSON.stringify(entry))) return "already-present";
  // Determine indent for the new line: take the indent of the first non-empty
  // line inside the array, or default to two spaces of project + plugins indent.
  const lines = arrayBody.split("\n");
  let indent = "    ";
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const m = line.match(/^[ \t]+/);
    if (m) {
      indent = m[0];
      break;
    }
  }
  // Find the closing `]`'s line indent so the appended item lines up.
  const beforeClose = raw.slice(0, closeIdx);
  const lastLineStart = beforeClose.lastIndexOf("\n") + 1;
  const closeLineIndent = beforeClose.slice(lastLineStart).match(/^[ \t]*/)![0];
  // Slice in: keep everything up to (and including) the last item / opening
  // bracket, then add the new line, then the rest.
  // We append directly before the closing `]`. If the last visible content
  // before `]` doesn't end with a comma, add one.
  let head = raw.slice(0, closeIdx).replace(/\s*$/, "");
  if (head.length > 0 && !head.endsWith(",") && !head.endsWith("[")) {
    head += ",";
  }
  const insertion = `\n${indent}${JSON.stringify(entry)},\n${closeLineIndent}`;
  const next = head + insertion + raw.slice(closeIdx);
  if (next === raw) return "already-present";
  fs.writeFileSync(hostConfigPath, next);
  return "added";
}

/**
 * Run `<pm> install` in the freshly-scaffolded project so the user can go
 * straight to `pnpm dev`/`bun dev`/etc. without the extra step. We run with
 * the user's globally-installed PM (which is what they used to invoke us in
 * the first place), so this won't hit the bundled toolchain — that only
 * matters at the .app's first launch on the consumer's machine.
 */
function runInstall(projectDir: string, pm: DetectedPm): boolean {
  const res = spawnSync(pm.type, ["install"], {
    cwd: projectDir,
    stdio: "inherit",
  });
  return res.status === 0;
}

/** Run `<pm> exec zen link [extraArgs...]` in `cwd`. */
function runZenLink(
  cwd: string,
  pm: DetectedPm,
  extraArgs: string[] = [],
): boolean {
  const args = ["exec", "zen", "link", ...extraArgs];
  // yarn classic uses different exec semantics; bun/pnpm/npm all support
  // `exec` to run a local binary. For yarn classic we fall back to direct
  // `yarn zen link` which yarn rewrites to the bin lookup.
  const cmd =
    pm.type === "yarn" && pm.version.startsWith("1.") ? pm.type : pm.type;
  const finalArgs =
    pm.type === "yarn" && pm.version.startsWith("1.")
      ? ["zen", "link", ...extraArgs]
      : args;
  const res = spawnSync(cmd, finalArgs, { cwd, stdio: "inherit" });
  return res.status === 0;
}

// prompts

function bail(reason: string): never {
  p.cancel(reason);
  process.exit(1);
}

function validateProjectName(value: string | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "Project name is required.";
  if (trimmed === ".") return undefined;
  if (/[\\/]/.test(trimmed)) return "Project name cannot contain slashes.";
  if (/\s/.test(trimmed)) return "Project name cannot contain whitespace.";
  // Mirror npm's rough rules: lowercase-friendly, no leading dot/underscore.
  if (/^[._]/.test(trimmed))
    return "Project name cannot start with '.' or '_'.";
  return undefined;
}

async function promptProjectName(): Promise<string> {
  const result = await p.text({
    message: "Project name?",
    placeholder: "my-zenbu-app",
    defaultValue: "my-zenbu-app",
    validate: validateProjectName,
  });
  if (p.isCancel(result)) bail("Scaffolding cancelled.");
  return result as string;
}

async function promptOptions(): Promise<ResolvedAnswers> {
  const answers: ResolvedAnswers = {};
  for (const opt of CONFIG_OPTIONS) {
    const value = await opt.ask();
    if (p.isCancel(value)) bail("Scaffolding cancelled.");
    answers[opt.id] = value;
  }
  return answers;
}

function defaultAnswers(): ResolvedAnswers {
  const answers: ResolvedAnswers = {};
  for (const opt of CONFIG_OPTIONS) {
    answers[opt.id] = opt.default;
  }
  return answers;
}

// main

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

async function promptIconPath(): Promise<string | undefined> {
  const result = await p.text({
    message: "Path to app icon",
    placeholder: "(leave blank to use Electron's default icon)",
    validate: (value) => {
      if (!value || !value.trim()) return undefined;
      const abs = path.isAbsolute(value)
        ? value
        : path.resolve(process.cwd(), value);
      if (!fs.existsSync(abs)) return `File does not exist: ${abs}`;
      const ext = path.extname(abs).toLowerCase();
      if (ext !== ".png" && ext !== ".icns") {
        return "Icon must be a .png (square, ideally 1024x1024) or .icns file";
      }
      return undefined;
    },
  });
  if (p.isCancel(result)) bail("Scaffolding cancelled.");
  const trimmed = (result as string).trim();
  if (!trimmed) return undefined;
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
}

const DESKTOP_PM_PRECEDENCE: PmType[] = ["pnpm", "bun", "yarn", "npm"];

function pickDesktopPm(detected: DetectedPm): DetectedPm {
  for (const candidate of DESKTOP_PM_PRECEDENCE) {
    if (candidate === "npm") {
      return { type: "npm", version: detected.version, fallback: false };
    }
    const v = probeVersion(candidate);
    if (v) return { type: candidate, version: v, fallback: false };
  }
  return detected;
}

async function runDesktopMode(): Promise<void> {
  p.intro("create-zenbu-app (desktop)");

  let displayName: string;
  if (positional[0]) {
    displayName = positional[0];
  } else if (yes) {
    bail("--yes requires a positional project name in --desktop mode.");
  } else {
    displayName = await promptProjectName();
  }
  const slug = slugify(displayName);
  if (!slug) {
    bail(`"${displayName}" produces an empty slug; use letters/digits.`);
  }

  const appsDir = path.join(os.homedir(), ".zenbu", "apps", slug);

  if (fs.existsSync(appsDir)) {
    const entries = fs.readdirSync(appsDir);
    if (entries.length > 0) {
      if (!desktopForce) {
        bail(
          `${appsDir} already exists. Re-run with --force to overwrite (this will rm -rf both ${appsDir} and the bundle).`,
        );
      }
      if (desktopDryRun) {
        p.log.info(`[dry-run] would rm -rf ${appsDir}`);
      } else {
        fs.rmSync(appsDir, { recursive: true, force: true });
      }
    }
  }

  let iconPath = desktopIcon
    ? path.isAbsolute(desktopIcon)
      ? desktopIcon
      : path.resolve(process.cwd(), desktopIcon)
    : undefined;
  if (!iconPath && !yes) {
    iconPath = await promptIconPath();
  }
  if (iconPath && !fs.existsSync(iconPath)) {
    bail(`--icon path does not exist: ${iconPath}`);
  }

  // Desktop mode bakes opinionated defaults: tailwind on. Users can swap
  // afterwards by editing their scaffold; no need to ask up front.
  const slugTemplate = "tailwind";
  const templateDir = path.join(TEMPLATES_DIR, slugTemplate);
  if (!fs.existsSync(templateDir)) {
    bail(`No template found for configuration "${slugTemplate}".`);
  }

  // Desktop mode never prompts for the package manager. Pick the first
  // installed PM in precedence pnpm > bun > yarn > npm. The detected PM
  // is only used as a versioned npm fallback.
  const detectedPm = detectPackageManager();
  const pm = pickDesktopPm(detectedPm);

  const log = createLogger({ slug, verbose: desktopVerbose });
  log.info(`displayName=${displayName} slug=${slug}`);
  log.info(`template=${slugTemplate} pm=${pm.type}@${pm.version}`);
  log.info(`appsDir=${appsDir}`);
  log.info(`logFile=${log.file}`);

  try {
    if (desktopDryRun) {
      log.info(`[dry-run] would scaffold template into ${appsDir}`);
    } else {
      fs.mkdirSync(appsDir, { recursive: true });
      const ctx: TemplateCtx = { projectName: slug, displayName };
      copyDirSync(templateDir, appsDir, ctx);
      const overlayDir = path.join(TEMPLATES_DIR, "desktop-overlay");
      if (fs.existsSync(overlayDir)) {
        copyDirSync(overlayDir, appsDir, ctx);
      }
      const gi = path.join(appsDir, "_gitignore");
      if (fs.existsSync(gi)) {
        fs.renameSync(gi, path.join(appsDir, ".gitignore"));
      }
      seedPackageManager(appsDir, pm);
      trimAgentsMdIfRequested(appsDir);

      if (ZENBU_LOCAL_CORE) {
        const corePath = path.resolve(ZENBU_LOCAL_CORE);
        rewireToLocalCore(appsDir, corePath, false);
        log.info(`linked @zenbujs/core -> ${corePath}`);
      }
    }

    let installed = false;
    if (!noInstall && !desktopDryRun) {
      p.log.step(`Installing dependencies`);
      log.info(`running ${pm.type} install in ${appsDir}`);
      installed = runInstallSilent(appsDir, pm, log);
      if (!installed) {
        p.log.error(`Failed during ${pm.type} install. See ${log.file}`);
        process.stderr.write(log.tail(40) + "\n");
        process.exit(1);
      }
    }

    if (!desktopDryRun) {
      gitInitWithInitialCommit(appsDir);
    }

    const projectVersion = readProjectVersion(appsDir) ?? "0.0.1";

    p.log.step(`Building desktop app`);
    const result = await buildDesktopApp({
      displayName,
      slug,
      version: projectVersion,
      electronVersionRange: desktopElectronVersion,
      iconSource: iconPath,
      appsDir,
      packageManager: pm,
      resolveFrom: appsDir,
      log,
      force: desktopForce,
      dryRun: desktopDryRun,
      skipDepsSig: noInstall,
    });

    p.log.success(`Created ${displayName}`);
    log.close();

    p.note(
      [
        `App:       ${result.destApp}`,
        `Source:    ${result.appsDir}`,
        `Logs:      ~/Library/Logs/${displayName}/main.log`,
      ].join("\n"),
      "Details",
    );
    p.outro(`Launch with:  ${result.launchCommand}`);
  } catch (err) {
    p.log.error(`Failed: see ${log.file}`);
    log.error((err as Error).stack ?? (err as Error).message ?? String(err));
    process.stderr.write("\n--- last log lines ---\n" + log.tail(40) + "\n");
    log.close();
    process.exit(1);
  }
}

function readProjectVersion(dir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(dir, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

function runInstallSilent(
  projectDir: string,
  pm: DetectedPm,
  log: { info(line: string): void; error(line: string): void },
): boolean {
  const r = spawnSync(pm.type, ["install"], {
    cwd: projectDir,
    stdio: "pipe",
    encoding: "utf8",
  });
  if (r.stdout) log.info(r.stdout);
  if (r.stderr) log.info(r.stderr);
  return r.status === 0;
}

async function main(): Promise<void> {
  if (desktopMode) {
    await runDesktopMode();
    return;
  }
  p.intro(pluginMode ? "create-zenbu-app (plugin)" : "create-zenbu-app");

  let projectName: string;
  if (positional[0]) {
    projectName = positional[0];
  } else if (yes) {
    projectName = ".";
  } else {
    projectName = await promptProjectName();
  }

  const projectDir = path.resolve(process.cwd(), projectName);
  const displayName = path.basename(projectDir);

  if (fs.existsSync(projectDir)) {
    const entries = fs.readdirSync(projectDir).filter((e) => e !== ".git");
    const isDot = projectName === "." || projectDir === process.cwd();
    const allowedExisting =
      isDot && fs.existsSync(path.join(projectDir, "package.json"));
    if (entries.length > 0 && !allowedExisting) {
      bail(`Directory "${projectName}" already exists and is not empty.`);
    }
  }

  // Plugin mode short-circuits all CONFIG_OPTIONS prompts (those are
  // app-only: Tailwind etc. don't apply to plugins). It also uses a
  // different template and skips build-config seeding.
  let templateDir: string;
  let slug: string;
  if (pluginMode) {
    slug = "plugin";
    templateDir = path.join(TEMPLATES_DIR, "plugin");
  } else {
    const answers = yes ? defaultAnswers() : await promptOptions();
    slug = resolveSlug(answers);
    templateDir = path.join(TEMPLATES_DIR, slug);
  }
  if (!fs.existsSync(templateDir)) {
    bail(`No template found for configuration "${slug}".`);
  }

  let pm = detectPackageManager();
  if (pm.type === "npm") {
    pm = await resolveNpmAmbiguity(pm, { yes });
  }

  p.log.step(
    `Scaffolding Zenbu ${
      pluginMode ? "plugin" : "app"
    } in "${displayName}" (template: ${slug})`,
  );

  const ctx: TemplateCtx = pluginMode
    ? {
        projectName: displayName,
        className: toPascalCase(displayName),
        dependsOn: renderDependsOn(projectDir, dependsOn),
      }
    : { projectName: displayName };

  copyDirSync(templateDir, projectDir, ctx);

  const gi = path.join(projectDir, "_gitignore");
  if (fs.existsSync(gi)) {
    fs.renameSync(gi, path.join(projectDir, ".gitignore"));
  }

  if (!pluginMode) {
    seedPackageManager(projectDir, pm);
  }
  trimAgentsMdIfRequested(projectDir);

  if (ZENBU_LOCAL_CORE) {
    const corePath = path.resolve(ZENBU_LOCAL_CORE);
    rewireToLocalCore(projectDir, corePath, pluginMode);
    p.log.info(`linked @zenbujs/core -> ${corePath}`);
  }

  let installed = false;
  if (!noInstall) {
    p.log.step(`running ${pm.type} install`);
    installed = runInstall(projectDir, pm);
    if (!installed) {
      p.log.warn(
        `${pm.type} install failed; you can retry manually after the scaffold completes.`,
      );
    }
  }

  // Plugin mode: optionally add this plugin to each upstream host's
  // `plugins:[]`. Prompted interactively (default yes) unless `--yes` or
  // `--no-add-to-host` short-circuit. Only zenbu.config.ts deps are
  // candidates; standalone zenbu.plugin.ts dependencies are not hosts.
  const hostsToLink = new Set<string>();
  if (pluginMode && !noAddToHost) {
    for (const dep of dependsOn) {
      const base = path.basename(dep.from);
      const isConfig = base.startsWith("zenbu.config.");
      if (!isConfig) continue;
      const hostDir = path.dirname(dep.from);
      const pluginManifestRel = relPosix(
        hostDir,
        path.join(projectDir, "zenbu.plugin.ts"),
      );
      let accept = yes;
      if (!yes) {
        const result = await p.confirm({
          message: `Add "${pluginManifestRel}" to ${
            path.relative(process.cwd(), dep.from) || dep.from
          } plugins:?`,
          initialValue: true,
        });
        if (p.isCancel(result)) bail("Scaffolding cancelled.");
        accept = !!result;
      }
      if (!accept) continue;
      const outcome = appendPluginToHostConfig(dep.from, pluginManifestRel);
      switch (outcome) {
        case "added":
          p.log.success(`wired into ${dep.from}`);
          hostsToLink.add(hostDir);
          break;
        case "already-present":
          p.log.info(`already listed in ${dep.from}`);
          hostsToLink.add(hostDir);
          break;
        case "missing-file":
          p.log.warn(`host config not found: ${dep.from}`);
          break;
        case "unsafe-shape":
          p.log.warn(
            `${
              dep.from
            }: couldn't safely edit plugins:[]. Add this manually:\n    ${JSON.stringify(
              pluginManifestRel,
            )},`,
          );
          break;
      }
    }
  }

  // Run `zen link` after install so types are wired up.
  if (installed) {
    if (pluginMode) {
      // Prefer host link (each host's composite picks up the new plugin
      // in the same call). Fall back to standalone plugin link if no host
      // got edited.
      if (hostsToLink.size > 0) {
        for (const hostDir of hostsToLink) {
          p.log.step(`running zen link in ${hostDir}`);
          const ok = runZenLink(hostDir, pm);
          if (!ok) p.log.warn(`zen link failed in ${hostDir}`);
        }
      } else {
        p.log.step(`running zen link --plugin .`);
        const ok = runZenLink(projectDir, pm, ["--plugin", "."]);
        if (!ok) p.log.warn(`zen link --plugin . failed`);
      }
    } else {
      p.log.step(`running ${pm.type} run link`);
      const res = spawnSync(pm.type, ["run", "link"], {
        cwd: projectDir,
        stdio: "inherit",
      });
      if (res.status !== 0) {
        p.log.warn(
          `${pm.type} run link failed; you can retry manually after the scaffold completes.`,
        );
      }
    }
  }

  // Git init: skipped automatically when an ancestor already owns a repo
  // (common when scaffolding a plugin inside an existing host repo). When
  // no ancestor repo exists, prompt (default yes); suppressed by --no-git;
  // auto-confirmed by --yes.
  if (!noGit) {
    const ancestorRepo = findGitRoot(projectDir);
    if (ancestorRepo) {
      p.log.info(`inside existing repo at ${ancestorRepo} — skipping git init`);
    } else {
      let doInit = yes;
      if (!yes) {
        const result = await p.confirm({
          message: "Initialize a git repo here?",
          initialValue: true,
        });
        if (p.isCancel(result)) bail("Scaffolding cancelled.");
        doInit = !!result;
      }
      if (doInit) {
        gitInitWithInitialCommit(projectDir);
      }
    }
  }

  const cdHint = projectName === "." ? "" : `cd ${displayName} && `;
  const next = pluginMode
    ? installed
      ? `${cdHint}${pm.type} run typecheck`
      : `${cdHint}${pm.type} install`
    : installed
    ? `${cdHint}${pm.type} dev`
    : `${cdHint}${pm.type} install\n  ${cdHint}${pm.type} dev`;
  p.outro(`Done. Next:\n\n  ${next}\n`);
}

main().catch((err) => {
  console.error("\nError:", (err as Error)?.message ?? err);
  process.exit(1);
});

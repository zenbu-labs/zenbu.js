import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import semver from "semver";

import { loadConfig } from "../lib/load-config";
import { provisionToolchain } from "../lib/toolchain";
import type { PackageManagerSpec } from "../lib/build-config";
import {
  HOST_VERSION_FILENAME,
  writeHostVersion,
} from "../../shared/host-version";

interface BuildElectronFlags {
  config?: string;
  passthrough: string[];
}

interface BundlePackageJson {
  name: string;
  version: string;
  main: string;
  type: string;
  repository?: { type: "git"; url: string };
}

interface AppConfigJson {
  name: string;
  mirrorUrl: string;
  branch: string;
  version: string;
  packageManager: PackageManagerSpec;
  /**
   * Path (relative to the .app's `Resources/` dir) of the staged
   * `installing.html`. Set when the user shipped one in their
   * `<uiEntrypoint>/installing.html`. Read by [launcher.ts] to spawn
   * the install-progress window before clone + first install.
   */
  installingHtml?: string;
  /**
   * Path (relative to the .app's `Resources/` dir) of the framework's
   * built-in preload that exposes `window.zenbuInstall`. Set whenever
   * EITHER `installingHtml` OR a staged `updating.html` is present
   * (both flows use the same preload surface). The launcher only reads
   * it for the cold-boot install window; the plugin-update supervisor
   * resolves the preload itself at runtime.
   */
  installingPreload?: string;
}

interface ElectronBuilderConfig {
  appId?: string;
  productName?: string;
  asar?: boolean;
  directories?: {
    app?: string;
    output?: string;
    buildResources?: string;
  };
  files?: unknown;
  extraResources?: unknown;
  mac?: Record<string, unknown>;
  win?: Record<string, unknown>;
  linux?: Record<string, unknown>;
  publish?: unknown;
  npmRebuild?: boolean;
  [key: string]: unknown;
}

const ELECTRON_BUILDER_CONFIG_NAMES = [
  "electron-builder.json",
  "electron-builder.json5",
  "electron-builder.yml",
  "electron-builder.yaml",
  "electron-builder.config.js",
  "electron-builder.config.cjs",
  "electron-builder.config.mjs",
];

function resolveProjectDir(): string {
  const cwd = process.cwd();
  for (const name of [
    "zenbu.config.ts",
    "zenbu.config.mts",
    "zenbu.config.js",
    "zenbu.config.mjs",
  ]) {
    if (fs.existsSync(path.join(cwd, name))) return cwd;
  }
  console.error(
    "zen build:electron: no zenbu.config.ts found in current directory",
  );
  process.exit(1);
}

/**
 * Args use `--` to delimit zen flags from electron-builder pass-through
 * flags. e.g. `pnpm build:electron -- --publish always` forwards
 * `--publish always` to electron-builder. Without `--` everything is treated
 * as a zen flag (and unknown flags error out).
 */
function parseFlags(argv: string[]): BuildElectronFlags {
  const flags: BuildElectronFlags = { passthrough: [] };
  let sawSeparator = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (sawSeparator) {
      flags.passthrough.push(arg);
      continue;
    }
    if (arg === "--") {
      sawSeparator = true;
      continue;
    }
    if (arg === "--config" || arg === "-c") flags.config = argv[++i];
    else if (arg.startsWith("--config="))
      flags.config = arg.slice("--config=".length);
    else {
      console.error(`zen build:electron: unknown flag "${arg}"`);
      console.error(
        `valid: zen build:electron [--config <zenbu.build.ts>] [-- <electron-builder args>]`,
      );
      process.exit(1);
    }
  }
  return flags;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function expandMirrorUrl(target: string): string {
  if (
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("git@")
  ) {
    return target;
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(target)) {
    return `https://github.com/${target}.git`;
  }
  return target;
}

/**
 * Find a sibling file inside `@zenbujs/core/dist/`. Resolved through
 * Node's resolution from the user's project so the artifact matches the
 * `@zenbujs/core` actually installed in their `node_modules` (which is
 * what runs in the bundled .app). Falls back to walking up from this
 * file's location for the in-monorepo dev case.
 */
function resolveCoreDistFile(projectDir: string, fileName: string): string {
  const localRequire = createRequire(path.join(projectDir, "package.json"));
  try {
    const pkgPath = localRequire.resolve("@zenbujs/core/package.json");
    const candidate = path.join(path.dirname(pkgPath), "dist", fileName);
    if (fs.existsSync(candidate)) return candidate;
  } catch {}
  const here = fileURLToPath(import.meta.url);
  const candidate = path.resolve(path.dirname(here), "..", fileName);
  if (fs.existsSync(candidate)) return candidate;
  throw new Error(
    `zen build:electron: cannot locate \`@zenbujs/core/dist/${fileName}\`. ` +
      "Make sure @zenbujs/core is installed in this project.",
  );
}

function resolveLauncher(projectDir: string): string {
  return resolveCoreDistFile(projectDir, "launcher.mjs");
}

function resolveElectronBuilder(projectDir: string): string {
  const candidates = [
    path.join(projectDir, "node_modules", ".bin", "electron-builder"),
    path.join(
      projectDir,
      "node_modules",
      "electron-builder",
      "out",
      "cli",
      "cli.js",
    ),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    "zen build:electron: electron-builder not found in node_modules. " +
      "Add it to devDependencies and run `pnpm install`.",
  );
}

function findElectronBuilderConfig(
  projectDir: string,
): { path: string; format: "json" | "other" } | null {
  for (const name of ELECTRON_BUILDER_CONFIG_NAMES) {
    const candidate = path.join(projectDir, name);
    if (fs.existsSync(candidate)) {
      return {
        path: candidate,
        format: name.endsWith(".json") ? "json" : "other",
      };
    }
  }
  const pkgPath = path.join(projectDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = readJson<{ build?: ElectronBuilderConfig }>(pkgPath);
      if (pkg.build) return { path: pkgPath, format: "json" };
    } catch {}
  }
  return null;
}

function readElectronBuilderConfig(projectDir: string): ElectronBuilderConfig {
  const found = findElectronBuilderConfig(projectDir);
  if (!found) {
    throw new Error(
      [
        "zen build:electron: no electron-builder config found.",
        "",
        "Create `electron-builder.json` in the project root, e.g.:",
        "",
        "  {",
        '    "appId": "dev.you.your-app",',
        '    "productName": "Your App",',
        '    "asar": false,',
        '    "directories": { "output": "dist" },',
        '    "mac": { "category": "public.app-category.developer-tools", "target": ["zip"] }',
        "  }",
        "",
      ].join("\n"),
    );
  }
  if (found.format !== "json") {
    throw new Error(
      `zen build:electron: only JSON electron-builder configs are supported right now (got ${path.basename(
        found.path,
      )}). ` +
        `Convert to electron-builder.json or move the config under package.json#build.`,
    );
  }
  if (path.basename(found.path) === "package.json") {
    const pkg = readJson<{ build?: ElectronBuilderConfig }>(found.path);
    return { ...(pkg.build ?? {}) };
  }
  return readJson<ElectronBuilderConfig>(found.path);
}

function currentSourceSha(projectDir: string): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: projectDir,
      encoding: "utf8",
    }).trim();
  } catch {
    return "uncommitted";
  }
}

async function spawnAsync(
  cmd: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit", env });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

/**
 * Compose the user's electron-builder config with the zenbu overlays. The
 * overlays are minimal and targeted:
 *
 *   - `directories.app`        owned by zen — points at our staged app dir
 *   - `files`                  owned by zen — the staged app dir is fully
 *                              under our control, so user-side `files`
 *                              entries would not resolve anyway
 *   - `extraResources`         additive — we APPEND the toolchain entry to
 *                              whatever the user already declared
 *   - `npmRebuild`             forced to false — the launcher clones the
 *                              source from the mirror at first launch and
 *                              runs `pnpm install` then; nothing to rebuild
 *                              at electron-builder time
 *
 * Everything else (`appId`, `productName`, `mac`, `win`, `linux`,
 * `publish`, `directories.output`, `directories.buildResources`, `asar`,
 * signing/notarize, target list) is preserved as-is from the user's config.
 */
function mergeElectronBuilderConfig(
  userConfig: ElectronBuilderConfig,
  overlay: {
    appDir: string;
    output: string;
    bundleFiles: string[];
    extraResources: Array<{ from: string; to: string }>;
  },
): ElectronBuilderConfig {
  const merged: ElectronBuilderConfig = { ...userConfig };
  merged.directories = {
    ...(userConfig.directories ?? {}),
    app: overlay.appDir,
    output: overlay.output,
  };
  merged.files = overlay.bundleFiles;
  const userExtra = Array.isArray(userConfig.extraResources)
    ? (userConfig.extraResources as Array<
        { from: string; to: string } | string
      >)
    : [];
  merged.extraResources = [...userExtra, ...overlay.extraResources];
  if (userConfig.npmRebuild !== false) merged.npmRebuild = false;
  if (userConfig.asar === undefined) merged.asar = false;
  return merged;
}

async function copyFile(src: string, dest: string): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.copyFile(src, dest);
}

/**
 * Stage the user's boot-time HTML(s) plus the framework's built-in
 * `installing-preload.cjs` (and, by convention, the sibling `icon.png`)
 * into the bundle dir.
 *
 * Both `installing.html` (cold-boot install, loaded by `launcher.ts`) and
 * `updating.html` (in-app plugin update, loaded by the plugin-update
 * supervisor at runtime) share the same preload — `window.zenbuInstall`
 * — so we only stage one copy regardless of which / both pages are
 * present. Each `*Src` is optional; pass `null` to skip.
 *
 * Convention: if `<uiEntrypoint>/icon.png` exists, it is staged to
 * `Resources/icon.png` whenever any HTML is staged. Both the install
 * and update screens reference `./icon.png` by convention (matching
 * splash.html), so this is the minimum sibling asset needed for the
 * default templates to render correctly. Other sibling assets (CSS,
 * fonts, additional images) are still the user's responsibility via
 * their own `electron-builder.json#extraResources`.
 */
async function stageInstallingArtifacts(args: {
  projectDir: string;
  entrypointDir: string;
  installingSrc: string | null;
  updatingSrc: string | null;
  installingHtmlOut: string;
  updatingHtmlOut: string;
  installingPreloadOut: string;
  iconOut: string;
}): Promise<{ installing: boolean; updating: boolean; icon: boolean }> {
  let installing = false;
  let updating = false;
  let icon = false;
  if (args.installingSrc) {
    await copyFile(args.installingSrc, args.installingHtmlOut);
    installing = true;
  }
  if (args.updatingSrc) {
    await copyFile(args.updatingSrc, args.updatingHtmlOut);
    updating = true;
  }
  if (installing || updating) {
    const preloadSrc = resolveCoreDistFile(
      args.projectDir,
      "installing-preload.cjs",
    );
    await copyFile(preloadSrc, args.installingPreloadOut);
    // Sibling icon, by convention. Silent skip if absent — the HTML's
    // <img src="./icon.png"> will simply render as the alt text.
    const iconSrc = path.join(args.entrypointDir, "icon.png");
    if (fs.existsSync(iconSrc)) {
      await copyFile(iconSrc, args.iconOut);
      icon = true;
    }
  }
  return { installing, updating, icon };
}

export async function runBuildElectron(argv: string[]): Promise<void> {
  const projectDir = resolveProjectDir();
  const flags = parseFlags(argv);
  void flags; // legacy --config flag is currently a no-op; kept for back-compat

  const { resolved } = await loadConfig(projectDir, { skipLocalManifests: true });
  const config = resolved.build;

  // The mirror is now strictly required: the launcher clones from it on
  // first run instead of unpacking a bundled seed. Building without one
  // would produce an .app that has no source to run.
  const mirrorTarget = config.mirror?.target;
  if (!mirrorTarget) {
    throw new Error(
      "zen build:electron: `build.mirror.target` is required in zenbu.config.ts. " +
        'Set build: defineBuildConfig({ mirror: { target: "<owner>/<repo>", branch: "main" }, ... }) ' +
        "and run `zen publish:source init` before building.",
    );
  }
  const mirrorBranch = config.mirror?.branch ?? "main";
  const mirrorUrl = expandMirrorUrl(mirrorTarget);

  // Stage the bundle outside the project tree. If we stage inside (e.g.
  // `.zenbu/build/electron/`), electron-builder walks UP looking for
  // `node_modules` and ends up bundling the project's whole devDep tree
  // into Resources/app/node_modules even though our generated bundle
  // package.json declares no deps. Using os.tmpdir() ends that walk
  // immediately at /tmp.
  const projectPkgPath = path.join(projectDir, "package.json");
  const projectPkg = readJson<{ name?: string; version?: string }>(
    projectPkgPath,
  );
  const appName = projectPkg.name ?? path.basename(projectDir);

  // `package.json#version` is the .app's host version: it gets baked
  // into `<bundle>/host.json` and is what each commit's
  // `package.json#zenbu.host` semver range is checked against at
  // launch / update. Required + must be a real semver string. We
  // intentionally don't fall back to a placeholder — silently shipping
  // an .app with the wrong host version would let it pull source it
  // can't actually run.
  const rawAppVersion = projectPkg.version;
  if (typeof rawAppVersion !== "string" || rawAppVersion.trim().length === 0) {
    throw new Error(
      `zen build:electron: ${projectPkgPath} is missing a non-empty \`version\` field. ` +
        `This value is baked into <bundle>/host.json as the .app's host version — ` +
        `bump it whenever you ship a new .app build.`,
    );
  }
  const appVersion = rawAppVersion.trim();
  if (!semver.valid(appVersion)) {
    throw new Error(
      `zen build:electron: ${projectPkgPath} \`version\` ("${rawAppVersion}") ` +
        `is not a valid semver string (expected MAJOR.MINOR.PATCH with optional ` +
        `prerelease / build metadata).`,
    );
  }

  const bundleDir = await fsp.mkdtemp(
    path.join(os.tmpdir(), `zenbu-electron-${appName}-`),
  );
  const toolchainDir = path.join(bundleDir, "toolchain");
  const launcherOut = path.join(bundleDir, "launcher.mjs");
  const bundlePkgOut = path.join(bundleDir, "package.json");
  const appConfigOut = path.join(bundleDir, "app-config.json");
  const mergedConfigPath = path.join(bundleDir, "electron-builder.merged.json");
  const installingHtmlOut = path.join(bundleDir, "installing.html");
  const updatingHtmlOut = path.join(bundleDir, "updating.html");
  const installingPreloadOut = path.join(bundleDir, "installing-preload.cjs");
  const iconOut = path.join(bundleDir, "icon.png");

  const sourceSha = currentSourceSha(projectDir);

  const packageManager = config.packageManager;
  const pmLabel = `${packageManager.type}@${packageManager.version}`;

  console.log(`\n  zen build:electron`);
  console.log(`    name:    ${appName}`);
  console.log(`    version: ${appVersion}`);
  console.log(
    `    source:  ${
      sourceSha === "uncommitted" ? "uncommitted" : sourceSha.slice(0, 7)
    }`,
  );
  console.log(`    mirror:  ${mirrorTarget} (${mirrorBranch})`);
  console.log(`    pm:      ${pmLabel}`);
  console.log(`    bundle:  ${bundleDir}`);

  console.log("  → staging launcher.mjs");
  const launcherSrc = resolveLauncher(projectDir);
  await copyFile(launcherSrc, launcherOut);

  // Stage the optional installing.html / updating.html + the framework's
  // built-in preload. Only the canonical files; sibling assets (CSS,
  // images, fonts) are the user's responsibility via their own
  // electron-builder.json#extraResources.
  const staged =
    resolved.installingPath || resolved.updatingPath
      ? await stageInstallingArtifacts({
          projectDir,
          entrypointDir: resolved.uiEntrypointPath,
          installingSrc: resolved.installingPath ?? null,
          updatingSrc: resolved.updatingPath ?? null,
          installingHtmlOut,
          updatingHtmlOut,
          installingPreloadOut,
          iconOut,
        })
      : { installing: false, updating: false, icon: false };
  if (staged.installing) {
    console.log(
      `  → staging installing.html (${path.relative(
        projectDir,
        resolved.installingPath!,
      )})`,
    );
  }
  if (staged.updating) {
    console.log(
      `  → staging updating.html (${path.relative(
        projectDir,
        resolved.updatingPath!,
      )})`,
    );
  }
  if (staged.installing || staged.updating) {
    console.log(`  → staging installing-preload.cjs`);
  }
  if (staged.icon) {
    console.log(`  → staging icon.png (sibling of *.html)`);
  }

  console.log(`  → provisioning bundled toolchain (bun + ${pmLabel})`);
  await provisionToolchain(toolchainDir, { packageManager });

  console.log("  → writing bundle package.json + app-config.json + host.json");
  const bundlePkg: BundlePackageJson = {
    name: appName,
    version: appVersion,
    main: "launcher.mjs",
    type: "module",
    repository: { type: "git", url: mirrorUrl },
  };
  await fsp.writeFile(bundlePkgOut, JSON.stringify(bundlePkg, null, 2) + "\n");

  const appConfig: AppConfigJson = {
    name: appName,
    mirrorUrl,
    branch: mirrorBranch,
    version: appVersion,
    packageManager,
    // `installingHtml` / `installingPreload` are read by the launcher
    // ONLY for the cold-boot install window. We don't expose updating.html
    // here — the supervisor resolves `<Resources>/updating.html` by
    // hardcoded name at runtime.
    ...(staged.installing
      ? {
          installingHtml: "installing.html",
          installingPreload: "installing-preload.cjs",
        }
      : {}),
  };
  await fsp.writeFile(appConfigOut, JSON.stringify(appConfig, null, 2) + "\n");

  // host.json is the single source of truth for the .app's host version
  // (read by both the launcher and `UpdaterService` to drive
  // `package.json#zenbu.host` range checks at clone/fetch/update time).
  // Lives at the bundle root, separate from app-config.json so its
  // single purpose stays obvious. The value comes from
  // `package.json#version` — read here at build time and frozen into
  // the .app, independent of subsequent `git pull`s of the source.
  writeHostVersion(bundleDir, appVersion);

  const userConfig = readElectronBuilderConfig(projectDir);
  // Resolve `directories.output` to an absolute path BEFORE we hand it to
  // electron-builder. The user's config likely says `dist` (project-relative),
  // but electron-builder resolves it relative to `directories.app` — which
  // we just rewrote to an os.tmpdir() path. Without this, the .app would
  // land in `<tmpdir>/dist/` instead of the user's project.
  const userOutput = userConfig.directories?.output ?? "dist";
  const resolvedOutput = path.isAbsolute(userOutput)
    ? userOutput
    : path.resolve(projectDir, userOutput);

  const overlayExtraResources: Array<{ from: string; to: string }> = [
    { from: toolchainDir, to: "toolchain" },
  ];
  if (staged.installing) {
    overlayExtraResources.push({
      from: installingHtmlOut,
      to: "installing.html",
    });
  }
  if (staged.updating) {
    overlayExtraResources.push({
      from: updatingHtmlOut,
      to: "updating.html",
    });
  }
  // One preload, shared by both pages. Only staged when at least one
  // HTML is shipped (decided by `stageInstallingArtifacts`).
  if (staged.installing || staged.updating) {
    overlayExtraResources.push({
      from: installingPreloadOut,
      to: "installing-preload.cjs",
    });
  }
  // Sibling icon.png next to the HTML files. Both default templates
  // reference `./icon.png`; staging it as a sibling of installing.html
  // makes that path resolve in Resources/ at first launch (before any
  // source has been cloned).
  if (staged.icon) {
    overlayExtraResources.push({
      from: iconOut,
      to: "icon.png",
    });
  }

  const merged = mergeElectronBuilderConfig(userConfig, {
    appDir: bundleDir,
    output: resolvedOutput,
    bundleFiles: [
      "package.json",
      "app-config.json",
      HOST_VERSION_FILENAME,
      "launcher.mjs",
      "!node_modules",
      "!**/node_modules",
      "!**/node_modules/**",
    ],
    extraResources: overlayExtraResources,
  });
  await fsp.writeFile(mergedConfigPath, JSON.stringify(merged, null, 2) + "\n");

  console.log("  → injected into electron-builder config:");
  console.log(`      directories.app    = ${bundleDir}`);
  console.log(`      directories.output = ${resolvedOutput}`);
  console.log(
    `      files              = [launcher + app-config + bundle pkg + ${HOST_VERSION_FILENAME}]`,
  );
  console.log(
    `      extraResources    += { from: <bundle>/toolchain, to: toolchain }`,
  );
  if (staged.installing) {
    console.log(
      `      extraResources    += { from: installing.html, to: installing.html }`,
    );
  }
  if (staged.updating) {
    console.log(
      `      extraResources    += { from: updating.html, to: updating.html }`,
    );
  }
  if (staged.installing || staged.updating) {
    console.log(
      `      extraResources    += { from: installing-preload.cjs, to: installing-preload.cjs }`,
    );
  }
  if (staged.icon) {
    console.log(
      `      extraResources    += { from: icon.png, to: icon.png }`,
    );
  }
  console.log(
    `      asar               = ${
      merged.asar !== undefined ? merged.asar : "(unset)"
    }`,
  );
  console.log(`      npmRebuild         = false`);

  console.log("  → invoking electron-builder");
  const electronBuilder = resolveElectronBuilder(projectDir);
  const cliArgs = ["--config", mergedConfigPath, ...flags.passthrough];
  const env = { ...process.env };
  if (!env.GH_TOKEN && env.GITHUB_TOKEN) env.GH_TOKEN = env.GITHUB_TOKEN;

  if (electronBuilder.endsWith(".js")) {
    await spawnAsync(
      process.execPath,
      [electronBuilder, ...cliArgs],
      projectDir,
      env,
    );
  } else {
    await spawnAsync(electronBuilder, cliArgs, projectDir, env);
  }

  console.log(
    `\n  ✓ Built ${appName} ${appVersion} at ${
      path.relative(projectDir, resolvedOutput) || resolvedOutput
    }\n`,
  );
}

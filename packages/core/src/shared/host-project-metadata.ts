import fs from "node:fs";
import path from "node:path";

export interface HostProjectMetadata {
  /** Directory containing the host app's `zenbu.config.*` file. */
  projectDir: string;
  /** Absolute path to the host app's `zenbu.config.*` file. */
  configPath: string;
  /** Absolute path to the host app's `package.json`, or null when absent. */
  packageJsonPath: string | null;
  /** `package.json#name`, or null when absent. */
  packageName: string | null;
  /** `package.json#version`, or null when absent. */
  packageVersion: string | null;
}

type PackageJson = {
  name?: string;
  version?: string;
};

export function readHostProjectMetadata(
  projectDir: string,
  configPath: string,
): HostProjectMetadata {
  const packageJsonPath = path.join(projectDir, "package.json");
  let packageName: string | null = null;
  let packageVersion: string | null = null;
  let existingPackageJsonPath: string | null = null;
  try {
    const pkg = JSON.parse(
      fs.readFileSync(packageJsonPath, "utf8"),
    ) as PackageJson;
    existingPackageJsonPath = packageJsonPath;
    packageName = typeof pkg.name === "string" ? pkg.name : null;
    packageVersion = typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    // package.json is useful metadata but not required to boot a Zenbu app.
  }
  return {
    projectDir,
    configPath,
    packageJsonPath: existingPackageJsonPath,
    packageName,
    packageVersion,
  };
}

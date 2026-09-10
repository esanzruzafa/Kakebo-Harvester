import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageMetadata {
  version?: unknown;
}

export function resolveApplicationVersion(moduleUrl = import.meta.url): string {
  const moduleDirectory = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    resolve(moduleDirectory, "..", "package.json"),
    resolve(moduleDirectory, "..", "..", "package.json")
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const metadata = JSON.parse(readFileSync(candidate, "utf8")) as PackageMetadata;
    if (typeof metadata.version === "string" && metadata.version.trim()) {
      return metadata.version.trim();
    }
  }
  return process.env.npm_package_version?.trim() || "unknown";
}

export const APPLICATION_VERSION = resolveApplicationVersion();

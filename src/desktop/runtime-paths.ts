import { basename, dirname, resolve } from "node:path";

export function runtimeRootDirectory(environmentFile: string): string {
  const environmentDirectory = dirname(resolve(environmentFile));
  return basename(environmentDirectory).toLowerCase() === "private"
    ? dirname(environmentDirectory)
    : environmentDirectory;
}

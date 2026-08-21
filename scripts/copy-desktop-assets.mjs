import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  desktopAssetDirectories,
  desktopAssetFiles
} from "./desktop-assets.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const [source, destination] of desktopAssetFiles) {
  const resolvedDestination = resolve(projectRoot, destination);
  await mkdir(dirname(resolvedDestination), { recursive: true });
  await cp(resolve(projectRoot, source), resolvedDestination);
}

for (const [source, destination] of desktopAssetDirectories) {
  const resolvedDestination = resolve(projectRoot, destination);
  await rm(resolvedDestination, { recursive: true, force: true });
  await mkdir(dirname(resolvedDestination), { recursive: true });
  await cp(resolve(projectRoot, source), resolvedDestination, { recursive: true });
}

import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distributionDirectory = resolve(projectRoot, "dist");

if (dirname(distributionDirectory) !== projectRoot) {
  throw new Error("Refusing to clean a distribution directory outside the project.");
}

await rm(distributionDirectory, { recursive: true, force: true });

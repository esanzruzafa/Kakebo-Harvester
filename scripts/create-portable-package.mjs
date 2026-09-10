import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, zipSync } from "fflate";

const packageMappings = [
  ["LICENSE", "LICENSE"],
  ["docs/PORTABLE_PACKAGE.md", "README-PORTABLE.md"],
  ["docs/PORTABLE_PRIVATE.md", "private/README.md"],
  ["private/.env.production.example", "private/.env.production.example"],
  ["config/accounts.example.json", "config/accounts.example.json"],
  [
    "config/card-import-profiles.example.json",
    "config/card-import-profiles.example.json"
  ],
  ["config/categories.example.json", "config/categories.example.json"],
  [
    "config/categorization-rules.example.json",
    "config/categorization-rules.example.json"
  ],
  [
    "config/export-settings.example.json",
    "config/export-settings.example.json"
  ],
  ["config/ui-settings.example.json", "config/ui-settings.example.json"],
  ["data/production/raw/.gitkeep", "data/production/raw/.gitkeep"],
  ["data/production/exports/.gitkeep", "data/production/exports/.gitkeep"]
];

function safeVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`Invalid portable package version: ${version}`);
  }
  return version;
}

function pathBelow(root, path) {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const child = relative(resolvedRoot, resolvedPath);
  if (
    child.length === 0 ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    throw new Error("Refusing to package a file outside the project root.");
  }
  return resolvedPath;
}

function assertPublicTemplate(source, bytes) {
  if (!/\.(?:md|json|example)$/u.test(source)) return;
  const text = new TextDecoder().decode(bytes);
  if (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(text) ||
    /\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}/u.test(text) ||
    /\bAKIA[0-9A-Z]{16}\b/u.test(text)
  ) {
    throw new Error(`Refusing to package a possible secret from ${source}.`);
  }
  if (source === "private/.env.production.example") {
    for (const key of [
      "ENABLE_BANKING_APPLICATION_ID",
      "SESSION_ENCRYPTION_KEY"
    ]) {
      const assignment = new RegExp(`^${key}=(.*)$`, "mu").exec(text);
      if (!assignment || assignment[1]?.trim()) {
        throw new Error(
          `The production environment example contains a private ${key} value.`
        );
      }
    }
  }
}

async function requiredPublicFile(projectRoot, source) {
  const path = pathBelow(projectRoot, join(projectRoot, source));
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`Missing required package file: ${source}`, {
        cause: error
      });
    }
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Required package file is not a regular file: ${source}`);
  }
  const bytes = new Uint8Array(await readFile(path));
  assertPublicTemplate(source, bytes);
  return bytes;
}

export async function createPortablePackage(projectRoot, requestedVersion) {
  const version = safeVersion(requestedVersion);
  const artifactBase = `Kakebo-Harvester-${version}-x64`;
  const packageRoot = artifactBase;
  const executableSource = `release/portable/${artifactBase}.exe`;
  const mappings = [
    ...packageMappings,
    [executableSource, `${artifactBase}.exe`]
  ];
  const archiveEntries = {};
  for (const [source, target] of mappings) {
    archiveEntries[`${packageRoot}/${target}`] = await requiredPublicFile(
      projectRoot,
      source
    );
  }

  const archive = zipSync(archiveEntries, { level: 9 });
  const verified = unzipSync(archive);
  const expectedEntries = Object.keys(archiveEntries).sort();
  const actualEntries = Object.keys(verified).sort();
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error("Portable package verification found unexpected files.");
  }

  const outputDirectory = pathBelow(projectRoot, join(projectRoot, "release/portable"));
  const outputPath = pathBelow(
    projectRoot,
    join(outputDirectory, `${artifactBase}-complete-package.zip`)
  );
  const temporary = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(outputDirectory, { recursive: true });
  try {
    await writeFile(temporary, archive, { mode: 0o600 });
    await rename(temporary, outputPath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return { path: outputPath, entries: actualEntries };
}

const scriptPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (scriptPath === fileURLToPath(import.meta.url)) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  const result = await createPortablePackage(projectRoot, packageJson.version);
  console.log(`Portable complete package verified: ${result.path}`);
}

import { access, readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  desktopAssetDirectories,
  desktopAssetFiles,
  resolveDesktopAssetDestination,
  resolveDesktopAssetSource
} from "./desktop-assets.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function filesBelow(directory, root = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesBelow(path, root)));
    } else if (entry.isFile()) {
      files.push(relative(root, path).replaceAll("\\", "/"));
    }
  }
  return files.sort();
}

function assertSameFiles(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label} mismatch. Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}.`
    );
  }
}

for (const [source, destination] of desktopAssetFiles) {
  await access(resolveDesktopAssetSource(projectRoot, source));
  await access(resolveDesktopAssetDestination(projectRoot, destination));
}

for (const [source, destination] of desktopAssetDirectories) {
  const sourceFiles = await filesBelow(
    resolveDesktopAssetSource(projectRoot, source)
  );
  const destinationFiles = await filesBelow(
    resolveDesktopAssetDestination(projectRoot, destination)
  );
  assertSameFiles(destinationFiles, sourceFiles, destination);
}

const packageConfig = JSON.parse(
  await readFile(resolve(projectRoot, "package.json"), "utf8")
);
if (!packageConfig.build?.files?.includes("LICENSE")) {
  throw new Error("The packaged application must include the MIT license text.");
}
await access(resolve(projectRoot, "LICENSE"));
const packagingInputs = [
  packageConfig.main,
  packageConfig.build?.portable?.splashImage,
  ...(packageConfig.build?.extraResources ?? []).map((resource) =>
    typeof resource === "string" ? resource : resource.from
  )
].filter((path) => typeof path === "string");
for (const path of packagingInputs) {
  await access(resolve(projectRoot, path));
}
const versionModuleUrl = pathToFileURL(
  resolve(projectRoot, "dist/src/version.js")
).href;
const { APPLICATION_VERSION } = await import(versionModuleUrl);
if (APPLICATION_VERSION !== packageConfig.version) {
  throw new Error(
    `Compiled application version ${APPLICATION_VERSION} does not match package version ${packageConfig.version}.`
  );
}

const sourceDesktopAssets = (await filesBelow(resolve(projectRoot, "src/desktop")))
  .filter((filename) => !filename.endsWith(".ts"))
  .map((filename) => `src/desktop/${filename}`)
  .sort();
const registeredDesktopAssets = desktopAssetFiles
  .map(([source]) => source)
  .filter((source) => source.startsWith("src/desktop/"))
  .sort();
assertSameFiles(
  registeredDesktopAssets,
  sourceDesktopAssets,
  "Desktop runtime asset registry"
);

const manifestModuleUrl = pathToFileURL(
  resolve(projectRoot, "dist/src/storage/migration-manifest.js")
).href;
const { migrations } = await import(manifestModuleUrl);
const migrationFiles = (await filesBelow(resolve(projectRoot, "src/storage/migrations")))
  .filter((filename) => filename.endsWith(".sql"));
assertSameFiles(
  migrations.map((migration) => migration.filename).sort(),
  migrationFiles,
  "Database migration manifest"
);

console.log("Desktop build assets verified.");

import { isAbsolute, relative, resolve, sep } from "node:path";

function requireBelow(root, path, label) {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const relativePath = relative(resolvedRoot, resolvedPath);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Refusing to use a desktop asset ${label}.`);
  }
  return resolvedPath;
}

export function resolveDesktopAssetSource(projectRoot, source) {
  return requireBelow(
    projectRoot,
    resolve(projectRoot, source),
    "outside the project"
  );
}

export function resolveDesktopAssetDestination(projectRoot, destination) {
  return requireBelow(
    resolve(projectRoot, "dist"),
    resolve(projectRoot, destination),
    "outside dist"
  );
}

export const desktopAssetFiles = [
  ["src/desktop/index.html", "dist/src/desktop/index.html"],
  ["src/desktop/audit.html", "dist/src/desktop/audit.html"],
  ["src/desktop/loading.html", "dist/src/desktop/loading.html"],
  ["build/icon.svg", "dist/src/desktop/icon.svg"],
  ["src/desktop/styles.css", "dist/src/desktop/styles.css"],
  ["src/desktop/preload.cjs", "dist/src/desktop/preload.cjs"],
  ["src/desktop/audit-preload.cjs", "dist/src/desktop/audit-preload.cjs"],
  ["src/desktop/locales/en.json", "dist/src/desktop/locales/en.json"],
  ["src/desktop/locales/es.json", "dist/src/desktop/locales/es.json"]
];

export const desktopAssetDirectories = [
  ["src/storage/migrations", "dist/src/storage/migrations"]
];

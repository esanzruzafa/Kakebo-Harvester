import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const assets = [
  ["src/desktop/index.html", "dist/src/desktop/index.html"],
  ["src/desktop/audit.html", "dist/src/desktop/audit.html"],
  ["src/desktop/loading.html", "dist/src/desktop/loading.html"],
  ["src/desktop/styles.css", "dist/src/desktop/styles.css"],
  ["src/desktop/preload.cjs", "dist/src/desktop/preload.cjs"],
  ["src/desktop/audit-preload.cjs", "dist/src/desktop/audit-preload.cjs"],
  ["src/desktop/locales/en.json", "dist/src/desktop/locales/en.json"],
  ["src/desktop/locales/es.json", "dist/src/desktop/locales/es.json"],
  [
    "src/storage/migrations/001_initial.sql",
    "dist/src/storage/migrations/001_initial.sql"
  ],
  [
    "src/storage/migrations/002_desktop.sql",
    "dist/src/storage/migrations/002_desktop.sql"
  ],
  [
    "src/storage/migrations/003_audit_and_exports.sql",
    "dist/src/storage/migrations/003_audit_and_exports.sql"
  ]
];

for (const [source, destination] of assets) {
  const resolvedDestination = resolve(projectRoot, destination);
  await mkdir(dirname(resolvedDestination), { recursive: true });
  await cp(resolve(projectRoot, source), resolvedDestination);
}

const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join } = require("node:path");
const { pathToFileURL } = require("node:url");

const packagedRoot = join(dirname(process.execPath), "resources", "app.asar");
const packagedModule = join(
  packagedRoot,
  "node_modules",
  "better-sqlite3"
);
const packagedMigrations = join(
  packagedRoot,
  "dist",
  "src",
  "storage",
  "migrations"
);

async function main() {
  let database;
  let migrationDatabase;
  let temporaryRoot;
  try {
    const Database = require(packagedModule);
    database = new Database(":memory:");
    database.exec("CREATE TABLE packaged_sqlite_check (id INTEGER PRIMARY KEY)");
    database
      .prepare("INSERT INTO packaged_sqlite_check (id) VALUES (?)")
      .run(1);
    const row = database
      .prepare("SELECT COUNT(*) AS total FROM packaged_sqlite_check")
      .get();
    if (row.total !== 1) {
      throw new Error("The packaged SQLite smoke test returned an invalid result.");
    }
    console.log("Packaged SQLite ABI check passed.");

    const manifest = JSON.parse(
      readFileSync(join(packagedMigrations, "manifest.json"), "utf8")
    );
    if (!Array.isArray(manifest) || manifest.length === 0) {
      throw new Error("The packaged database migration manifest is empty.");
    }
    for (const [index, migration] of manifest.entries()) {
      if (migration.version !== index + 1 || typeof migration.filename !== "string") {
        throw new Error("The packaged database migration manifest is invalid.");
      }
    }
    temporaryRoot = mkdtempSync(join(tmpdir(), "kakebo-packaged-migrations-"));
    const { createDatabase } = await import(pathToFileURL(join(
      packagedRoot, "dist", "src", "storage", "database.js"
    )).href);
    migrationDatabase = createDatabase(join(temporaryRoot, "migration-check.sqlite"));
    const finalVersion = migrationDatabase.pragma("user_version", {
      simple: true
    });
    if (finalVersion !== manifest.at(-1).version) {
      throw new Error("The packaged database migrations were not fully applied.");
    }
    console.log(`Packaged database migrations check passed (v${finalVersion}).`);
  } finally {
    migrationDatabase?.close();
    database?.close();
    if (temporaryRoot) {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

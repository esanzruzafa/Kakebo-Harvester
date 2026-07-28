import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { DatabaseError } from "../errors.js";

export type SqliteDatabase = Database.Database;

const migrations = [
  { version: 1, filename: "001_initial.sql" },
  { version: 2, filename: "002_desktop.sql" },
  { version: 3, filename: "003_audit_and_exports.sql" },
  { version: 4, filename: "004_provider_errors.sql" },
  { version: 5, filename: "005_psu_context.sql" }
] as const;

function applyMigrations(database: SqliteDatabase): void {
  let currentVersion = database.pragma("user_version", { simple: true }) as number;
  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;
    const path = fileURLToPath(new URL(`migrations/${migration.filename}`, import.meta.url));
    const sql = readFileSync(path, "utf8");
    const migrate = database.transaction(() => {
      database.exec(sql);
      database.pragma(`user_version = ${migration.version}`);
    });
    migrate();
    currentVersion = migration.version;
  }
}

export function createDatabase(databasePath: string): SqliteDatabase {
  try {
    mkdirSync(dirname(databasePath), { recursive: true });
    const database = new Database(databasePath);
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    applyMigrations(database);
    return database;
  } catch (error) {
    throw new DatabaseError(`No se ha podido abrir o migrar SQLite en ${databasePath}.`, {
      cause: error
    });
  }
}

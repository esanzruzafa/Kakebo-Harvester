import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { DatabaseError } from "../errors.js";
import { latestDatabaseVersion, migrations } from "./migration-manifest.js";

export type SqliteDatabase = Database.Database;

function applyMigrations(database: SqliteDatabase): void {
  const observedVersion = database.pragma("user_version", { simple: true }) as number;
  if (observedVersion > latestDatabaseVersion) {
    throw new Error(
      `SQLite schema version ${observedVersion} is newer than supported version ${latestDatabaseVersion}.`
    );
  }
  if (observedVersion === latestDatabaseVersion) return;

  const migrate = database.transaction(() => {
    let currentVersion = database.pragma("user_version", { simple: true }) as number;
    if (currentVersion > latestDatabaseVersion) {
      throw new Error(
        `SQLite schema version ${currentVersion} is newer than supported version ${latestDatabaseVersion}.`
      );
    }
    for (const migration of migrations) {
      if (migration.version <= currentVersion) continue;
      const path = fileURLToPath(
        new URL(`migrations/${migration.filename}`, import.meta.url)
      );
      const sql = readFileSync(path, "utf8");
      database.exec(sql);
      database.pragma(`user_version = ${migration.version}`);
      currentVersion = migration.version;
    }
  });
  migrate.immediate();
}

export function createDatabase(databasePath: string): SqliteDatabase {
  let database: SqliteDatabase | undefined;
  try {
    mkdirSync(dirname(databasePath), { recursive: true });
    database = new Database(databasePath);
    database.pragma("busy_timeout = 30000");
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    applyMigrations(database);
    return database;
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the open or migration failure that triggered cleanup.
    }
    throw new DatabaseError(`No se ha podido abrir o migrar SQLite en ${databasePath}.`, {
      cause: error
    });
  }
}

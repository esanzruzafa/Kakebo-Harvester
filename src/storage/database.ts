import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { DatabaseError } from "../errors.js";
import { migrations } from "./migration-manifest.js";

export type SqliteDatabase = Database.Database;

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

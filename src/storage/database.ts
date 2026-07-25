import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { DatabaseError } from "../errors.js";

export type SqliteDatabase = Database.Database;

export function createDatabase(databasePath: string): SqliteDatabase {
  try {
    mkdirSync(dirname(databasePath), { recursive: true });
    const database = new Database(databasePath);
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    const migration = readFileSync(
      resolve(process.cwd(), "src/storage/migrations/001_initial.sql"),
      "utf8"
    );
    database.exec(migration);
    return database;
  } catch (error) {
    throw new DatabaseError(`No se ha podido abrir o migrar SQLite en ${databasePath}.`, {
      cause: error
    });
  }
}

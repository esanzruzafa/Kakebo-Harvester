import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  latestDatabaseVersion,
  migrations
} from "../../src/storage/migration-manifest.js";

describe("database migration manifest", () => {
  it("registers every SQL migration once and in sequence", async () => {
    const migrationFiles = (await readdir(resolve("src/storage/migrations")))
      .filter((filename) => filename.endsWith(".sql"))
      .sort();

    expect(migrations.map(({ filename }) => filename).sort()).toEqual(
      migrationFiles
    );
    expect(migrations.map(({ version }) => version)).toEqual(
      migrations.map((_, index) => index + 1)
    );
    for (const migration of migrations) {
      expect(migration.filename).toMatch(
        new RegExp(`^${String(migration.version).padStart(3, "0")}_`)
      );
    }
    expect(latestDatabaseVersion).toBe(migrations.length);
  });
});

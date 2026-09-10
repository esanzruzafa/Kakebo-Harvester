import migrationManifest from "./migrations/manifest.json" with { type: "json" };

export interface DatabaseMigration {
  version: number;
  filename: string;
}

export const migrations: readonly DatabaseMigration[] = migrationManifest;

export const latestDatabaseVersion = migrations.at(-1)?.version ?? 0;

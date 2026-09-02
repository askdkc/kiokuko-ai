import { loadMigrationSnapshot, type MigrationSnapshot } from '../../src/db/migrate.js';

export const CURRENT_MIGRATION_SNAPSHOT: MigrationSnapshot = loadMigrationSnapshot();

export const CURRENT_MIGRATION_VERSIONS = Object.freeze(
  CURRENT_MIGRATION_SNAPSHOT.migrations.map(({ version }) => version),
);

export const CURRENT_SCHEMA_VERSION = CURRENT_MIGRATION_VERSIONS.at(-1)!;

export function migrationVersionsAfter(version: number): readonly number[] {
  return CURRENT_MIGRATION_VERSIONS.filter((candidate) => candidate > version);
}

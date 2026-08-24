/**
 * Migration registry boundary. Historical SQL remains in the compatibility
 * module so upgrades never depend on a mechanical rewrite; new migrations can
 * be added as versioned modules and composed here before the next release.
 */
export type { Migration } from '../migrations.js';
export { MIGRATIONS, LATEST_VERSION } from '../migrations.js';

import { MIGRATIONS } from '../migrations.js';

export function migrationForVersion(version: number) {
  return MIGRATIONS.find((migration) => migration.version === version);
}

export function assertMigrationOrder(): void {
  const versions = MIGRATIONS.map((migration) => migration.version);
  for (let index = 0; index < versions.length; index++) {
    if (versions[index] !== index + 1) throw new Error(`migration registry gap at ${index + 1}`);
  }
}

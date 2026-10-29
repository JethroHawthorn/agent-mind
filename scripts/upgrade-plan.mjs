// Read-only coordination of existing maintenance preflight; never applies an upgrade.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { planDatabaseMigration, verifyDatabaseBackup } from '../packages/core/dist/index.js';
export async function upgradePlan(db, bundle, checksum) {
  const migration = planDatabaseMigration(db); // Existing path, authority and schema checks.
  const blockers = [];
  let backup = null;
  if (!bundle || !checksum) blockers.push('VERIFIED_PRE_UPGRADE_BACKUP_REQUIRED');
  else {
    const result = await verifyDatabaseBackup(bundle, checksum);
    if (result.schema_digest !== migration.digest || result.schema !== migration.from)
      blockers.push('BACKUP_SCHEMA_DIFFERS_FROM_SOURCE');
    backup = { sha256: result.sha256, schema: result.schema, packages: result.packages };
  }
  return {
    schema_version: 1,
    status: blockers.length ? 'BLOCKED' : 'PREFLIGHT_ONLY',
    applied: false,
    migration,
    backup,
    blockers,
    required_manual_checks: [
      'STOP_ALL_CLIENTS',
      'VERIFY_BACKUP_RECENCY_AND_SOURCE_IDENTITY',
      'RECONCILE_PENDING_DISTRIBUTION',
      'REVIEW_MANAGED_UPDATE_PLAN',
      'RETAIN_PRIOR_SOURCE_ARTIFACT',
      'CHECK_FREE_SPACE_AND_PROTECTED_AUTHORITY',
    ],
    authorization: 'NONE_READ_ONLY_NOT_AN_UPGRADE_GRANT',
    limitations: [
      'Schema match does not establish backup recency or canonical-data equality.',
      'This plan does not migrate, restore, configure providers, enable protected operation or authorize release.',
    ],
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({
      strict: true,
      allowPositionals: true,
      options: { db: { type: 'string' }, bundle: { type: 'string' }, checksum: { type: 'string' } },
    });
    if (positionals.length || !values.db || !!values.bundle !== !!values.checksum)
      throw Error('UPGRADE_ARGUMENTS');
    const result = await upgradePlan(values.db, values.bundle, values.checksum);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.blockers.length ? 2 : 0;
  } catch {
    console.error(
      'Upgrade planning refused. Use --db EXISTING_DB [--bundle VERIFIED_BACKUP --checksum SHA256]. Existing authority, private-path and integrity requirements apply. No mutation performed.',
    );
    process.exitCode = 1;
  }
}

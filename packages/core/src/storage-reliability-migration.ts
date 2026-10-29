import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { ANTIGRAVITY_MIGRATION_CHECKSUM } from './antigravity-source-migration.js';
import { AgentMindError } from './errors.js';

/** Forward-only v11. V1–v10 retain their original user_version-based history;
 * checksums do not retroactively attest which old binary applied those migrations.
 */
export const STORAGE_RELIABILITY_SQL = `
CREATE INDEX memories_scope_recent ON memories(project_id,created_at DESC,id DESC);
CREATE INDEX experiences_scope_recent ON experiences(project_id,created_at DESC,id DESC);
`;
export const STORAGE_MIGRATION_CHECKSUM = createHash('sha256')
  .update(STORAGE_RELIABILITY_SQL)
  .digest('hex');
export function migrateStorageReliability(db: Database.Database) {
  db.exec(`CREATE TABLE schema_migrations(
    version INTEGER PRIMARY KEY CHECK(version>=11),
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL CHECK(length(checksum)=64),
    applied_at TEXT NOT NULL
  );${STORAGE_RELIABILITY_SQL}`);
  db.prepare('INSERT INTO schema_migrations VALUES(11,?,?,?)').run(
    'storage-reliability-v1',
    STORAGE_MIGRATION_CHECKSUM,
    new Date().toISOString(),
  );
  db.pragma('user_version=11');
}
export function verifyMigrationLedger(db: Database.Database) {
  try {
    const rows = db
      .prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version')
      .all() as { version: number; name: string; checksum: string }[];
    if (
      rows.length !== 2 ||
      rows[0]?.version !== 11 ||
      rows[0]?.name !== 'storage-reliability-v1' ||
      rows[0]?.checksum !== STORAGE_MIGRATION_CHECKSUM ||
      rows[1]?.version !== 12 ||
      rows[1]?.name !== 'antigravity-provenance-v1' ||
      rows[1]?.checksum !== ANTIGRAVITY_MIGRATION_CHECKSUM
    )
      throw new Error('Invalid ledger');
  } catch {
    throw new AgentMindError(
      'MIGRATION_INTEGRITY',
      'Migration ledger is missing, unknown or changed. Use a matching release and verified backup; no automatic reset is available.',
    );
  }
}
/** Prepare fixed canonical projections; never infer compatibility from one table name. */
export function verifyCoreSchema(db: Database.Database) {
  for (const sql of [
    'SELECT id,canonical_path FROM projects LIMIT 0',
    'SELECT id,project_id,kind,title,content,source_agent,status,created_at FROM memories LIMIT 0',
    'SELECT id,project_id,evidence_json,provenance_json,approval_status,verification_status,fingerprint FROM experiences LIMIT 0',
    'SELECT id,project_id,active_version_id FROM skills LIMIT 0',
    'SELECT id,skill_id,project_id,files_json,content_hash FROM skill_versions LIMIT 0',
    'SELECT id,version_id,project_id FROM skill_evaluations LIMIT 0',
    'SELECT id,version_id,project_id FROM skill_reviews LIMIT 0',
    'SELECT id,project_id,version_id FROM skill_installations LIMIT 0',
    'SELECT event_id FROM skill_usage_events LIMIT 0',
    'SELECT rowid FROM memories_fts LIMIT 0',
    'SELECT rowid FROM experiences_fts LIMIT 0',
    'SELECT rowid FROM skills_fts LIMIT 0',
  ])
    db.prepare(sql).all();
  for (const [marker, index] of [
    ['retrieval_schema', 'skill_version_retrieval_fts'],
    ['hybrid_discovery_schema', 'skill_discovery_fts'],
  ]) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(marker))
      db.prepare(`SELECT rowid FROM ${index} LIMIT 0`).all();
  }
  for (const name of ['memories_scope_recent', 'experiences_scope_recent']) {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
      .get(name) as { sql: string } | undefined;
    const table = name === 'memories_scope_recent' ? 'memories' : 'experiences';
    const expected = `CREATE INDEX ${name} ON ${table}(project_id,created_at DESC,id DESC)`;
    if (row?.sql !== expected)
      throw new AgentMindError(
        'MIGRATION_INTEGRITY',
        'A required scoped ordering index is missing or changed.',
      );
  }
  verifyMigrationLedger(db);
}

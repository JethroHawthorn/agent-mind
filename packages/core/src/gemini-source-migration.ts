import type Database from 'better-sqlite3';
import { AgentMindError } from './errors.js';

/** v10 adds provenance, not lifecycle authority. Existing versions/rows remain byte-identical.
 * Called only inside migrate's immediate transaction with FK enforcement disabled.
 * Preserve rowids: external-content FTS and incremental learning cursors rely on them.
 */
export function migrateGeminiSources(db: Database.Database): void {
  if (!db.inTransaction || db.pragma('foreign_keys', { simple: true }) !== 0)
    throw new AgentMindError(
      'MIGRATION_TRANSACTION',
      'Source migration requires the trusted migration transaction.',
    );
  const tables = ['experiences', 'skill_versions', 'skill_usage_events'] as const;
  const triggers = db
    .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY rowid")
    .all() as { name: string; sql: string }[];
  const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
  // Other-table triggers reference these parents. Drop/recreate transactionally so
  // ALTER TABLE never validates an intermediate missing parent. No trigger is relaxed at commit.
  for (const trigger of triggers) db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
  for (const table of tables) {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
      .get(table) as { sql: string } | undefined;
    const column = table === 'skill_usage_events' ? 'source_cli' : 'source_agent';
    const oldCheck = new RegExp(
      `CHECK\\s*\\(\\s*${column}\\s+IN\\s*\\(\\s*'codex'\\s*,\\s*'claude'\\s*,\\s*'unknown'\\s*\\)\\s*\\)`,
      'g',
    );
    // Some recovery/older-schema fixtures retain an already widened parent.
    // Accept only our exact canonical widened check; never skip an unknown constraint.
    if (row?.sql.includes(`CHECK(${column} IN ('codex','claude','gemini','unknown'))`)) continue;
    if (!row || [...row.sql.matchAll(oldCheck)].length !== 1)
      throw new AgentMindError(
        'MIGRATION_SCHEMA_UNSUPPORTED',
        'Unexpected source schema; migration rolled back.',
      );
    const name = `${table}_gemini_v10`;
    const sql = row.sql
      .replace(
        new RegExp(`^CREATE TABLE\\s+(?:"${table}"|${table})\\s*\\(`, 'i'),
        `CREATE TABLE ${quote(name)} (`,
      )
      .replace(oldCheck, `CHECK(${column} IN ('codex','claude','gemini','unknown'))`);
    if (sql === row.sql || !sql.startsWith(`CREATE TABLE ${quote(name)} (`))
      throw new AgentMindError('MIGRATION_SCHEMA_UNSUPPORTED', 'Unexpected table schema.');
    const indexes = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL ORDER BY rowid",
      )
      .all(table) as { sql: string }[];
    const columns = (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string }[])
      .map((c) => quote(c.name))
      .join(',');
    db.exec(sql);
    db.exec(
      `INSERT INTO ${quote(name)}(rowid,${columns}) SELECT rowid,${columns} FROM ${quote(table)}`,
    );
    db.exec(`DROP TABLE ${quote(table)}; ALTER TABLE ${quote(name)} RENAME TO ${quote(table)}`);
    for (const index of indexes) db.exec(index.sql);
  }
  for (const trigger of triggers) db.exec(trigger.sql);
  db.pragma('user_version=10');
}

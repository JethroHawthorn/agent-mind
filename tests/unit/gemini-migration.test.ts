import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { migrateExperiences } from '../../packages/core/src/experience-migration.js';
import { migrateExperienceScopeIndex } from '../../packages/core/src/experience-scope-migration.js';
import {
  ExperienceService,
  MemoryService,
  migrate,
  SkillStore,
  SkillUsageService,
} from '../../packages/core/src/index.js';
import { migrateSkillDistribution } from '../../packages/core/src/skill-distribution-migration.js';
import { migrateSkills } from '../../packages/core/src/skill-migration.js';
import { migrateSkillOperator } from '../../packages/core/src/skill-operator-migration.js';
import { migrateSkillDiscovery } from '../../packages/core/src/skill-search-migration.js';
import { migrateSkillUsage } from '../../packages/core/src/skill-usage-migration.js';
import { retrievalFixture } from '../helpers/retrieval-fixture.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
/** Original v2-v9 migrations, not a relabeled v10 database. Synthetic catalog initial state only. */
function legacy() {
  const f = retrievalFixture();
  cleanup.push(f.close);
  const approved = f.add({
    name: 'legacy-boundaries',
    description: 'Inspect numeric boundaries with explicit legacy evidence.',
  });
  const db = new Database(':memory:');
  db.pragma('foreign_keys=OFF');
  cleanup.push(() => db.close());
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,canonical_path TEXT NOT NULL);
 CREATE TABLE memories(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL CHECK(kind IN ('fact','decision','preference')),title TEXT NOT NULL,content TEXT NOT NULL,source_agent TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'unverified' CHECK(status='unverified'),created_at TEXT NOT NULL);
 CREATE VIRTUAL TABLE memories_fts USING fts5(title,content,content='memories',content_rowid='rowid'); PRAGMA user_version=2;`);
  for (const migration of [
    migrateExperiences,
    migrateExperienceScopeIndex,
    migrateSkills,
    migrateSkillDiscovery,
    migrateSkillOperator,
    migrateSkillDistribution,
    migrateSkillUsage,
  ])
    migration(db);
  const triggers = db
    .prepare("SELECT sql,name FROM sqlite_master WHERE type='trigger' ORDER BY rowid")
    .all() as { sql: string; name: string }[];
  for (const t of triggers) db.exec(`DROP TRIGGER "${t.name}"`);
  for (const table of [
    'projects',
    'experiences',
    'experience_reviews',
    'skills',
    'skill_versions',
    'skill_version_states',
    'skill_version_sources',
    'skill_evaluations',
    'skill_reviews',
    'skill_promotions',
    'skill_operator_events',
  ]) {
    const rows = f.db.prepare(`SELECT rowid,* FROM ${table}`).all() as Record<string, unknown>[];
    for (const row of rows) {
      const keys = Object.keys(row);
      db.prepare(
        `INSERT INTO ${table}(${keys.map((k) => `"${k}"`).join(',')}) VALUES(${keys.map(() => '?').join(',')})`,
      ).run(...keys.map((k) => row[k]));
    }
  }
  for (const t of triggers) db.exec(t.sql);
  db.exec(
    "INSERT INTO experiences_fts(experiences_fts) VALUES('rebuild'); INSERT INTO skills_fts(skills_fts) VALUES('rebuild'); PRAGMA foreign_keys=ON;",
  );
  return { f, db, approved };
}
it('upgrades actual populated v9, preserving approved version bytes, active pointer, rowids, audit, FTS and immutability', () => {
  const { f, db, approved } = legacy();
  expect(db.pragma('user_version', { simple: true })).toBe(9);
  const before = new SkillStore(db, f.scope).getVersion(approved.version.id);
  const xp = db.prepare('SELECT rowid,* FROM experiences').all(),
    audit = db.prepare('SELECT * FROM skill_operator_events').all();
  const triggers = db
    .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name")
    .all();
  migrate(db);
  migrate(db);
  expect(db.pragma('user_version', { simple: true })).toBe(11);
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  expect(new SkillStore(db, f.scope).getVersion(approved.version.id)).toEqual(before);
  expect(new SkillStore(db, f.scope).getIdentity(approved.identity.id).active_version_id).toBe(
    approved.version.id,
  );
  expect(db.prepare('SELECT rowid,* FROM experiences').all()).toEqual(xp);
  expect(db.prepare('SELECT * FROM skill_operator_events').all()).toEqual(audit);
  expect(
    db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all(),
  ).toEqual(triggers);
  expect(
    new ExperienceService(db, f.scope).search({ query: 'SQLite' }).experiences.length,
  ).toBeGreaterThan(0);
  expect(() =>
    db
      .prepare("UPDATE skill_versions SET source_agent='gemini' WHERE id=?")
      .run(approved.version.id),
  ).toThrow('immutable');
  expect(() => db.exec('DELETE FROM skill_operator_events')).toThrow();
  const xpGemini = new ExperienceService(db, f.scope, 'gemini').record({
    problem: 'Gemini saw a numeric boundary issue',
    solution: 'Compare both boundaries independently.',
    outcome: { status: 'unknown', summary: 'Explicit fixture report, not verified success.' },
  }).experience;
  expect(xpGemini.source_agent).toBe('gemini');
  const memory = new MemoryService(db, f.scope, 'gemini').save({
    title: 'Gemini scoped memory',
    content: 'Keep the independent boundary observation unverified.',
  });
  expect(memory.source_agent).toBe('gemini');
  const usage = new SkillUsageService(db, f.scope, 'gemini');
  const report = usage.record({
    schema_version: 1,
    event_id: crypto.randomUUID(),
    version_id: approved.version.id,
    artifact_digest: approved.version.content_hash,
    event_type: 'task_unknown',
  });
  expect(report.stored).toBe(true);
});
it('unexpected legacy source schema rolls back DDL/data/trigger removal and restores foreign keys', () => {
  const { db } = legacy();
  db.exec('DROP TABLE skill_usage_events');
  const before = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all();
  expect(() => migrate(db)).toThrow('Unexpected source schema');
  expect(db.pragma('user_version', { simple: true })).toBe(9);
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all()).toEqual(before);
});
it('upgrades actual populated v10 through the checksummed v11 index migration', async () => {
  const { db, approved } = legacy();
  const { migrateGeminiSources } = await import(
    '../../packages/core/src/gemini-source-migration.js'
  );
  db.pragma('foreign_keys=OFF');
  try {
    db.transaction(() => migrateGeminiSources(db)).immediate();
  } finally {
    db.pragma('foreign_keys=ON');
  }
  expect(db.pragma('user_version', { simple: true })).toBe(10);
  const before = db.prepare('SELECT * FROM skill_versions WHERE id=?').get(approved.version.id);
  const records = db.prepare('SELECT * FROM skill_operator_events ORDER BY id').all();
  migrate(db);
  expect(db.pragma('user_version', { simple: true })).toBe(11);
  expect(db.prepare('SELECT * FROM skill_versions WHERE id=?').get(approved.version.id)).toEqual(
    before,
  );
  expect(db.prepare('SELECT * FROM skill_operator_events ORDER BY id').all()).toEqual(records);
  expect(
    db.prepare('SELECT version,length(checksum) AS size FROM schema_migrations').all(),
  ).toEqual([{ version: 11, size: 64 }]);
});

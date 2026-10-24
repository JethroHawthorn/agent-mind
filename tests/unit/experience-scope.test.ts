import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { migrateExperiences } from '../../packages/core/src/experience-migration.js';
import {
  ExperienceService,
  MemoryService,
  migrate,
  openDatabase,
  resolveProject,
} from '../../packages/core/src/index.js';
import { removeSkillSchema } from '../helpers/skill-schema.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function legacyFixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentmind-v3-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const other = join(root, 'other');
  mkdirSync(other);
  const project = resolveProject(root, root);
  const otherProject = resolveProject(other, other);
  const db = openDatabase(join(root, 'shared.db'));
  cleanup.push(() => {
    if (db.open) db.close();
  });
  const memory = new MemoryService(db, project).save({
    title: 'Legacy memory',
    content: 'SQLite memory survives scope migration',
  });
  removeSkillSchema(db);
  db.exec(
    'DROP TABLE experience_reviews; DROP TABLE experiences_fts; DROP TABLE experiences; PRAGMA user_version = 2',
  );
  // Use the actual immutable v3 migration to construct the previous schema.
  db.transaction(() => migrateExperiences(db)).immediate();
  const service = new ExperienceService(db, project, 'codex');
  const otherService = new ExperienceService(db, otherProject, 'claude');
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  db.prepare(`INSERT INTO experiences (
    id, project_id, source_agent, problem, solution, outcome_status, outcome_summary,
    evidence_json, provenance_json, fingerprint, redacted, created_at, updated_at
  ) VALUES (?, ?, 'codex', 'SQLite legacy startup', 'Retry busy writes', 'partial', 'Local fixture only',
    '[]', '{}', 'legacy-fingerprint', 0, ?, ?)`).run(id, project.id, timestamp, timestamp);
  const approved = service.review({
    id,
    decision: 'approved',
    expected_updated_at: timestamp,
    reviewer: 'human',
    reason: 'Inspected fixture evidence.',
  });
  return { db, project, otherProject, service, otherService, id, approved, memory };
}

it('upgrades actual schema v3 and preserves content, approvals, audit rows and Phase 0 data', () => {
  const { db, project, otherProject, service, otherService, id, approved, memory } =
    legacyFixture();
  const before = db.prepare('SELECT * FROM experiences').all();
  const audit = db.prepare('SELECT * FROM experience_reviews').all();
  migrate(db);
  migrate(db);
  expect(db.pragma('user_version', { simple: true })).toBe(7);
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(db.pragma('foreign_key_check')).toEqual([]);
  expect(db.prepare('SELECT * FROM experiences').all()).toEqual(before);
  expect(db.prepare('SELECT * FROM experience_reviews').all()).toEqual(audit);
  expect(service.inspect(id)).toEqual(approved);
  expect(new MemoryService(db, project).search({ query: 'SQLite' })).toEqual([memory]);
  expect(service.search({ query: 'SQLite', status: 'approved' }).experiences[0]?.id).toBe(id);
  expect(otherService.search({ query: 'SQLite' }).experiences).toEqual([]);
  expect(
    db
      .prepare('SELECT rowid FROM experiences_fts WHERE experiences_fts MATCH ?')
      .all(`project_id : "${project.id}"`),
  ).toHaveLength(1);
  expect(
    db
      .prepare('SELECT rowid FROM experiences_fts WHERE experiences_fts MATCH ?')
      .all(`project_id : "${otherProject.id}"`),
  ).toEqual([]);
  // Project-index fields must not become searchable document content.
  expect(service.search({ query: project.id }).experiences).toEqual([]);
});

it('rolls back destructive FTS rebuild steps on migration failure and can retry', () => {
  const { db, service, id } = legacyFixture();
  const original = db.exec.bind(db);
  const injected = vi.spyOn(db, 'exec').mockImplementation((sql) => {
    if (sql.includes('PRAGMA user_version = 4')) {
      original(sql.slice(0, sql.indexOf('CREATE VIRTUAL TABLE')));
      throw new Error('simulated rebuild failure');
    }
    return original(sql);
  });
  expect(() => migrate(db)).toThrow('simulated rebuild failure');
  injected.mockRestore();
  expect(db.pragma('user_version', { simple: true })).toBe(3);
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  expect(
    db.prepare("SELECT rowid FROM experiences_fts WHERE experiences_fts MATCH 'SQLite'").all(),
  ).toHaveLength(1);
  expect(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'experiences_%'")
      .all(),
  ).toHaveLength(3);
  expect(service.inspect(id).approval_status).toBe('approved');
  migrate(db);
  expect(service.search({ query: 'SQLite' }).experiences[0]?.id).toBe(id);
});

it('keeps indexed project terms synchronized on inserts, text edits, project moves and deletes', () => {
  const { db, project, otherProject, service, otherService } = legacyFixture();
  migrate(db);
  const saved = service.record({
    problem: 'Magnolia startup',
    solution: 'Retry startup safely',
    outcome: { status: 'unknown', summary: 'Not evaluated' },
  }).experience;
  expect(service.search({ query: 'Magnolia' }).experiences[0]?.id).toBe(saved.id);
  db.prepare('UPDATE experiences SET problem = ?, project_id = ? WHERE id = ?').run(
    'Dahlia startup',
    otherProject.id,
    saved.id,
  );
  expect(service.search({ query: 'Magnolia' }).experiences).toEqual([]);
  expect(service.search({ query: 'Dahlia' }).experiences).toEqual([]);
  expect(otherService.search({ query: 'Dahlia' }).experiences[0]?.id).toBe(saved.id);
  const scoped = (scope: string) =>
    db
      .prepare('SELECT rowid FROM experiences_fts WHERE experiences_fts MATCH ?')
      .all(`project_id : "${scope}" AND problem : "Dahlia"`);
  expect(scoped(project.id)).toEqual([]);
  expect(scoped(otherProject.id)).toHaveLength(1);
  db.prepare('DELETE FROM experiences WHERE id = ?').run(saved.id);
  expect(otherService.search({ query: 'Dahlia' }).experiences).toEqual([]);
  expect(scoped(otherProject.id)).toEqual([]);
});

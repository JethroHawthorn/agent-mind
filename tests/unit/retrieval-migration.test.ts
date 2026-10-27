import { afterEach, expect, it } from 'vitest';
import {
  migrateRetrieval,
  openDatabaseReadOnly,
  SkillRetrievalService,
} from '../../packages/core/src/index.js';
import { distributionFixture } from '../helpers/distribution-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
it('requires explicit index initialization but can load existing active packages read-only', () => {
  const f = distributionFixture();
  cleanup.push(f.close);
  const s = new SkillRetrievalService(f.db, f.scope);
  expect(() => s.discover({ query: 'harmless' })).toThrow(/Initialize/);
  expect(s.load({ skill_id: f.candidate.identity.id }).version_id).toBe(f.candidate.version.id);
  expect(
    f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='retrieval_schema'").get(),
  ).toBeUndefined();
  migrateRetrieval(f.db);
  expect(s.discover({ query: 'harmless' }).skills[0]?.active_version_id).toBe(
    f.candidate.version.id,
  );
});
it('rolls failed additive index migration back without altering core lifecycle data', () => {
  const f = distributionFixture();
  cleanup.push(f.close);
  const before = f.store.get({ version_id: f.candidate.version.id });
  f.db.exec('CREATE TABLE skill_version_retrieval_fts(dummy TEXT)');
  expect(() => migrateRetrieval(f.db)).toThrow();
  expect(
    f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='retrieval_schema'").get(),
  ).toBeUndefined();
  expect(f.db.pragma('user_version', { simple: true })).toBe(10);
  expect(f.store.get({ version_id: f.candidate.version.id })).toEqual(before);
  f.db.exec('DROP TABLE skill_version_retrieval_fts');
  migrateRetrieval(f.db);
  expect(
    new SkillRetrievalService(f.db, f.scope).discover({ query: 'harmless' }).skills,
  ).toHaveLength(1);
});
it('refuses to initialize through a read-only connection', () => {
  const f = distributionFixture();
  cleanup.push(f.close);
  const db = openDatabaseReadOnly(f.path);
  try {
    expect(() => migrateRetrieval(db)).toThrow();
  } finally {
    db.close();
  }
  expect(
    f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='retrieval_schema'").get(),
  ).toBeUndefined();
});

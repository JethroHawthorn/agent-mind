import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MemoryService,
  migrate,
  openDatabase,
  resolveProject,
  safeError,
} from '../../packages/core/src/index.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agentmind-unit-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const a = join(dir, 'a');
  const b = join(dir, 'b');
  mkdirSync(a);
  mkdirSync(b);
  const db = openDatabase(join(dir, 'memory.db'));
  cleanup.push(() => {
    if (db.open) db.close();
  });
  return { dir, a, b, db, service: new MemoryService(db, resolveProject(a, a), 'codex') };
}

describe('project boundary', () => {
  it('shares only explicitly configured keys across worktrees, clones and moved directories', () => {
    const { dir, a, b, db, service } = fixture();
    const key = 'agentmind-shared-project-1234';
    const keyed = new MemoryService(db, resolveProject(a, a, key));
    const clone = new MemoryService(db, resolveProject(b, b, key));
    service.save({ title: 'Legacy', content: 'Legacy path scope stays private' });
    const saved = keyed.save({ title: 'Shared', content: 'Shared keyed scope' });
    expect(clone.search({ query: 'Shared' })).toEqual([saved]);
    expect(clone.search({ query: 'Legacy' })).toEqual([]);
    expect(service.search({ query: 'Shared' })).toEqual([]);
    const moved = join(dir, 'moved');
    renameSync(b, moved);
    expect(resolveProject(moved, moved, key).id).toBe(saved.project_id);
    expect(
      new MemoryService(db, resolveProject(moved, moved, 'another-project-key')).search({
        query: 'Shared',
      }),
    ).toEqual([]);
    expect(() => resolveProject(a, moved, key)).toThrow('Launch from inside');
    expect(() => resolveProject(a, a, '')).toThrow('Project key');
    expect(() => resolveProject(a, a, 'too-short')).toThrow('Project key');
    expect(() => clone.search({ query: 'Shared', project_key: key })).toThrow('Invalid search');
  });
  it('canonicalizes symlinks and accepts children within the root', () => {
    const { dir, a } = fixture();
    const alias = join(dir, 'alias');
    symlinkSync(a, alias, 'dir');
    const child = join(a, 'src');
    mkdirSync(child);
    expect(resolveProject(alias, child)).toEqual(resolveProject(a, a));
  });
  it('rejects missing, relative and foreign roots, including prefix siblings', () => {
    const { a, b } = fixture();
    expect(() => resolveProject(a, b)).toThrow('Launch from inside');
    expect(() => resolveProject('.', a)).toThrow('existing absolute');
    expect(() => resolveProject(join(a, 'absent'), a)).toThrow('existing absolute');
    const prefixSibling = `${a}-other`;
    mkdirSync(prefixSibling);
    expect(() => resolveProject(a, prefixSibling)).toThrow('Launch from inside');
  });
});

describe('storage and search', () => {
  it('migrates idempotently without losing records and persists after reopen', () => {
    const { dir, a, db, service } = fixture();
    const saved = service.save({
      title: 'SQLite choice',
      content: 'Use SQLite WAL for persistent memory.',
      kind: 'decision',
    });
    migrate(db);
    migrate(db);
    expect(service.health().schema_version).toBe(2);
    expect(db.prepare('SELECT count(*) AS n FROM memories').get()).toEqual({ n: 1 });
    db.close();
    const reopened = openDatabase(join(dir, 'memory.db'));
    try {
      expect(
        new MemoryService(reopened, resolveProject(a, a), 'claude').search({ query: 'SQLite WAL' }),
      ).toEqual([saved]);
      expect(saved.status).toBe('unverified');
      expect(saved.source_agent).toBe('codex');
    } finally {
      reopened.close();
    }
  });
  it('rejects newer schema without modifying it', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('user_version = 999');
      expect(() => migrate(db)).toThrow('newer');
      expect(db.pragma('user_version', { simple: true })).toBe(999);
    } finally {
      db.close();
    }
  });
  it('upgrades v1 without changing memory IDs, FTS records or foreign keys', () => {
    const { db, a, service } = fixture();
    const saved = service.save({ title: 'Before upgrade', content: 'Legacy migration memory' });
    // Recreate the only structural difference in v1: unique canonical paths.
    db.exec(
      'CREATE UNIQUE INDEX projects_v1_path ON projects(canonical_path); PRAGMA user_version = 1',
    );
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(service.search({ query: 'migration' })).toEqual([saved]);
    const shared = new MemoryService(db, resolveProject(a, a, 'stable-project-key'));
    shared.save({ title: 'After upgrade', content: 'Separate keyed memory' });
    expect(service.search({ query: 'keyed' })).toEqual([]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
  it('rolls back a failed v2 upgrade without damaging v1 records', () => {
    const { db, service } = fixture();
    const saved = service.save({
      title: 'Upgrade safety',
      content: 'Memory before migration failure',
    });
    db.exec('PRAGMA user_version = 1; CREATE TABLE projects_v2 (id TEXT)');
    expect(() => migrate(db)).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(service.search({ query: 'failure' })).toEqual([saved]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
  it('rolls back failed migrations atomically', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE memories (id TEXT)');
      expect(() => migrate(db)).toThrow();
      expect(db.pragma('user_version', { simple: true })).toBe(0);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'projects'").get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });
  it('isolates projects in one database and rejects supplied scope selectors', () => {
    const { a, b, db, service } = fixture();
    const other = new MemoryService(db, resolveProject(b, b), 'claude');
    service.save({ title: 'private marker', content: 'Orchid architecture decision' });
    expect(other.search({ query: 'Orchid' })).toEqual([]);
    expect(() => other.search({ query: 'Orchid', project_id: resolveProject(a, a).id })).toThrow(
      'Invalid search',
    );
    expect(() =>
      other.save({ title: 'x', content: 'y', project_id: resolveProject(a, a).id }),
    ).toThrow('Invalid memory');
    expect(() => other.search({ query: 'Orchid', scope: 'global' })).toThrow('Invalid search');
    other.save({ title: 'Other project', content: 'Orchid is different here' });
    expect(service.search({ query: 'Orchid' })).toHaveLength(1);
  });
  it('handles punctuation, unicode, FTS operators and SQL syntax safely', () => {
    const { service } = fixture();
    service.save({ title: 'Café convention', content: 'Keep SQLite WAL enabled' });
    expect(service.search({ query: 'cafe SQLite' })).toHaveLength(1);
    expect(service.search({ query: '" * : ()' })).toEqual([]);
    expect(service.search({ query: "' OR 1=1; DROP TABLE memories; --" })).toEqual([]);
    expect(service.search({ query: 'SQLite OR missing' })).toEqual([]);
    expect(service.search({ query: 'WAL' })).toHaveLength(1);
  });
  it('bounds inputs and result counts', () => {
    const { service } = fixture();
    for (let i = 0; i < 8; i++) service.save({ title: `Decision ${i}`, content: 'SQLite memory' });
    expect(service.search({ query: 'SQLite', limit: 2 })).toHaveLength(2);
    expect(service.search({ query: 'SQLite' })).toHaveLength(5);
    for (const input of [{ query: '' }, { query: 'x', limit: 21 }, { query: 'x', limit: 1.5 }]) {
      expect(() => service.search(input)).toThrow('Invalid search');
    }
    for (const input of [
      { title: ' ', content: 'x' },
      { title: 'x', content: 'a'.repeat(4001) },
      { title: 'x', content: 'y', source_agent: 'forged' },
    ]) {
      expect(() => service.save(input)).toThrow('Invalid memory');
    }
  });
  it.each([
    'password=example-secret',
    'Authorization: Bearer example-secret',
    'sk-proj-abcdefghijklmnopqrstuvwxyz',
    '-----BEGIN RSA PRIVATE KEY-----',
    'postgres://admin:example@localhost/db',
    'user: message\nassistant: reply',
    `AIza${'a'.repeat(35)}`,
    `sk_live_${'x'.repeat(24)}`,
    `rk_live_${'x'.repeat(24)}`,
    `sk_test_${'x'.repeat(24)}`,
    `api_key=<AIza${'a'.repeat(35)}>`,
  ])('rejects sensitive or transcript-like content without persisting it: %s', (content) => {
    const { db, service } = fixture();
    expect(() => service.save({ title: 'Summary', content })).toThrow();
    expect(db.prepare('SELECT count(*) AS n FROM memories').get()).toEqual({ n: 0 });
    expect(
      db.prepare("SELECT count(*) AS n FROM memories_fts WHERE memories_fts MATCH 'example'").get(),
    ).toEqual({ n: 0 });
  });
  it.each([
    'Send Authorization: Bearer <auth_token_here>',
    'Config requires Authorization: Bearer <TOKEN_PLACEHOLDER>',
    'Use api_key=<API_KEY> and password=<PASSWORD>',
    'Prefix lines with user: ',
    'user: ',
  ])('accepts explicit documentation placeholders: %s', (content) => {
    const { service } = fixture();
    expect(service.save({ title: 'Documentation', content }).id).toBeTruthy();
  });
  it.each([
    'Authorization: Bearer <TOKEN>\npassword=actual-secret',
    'Authorization: Bearer <TOKEN> trailing password=actual-secret',
    'user: This is a transcript',
    'Authorization: Bearer not-a-placeholder',
    'Authorization: Bearer <actual-secret-value>',
    'Bearer <actual-secret-value>',
  ])(
    'keeps rejecting real credentials or transcript content alongside documentation: %s',
    (content) => {
      expect(() => fixture().service.save({ title: 'Documentation', content })).toThrow();
    },
  );
  it('redacts unexpected error details', () => {
    expect(JSON.stringify(safeError(new Error('password=super-secret')))).not.toContain(
      'super-secret',
    );
  });
});

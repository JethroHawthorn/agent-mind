import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import {
  backupDatabase,
  inspectDatabase,
  MemoryService,
  openDatabase,
  openDatabaseReadOnly,
  openUsageDatabase,
  resolveProject,
  verifyDatabaseBackup,
} from '../../packages/core/src/index.js';
import { retrievalFixture } from '../helpers/retrieval-fixture.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentmind-multiprocess-'))),
    path = join(root, 'registry.sqlite');
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, path };
}
function worker(action: string, path: string, root: string, label?: string) {
  const child = spawn(
    process.execPath,
    [resolve('tests/helpers/database-worker.mjs'), action, path, root, label ?? 'worker'],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } },
  );
  let err = '';
  child.stderr.on('data', (chunk) => {
    err += String(chunk);
  });
  const result = new Promise<{ code: number | null; signal: string | null; err: string }>(
    (done, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => done({ code, signal, err }));
    },
  );
  cleanup.push(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  return { child, result };
}
it('separate processes race migration/open and write/read without lost rows', async () => {
  const f = fixture();
  const results = await Promise.all(
    [
      worker('write', f.path, f.root, 'codex'),
      worker('write', f.path, f.root, 'claude'),
      worker('read', f.path, f.root, 'reader'),
    ].map((w) => w.result),
  );
  expect(results).toEqual(results.map(() => ({ code: 0, signal: null, err: '' })));
  const db = openDatabaseReadOnly(f.path);
  expect(db.prepare('SELECT count(*) AS n FROM memories').get()).toEqual({ n: 120 });
  db.close();
  expect(inspectDatabase(f.path, true).status).toBe('PASS');
});
it('SIGKILL rolls back an ordinary transaction including FTS postings', async () => {
  const f = fixture(),
    db = openDatabase(f.path);
  db.close();
  expect((await worker('kill-transaction', f.path, f.root).result).signal).toBe('SIGKILL');
  const reopened = openDatabase(f.path);
  expect(reopened.prepare('SELECT count(*) AS n FROM memories').get()).toEqual({ n: 0 });
  expect(
    reopened.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'sentinel'").all(),
  ).toEqual([]);
  expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok');
  reopened.close();
});
it('SIGKILL during migration DDL leaves version and schema unchanged; retry succeeds', async () => {
  const f = fixture(),
    db = new Database(f.path);
  db.close();
  expect((await worker('kill-migration', f.path, f.root).result).signal).toBe('SIGKILL');
  const before = new Database(f.path);
  expect(before.pragma('user_version', { simple: true })).toBe(0);
  expect(
    before.prepare("SELECT name FROM sqlite_master WHERE name='interrupted_migration'").get(),
  ).toBeUndefined();
  before.close();
  const after = openDatabase(f.path);
  expect(after.pragma('user_version', { simple: true })).toBe(12);
  after.close();
});
it('hook connection busy budget is bounded and never duplicates failed writes', async () => {
  const f = fixture(),
    db = openDatabase(f.path);
  db.close();
  const held = worker('lock', f.path, f.root);
  const deadline = Date.now() + 4000;
  while (!existsSync(`${f.path}.ready`) && Date.now() < deadline)
    await new Promise((done) => setTimeout(done, 20));
  expect(existsSync(`${f.path}.ready`)).toBe(true);
  const writer = openUsageDatabase(f.path),
    start = Date.now();
  expect(() => writer.prepare('INSERT INTO projects VALUES(?,?)').run('blocked', f.root)).toThrow(
    /locked/,
  );
  expect(Date.now() - start).toBeLessThan(1500);
  writer.close();
  held.child.kill('SIGKILL');
  await held.result;
  expect(inspectDatabase(f.path, true).status).toBe('PASS');
});
it('online backup during separate-process writes verifies a consistent committed snapshot', async () => {
  const f = fixture(),
    db = openDatabase(f.path),
    service = new MemoryService(db, resolveProject(f.root, f.root));
  service.save({ kind: 'fact', title: 'before backup', content: 'durable concurrency baseline' });
  const writer = worker('write', f.path, f.root, 'concurrent');
  const manifest = await backupDatabase(f.path, join(f.root, 'backup'));
  expect((await writer.result).code).toBe(0);
  expect(await verifyDatabaseBackup(join(f.root, 'backup'), manifest.sha256)).toMatchObject({
    status: 'PASS',
  });
  db.close();
});
it('killed hybrid rebuild rolls back deletes and leaves canonical packages intact', async () => {
  const f = retrievalFixture();
  cleanup.push(f.close);
  f.add({ name: 'crash-rebuild', description: 'Crash rebuild fixture' });
  const count = f.db.prepare('SELECT count(*) AS n FROM skill_version_retrieval_fts').get();
  expect(
    (await worker('kill-index', realpathSync(f.path), realpathSync(f.root)).result).signal,
  ).toBe('SIGKILL');
  expect(f.db.prepare('SELECT count(*) AS n FROM skill_version_retrieval_fts').get()).toEqual(
    count,
  );
  expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
});
it('SIGKILL during backup publication leaves an explicitly incomplete unusable bundle', async () => {
  const f = fixture(),
    db = openDatabase(f.path);
  db.close();
  const output = join(f.root, 'partial-backup');
  expect((await worker('kill-backup', f.path, f.root, output).result).signal).toBe('SIGKILL');
  expect(existsSync(join(output, 'registry.sqlite'))).toBe(true);
  expect(existsSync(join(output, 'manifest.json'))).toBe(false);
  await expect(verifyDatabaseBackup(output, '0'.repeat(64))).rejects.toThrow();
  expect(inspectDatabase(f.path, true).status).toBe('PASS');
});
it('two processes race a reconstructed v10 upgrade while a reader holds its snapshot', async () => {
  const f = fixture(),
    db = openDatabase(f.path);
  // Test-only reconstruction removes only the new additive v11 objects. Original
  // populated v9/v10 migration preservation is tested independently with original migrations.
  db.exec(
    'DROP TABLE schema_migrations; DROP INDEX memories_scope_recent; DROP INDEX experiences_scope_recent; PRAGMA user_version=10',
  );
  const reader = new Database(f.path, { readonly: true });
  reader.exec('BEGIN');
  reader.prepare('SELECT * FROM projects').all();
  try {
    const results = await Promise.all([
      worker('migrate', f.path, f.root).result,
      worker('migrate', f.path, f.root).result,
    ]);
    expect(results.every((r) => r.code === 0)).toBe(true);
    expect(reader.pragma('user_version', { simple: true })).toBe(10);
    reader.exec('COMMIT');
    expect(db.pragma('user_version', { simple: true })).toBe(12);
    expect(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({ n: 2 });
  } finally {
    reader.close();
    db.close();
  }
});

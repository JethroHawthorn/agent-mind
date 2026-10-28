import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import {
  backupDatabase,
  checkpointDatabase,
  classifySqliteError,
  inspectDatabase,
  migrate,
  migrateDatabase,
  openDatabase,
  planDatabaseBackup,
  planDatabaseMigration,
  rebuildDatabaseIndexes,
  stageDatabaseRestore,
  verifyDatabaseBackup,
} from '../../packages/core/src/index.js';
import { retrievalFixture } from '../helpers/retrieval-fixture.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentmind-db-')));
  chmodSync(root, 0o700);
  const path = join(root, 'registry.sqlite'),
    db = openDatabase(path);
  cleanups.push(() => {
    if (db.open) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  db.prepare('INSERT INTO projects VALUES(?,?)').run('project-a', root);
  const put = (id: string) =>
    db
      .prepare(
        "INSERT INTO memories VALUES(?,?,'fact',?,'SQLite unicode 日本語','codex','unverified',?)",
      )
      .run(id, 'project-a', id, new Date().toISOString());
  return { root, path, db, put, output: join(root, 'backup') };
}
it('classifies SQLite errors without including driver messages or data', () => {
  for (const code of [
    'SQLITE_BUSY',
    'SQLITE_LOCKED',
    'SQLITE_BUSY_SNAPSHOT',
    'SQLITE_FULL',
    'SQLITE_IOERR_WRITE',
    'SQLITE_READONLY',
    'SQLITE_CORRUPT',
    'SQLITE_NOTADB',
  ])
    expect(classifySqliteError({ code, message: 'secret' })).toBe(
      code === 'SQLITE_IOERR_WRITE' ? 'SQLITE_IOERR' : code,
    );
});
it('status and deep doctor are read-only; default posting and OS assurance remain NOT_VERIFIED', () => {
  const f = fixture();
  f.put('one');
  const before = f.db.prepare('SELECT * FROM memories').all();
  expect(inspectDatabase(f.path)).toMatchObject({
    status: 'WARNING',
    integrity: 'NOT_VERIFIED',
    protected_os_deployment: 'NOT_VERIFIED',
    journal_mode: 'wal',
  });
  expect(inspectDatabase(f.path, true)).toMatchObject({
    status: 'PASS',
    integrity: 'PASS',
    foreign_keys: 'PASS',
  });
  expect(f.db.prepare('SELECT * FROM memories').all()).toEqual(before);
});
it('backs up committed WAL and restores exact snapshot bytes to a new offline file', async () => {
  const f = fixture();
  f.db.pragma('wal_autocheckpoint=0');
  f.put('wal-only');
  expect(existsSync(`${f.path}-wal`)).toBe(true);
  expect(planDatabaseBackup(f.path, f.output).scope).toBe('ENTIRE_REGISTRY_ALL_PROJECTS');
  expect(existsSync(f.output)).toBe(false);
  const manifest = await backupDatabase(f.path, f.output);
  expect(await verifyDatabaseBackup(f.output, manifest.sha256)).toMatchObject({
    status: 'PASS',
    evaluation_authority: 'UNCHANGED_NOT_REVERIFIED',
  });
  const out = join(f.root, 'restored.sqlite');
  expect(await stageDatabaseRestore(f.output, out, manifest.sha256)).toMatchObject({
    applied: false,
  });
  expect(existsSync(out)).toBe(false);
  await stageDatabaseRestore(f.output, out, manifest.sha256, true);
  expect(readFileSync(out)).toEqual(readFileSync(join(f.output, 'registry.sqlite')));
  const restored = new Database(out, { readonly: true });
  expect(restored.prepare('SELECT id FROM memories').all()).toEqual([{ id: 'wal-only' }]);
  restored.close();
  await expect(stageDatabaseRestore(f.output, out, manifest.sha256, true)).rejects.toMatchObject({
    code: 'DATABASE_CONFLICT',
  });
});
it('rejects corrupt bytes, mismatched checksum, forged recovery metadata and sidecars', async () => {
  const f = fixture(),
    manifest = await backupDatabase(f.path, f.output);
  await expect(verifyDatabaseBackup(f.output, '0'.repeat(64))).rejects.toMatchObject({
    code: 'BACKUP_CHECKSUM',
  });
  const meta = join(f.output, 'manifest.json');
  writeFileSync(meta, JSON.stringify({ ...manifest, active_digest: 'forged' }));
  await expect(verifyDatabaseBackup(f.output, manifest.sha256)).rejects.toMatchObject({
    code: 'BACKUP_METADATA',
  });
  writeFileSync(meta, JSON.stringify(manifest));
  writeFileSync(join(f.output, 'registry.sqlite-wal'), 'untrusted');
  await expect(verifyDatabaseBackup(f.output, manifest.sha256)).rejects.toMatchObject({
    code: 'BACKUP_SIDECAR',
  });
  rmSync(join(f.output, 'registry.sqlite-wal'));
  writeFileSync(join(f.output, 'registry.sqlite'), 'corrupted');
  await expect(verifyDatabaseBackup(f.output, manifest.sha256)).rejects.toMatchObject({
    code: 'BACKUP_CHECKSUM',
  });
});
it('cancelled backup never publishes a bundle and cleans private staging', async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(backupDatabase(f.path, f.output, controller.signal)).rejects.toMatchObject({
    code: 'BACKUP_CANCELLED',
  });
  expect(existsSync(f.output)).toBe(false);
});
it('rejects symlinks, unowned output, existing destination and protected registry maintenance', async () => {
  const f = fixture();
  const link = join(f.root, 'link.sqlite');
  symlinkSync(f.path, link);
  expect(() => inspectDatabase(link)).toThrow();
  expect(() => planDatabaseBackup(f.path, f.path)).toThrow();
  chmodSync(f.root, 0o755);
  expect(() => planDatabaseBackup(f.path, f.output)).toThrow();
  chmodSync(f.root, 0o700);
  f.db.exec('CREATE TABLE broker_deployment(singleton INTEGER, deployment_id TEXT)');
  expect(inspectDatabase(f.path).protected_registry).toBe(true);
  expect(() => planDatabaseMigration(f.path)).toThrow();
  await expect(backupDatabase(f.path, f.output)).rejects.toMatchObject({
    code: 'PROTECTED_MAINTENANCE_UNAVAILABLE',
  });
  expect(() => rebuildDatabaseIndexes(f.path)).toThrow();
});
it('repairs missing FTS postings transactionally without changing canonical records', () => {
  const f = fixture();
  f.put('needle');
  const before = f.db.prepare('SELECT * FROM memories').all();
  f.db.exec(
    "INSERT INTO memories_fts(memories_fts,rowid,title,content) SELECT 'delete',rowid,title,content FROM memories",
  );
  expect(
    f.db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'needle'").all(),
  ).toEqual([]);
  expect(rebuildDatabaseIndexes(f.path).rebuilt).toContain('memories_fts');
  expect(
    f.db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'needle'").all(),
  ).toHaveLength(1);
  expect(f.db.prepare('SELECT * FROM memories').all()).toEqual(before);
});
it('rebuilds both hybrid indexes from immutable metadata, preserving exact active version and hash', async () => {
  const f = retrievalFixture();
  cleanups.push(f.close);
  const skill = f.add({ name: 'sqlite-recovery', description: 'SQLite recovery workflow' });
  const before = f.db.prepare('SELECT * FROM skill_versions').all();
  f.db.exec('DELETE FROM skill_discovery_fts; DELETE FROM skill_version_retrieval_fts');
  expect(rebuildDatabaseIndexes(realpathSync(f.path)).rebuilt).toHaveLength(5);
  expect(f.db.prepare('SELECT * FROM skill_versions').all()).toEqual(before);
  const manifest = await backupDatabase(realpathSync(f.path), join(realpathSync(f.root), 'backup'));
  expect(manifest.packages).toBeGreaterThan(0);
  const restore = join(realpathSync(f.root), 'restore.sqlite');
  await stageDatabaseRestore(join(realpathSync(f.root), 'backup'), restore, manifest.sha256, true);
  const restored = new Database(restore, { readonly: true });
  expect(
    restored.prepare('SELECT active_version_id FROM skills WHERE id=?').get(skill.identity.id),
  ).toEqual({ active_version_id: skill.version.id });
  restored.close();
});
it('future and unknown schemas refuse startup without resetting data', () => {
  const f = fixture();
  f.db.pragma('user_version=999');
  expect(() => openDatabase(f.path)).toThrow(/newer/);
  expect(() => planDatabaseMigration(f.path)).toThrow();
  expect(f.db.pragma('user_version', { simple: true })).toBe(999);
  const unknown = new Database(':memory:');
  unknown.exec('CREATE TABLE foreign_data(id)');
  expect(() => migrate(unknown)).toThrow(/Unversioned/);
  expect(unknown.pragma('user_version', { simple: true })).toBe(0);
  unknown.close();
});
it('rejects stale migration plans within the actual migration writer transaction', () => {
  const f = fixture(),
    plan = planDatabaseMigration(f.path);
  f.db.exec('CREATE TABLE added_after_plan(id)');
  expect(() => migrateDatabase(f.path, plan.digest)).toThrow(/changed/);
  expect(f.db.pragma('foreign_keys', { simple: true })).toBe(1);
});
it('rolls back migration preflight failures and leaves original version intact', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  expect(() =>
    migrate(db, () => {
      db.exec('CREATE TABLE partial(id)');
      throw new Error('injected');
    }),
  ).toThrow('injected');
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='partial'").get()).toBeUndefined();
  expect(db.pragma('user_version', { simple: true })).toBe(0);
  expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  migrate(db);
  expect(db.pragma('user_version', { simple: true })).toBe(11);
  db.close();
});
it('passive checkpoint exposes actual busy/log/checkpoint counters', () => {
  const f = fixture();
  f.put('checkpoint');
  expect(checkpointDatabase(f.path)).toMatchObject({
    mode: 'PASSIVE',
    result: [
      expect.objectContaining({
        busy: expect.any(Number),
        log: expect.any(Number),
        checkpointed: expect.any(Number),
      }),
    ],
  });
});
it('detects malformed SQLite without printing its contents', () => {
  const f = fixture();
  const corrupt = join(f.root, 'bad.sqlite');
  writeFileSync(corrupt, 'not sqlite secret token');
  expect(() => inspectDatabase(corrupt, true)).toThrow();
});
it('verifies the checksum independently, not only a manifest string', async () => {
  const f = fixture(),
    manifest = await backupDatabase(f.path, f.output);
  expect(
    createHash('sha256')
      .update(readFileSync(join(f.output, 'registry.sqlite')))
      .digest('hex'),
  ).toBe(manifest.sha256);
});
it('detects missing or changed migration checksums without resetting the schema', () => {
  const f = fixture();
  f.db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=11').run('0'.repeat(64));
  expect(inspectDatabase(f.path, true)).toMatchObject({ status: 'FAIL', schema_structure: 'FAIL' });
  expect(() => openDatabase(f.path)).toThrow(/ledger/);
  expect(() => planDatabaseMigration(f.path)).toThrow(/ledger/);
  expect(f.db.pragma('user_version', { simple: true })).toBe(11);
});
it('rejects symbolic-link SQLite sidecars on ordinary runtime opens', () => {
  const f = fixture();
  f.db.close();
  symlinkSync(f.path, `${f.path}-wal`);
  expect(() => openDatabase(f.path)).toThrow(/regular files/);
});
it('a stale WAL snapshot is not blindly retried as a write', () => {
  const f = fixture(),
    other = new Database(f.path, { timeout: 100 });
  try {
    other.exec('BEGIN');
    other.prepare('SELECT * FROM projects').all();
    f.put('newer-commit');
    expect(() => other.prepare('INSERT INTO projects VALUES(?,?)').run('stale', f.root)).toThrow();
    try {
      other.prepare('INSERT INTO projects VALUES(?,?)').run('stale', f.root);
    } catch (error) {
      expect(classifySqliteError(error)).toBe('SQLITE_BUSY_SNAPSHOT');
    }
    other.exec('ROLLBACK');
    expect(f.db.prepare("SELECT id FROM projects WHERE id='stale'").get()).toBeUndefined();
  } finally {
    other.close();
  }
});
it('disk-full simulation rolls back rows and derived index effects', () => {
  const f = fixture();
  f.db.pragma('wal_checkpoint(TRUNCATE)');
  const pages = Number(f.db.pragma('page_count', { simple: true }));
  f.db.pragma(`max_page_count=${pages}`);
  expect(() =>
    f.db.transaction(() => {
      for (let n = 0; n < 200; n++)
        f.db
          .prepare("INSERT INTO memories VALUES(?,?,'fact',? ,?,'codex','unverified',?)")
          .run(`full-${n}`, 'project-a', 'full', 'x'.repeat(50_000), new Date().toISOString());
    })(),
  ).toThrow();
  expect(f.db.prepare("SELECT id FROM memories WHERE id LIKE 'full-%'").all()).toEqual([]);
  expect(f.db.pragma('integrity_check', { simple: true })).toBe('ok');
});
it('rejects a missing core FTS table before rebuild without changing canonical records', () => {
  const f = fixture();
  f.put('rollback');
  f.db.exec('DROP TABLE skills_fts');
  const before = f.db.prepare('SELECT * FROM memories').all();
  expect(() => rebuildDatabaseIndexes(f.path)).toThrow();
  expect(f.db.prepare('SELECT * FROM memories').all()).toEqual(before);
  expect(
    f.db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'rollback'").all(),
  ).toHaveLength(1);
});
it('backs up an actual original v1 schema before any upgrade and preserves its version on staging', async () => {
  const f = fixture(),
    oldPath = join(f.root, 'original-v1.sqlite');
  const old = new Database(oldPath);
  old.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE);
CREATE TABLE memories(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), kind TEXT NOT NULL CHECK(kind IN ('fact','decision','preference')),title TEXT NOT NULL,content TEXT NOT NULL,source_agent TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'unverified' CHECK(status='unverified'),created_at TEXT NOT NULL);
CREATE INDEX memories_project ON memories(project_id);
CREATE VIRTUAL TABLE memories_fts USING fts5(title,content,content='memories',content_rowid='rowid',tokenize='unicode61');
CREATE TRIGGER memories_insert AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(rowid,title,content) VALUES(new.rowid,new.title,new.content); END;
CREATE TRIGGER memories_delete AFTER DELETE ON memories BEGIN INSERT INTO memories_fts(memories_fts,rowid,title,content) VALUES('delete',old.rowid,old.title,old.content); END;
CREATE TRIGGER memories_update AFTER UPDATE ON memories BEGIN INSERT INTO memories_fts(memories_fts,rowid,title,content) VALUES('delete',old.rowid,old.title,old.content); INSERT INTO memories_fts(rowid,title,content) VALUES(new.rowid,new.title,new.content); END;
PRAGMA user_version=1;`);
  old.close();
  chmodSync(oldPath, 0o600);
  const bundle = join(f.root, 'legacy-backup'),
    result = await backupDatabase(oldPath, bundle);
  expect(result.schema).toBe(1);
  expect(result.registry_identity).toBeNull();
  const output = join(f.root, 'legacy-restore.sqlite');
  await stageDatabaseRestore(bundle, output, result.sha256, true);
  const staged = new Database(output, { readonly: true });
  expect(staged.pragma('user_version', { simple: true })).toBe(1);
  staged.close();
});
it('refuses backup publication if inline immutable package bytes disagree with their digest', async () => {
  const f = retrievalFixture();
  cleanups.push(f.close);
  const skill = f.add({
    name: 'backup-integrity',
    description: 'Backup package integrity fixture',
  });
  f.db.exec('DROP TRIGGER skill_versions_immutable_update');
  f.db
    .prepare('UPDATE skill_versions SET content_hash=? WHERE id=?')
    .run('f'.repeat(64), skill.version.id);
  const output = join(realpathSync(f.root), 'invalid-backup');
  await expect(backupDatabase(realpathSync(f.path), output)).rejects.toMatchObject({
    code: 'PACKAGE_INTEGRITY',
  });
  expect(existsSync(output)).toBe(false);
});
it('preserves incomplete distribution intent bytes across backup and offline restore without completing them', async () => {
  const f = retrievalFixture();
  cleanups.push(f.close);
  const skill = f.add({
    name: 'journal-backup',
    description: 'Distribution journal preservation fixture',
  });
  f.db
    .prepare(
      "INSERT INTO skill_distribution_intents(id,project_id,skill_id,target,scope,destination,action,worker_id,status,operator_id,session_id,context_digest,created_at) VALUES(?,?,?,'codex','project',?,'INSTALL','synthetic-worker','pending','synthetic-operator','synthetic-session',?,?)",
    )
    .run(
      'synthetic-pending',
      f.scope.id,
      skill.identity.id,
      join(f.root, 'fake-destination'),
      'a'.repeat(64),
      new Date().toISOString(),
    );
  const before = f.db.prepare('SELECT * FROM skill_distribution_intents').all(),
    bundle = join(realpathSync(f.root), 'journal-backup');
  const manifest = await backupDatabase(realpathSync(f.path), bundle),
    output = join(realpathSync(f.root), 'journal-restore.sqlite');
  await stageDatabaseRestore(bundle, output, manifest.sha256, true);
  const restored = new Database(output, { readonly: true });
  expect(restored.prepare('SELECT * FROM skill_distribution_intents').all()).toEqual(before);
  expect(restored.prepare('SELECT status FROM skill_distribution_intents').get()).toEqual({
    status: 'pending',
  });
  restored.close();
});
it('preserves hybrid candidate ranking and abstention on the same fixed labeled corpus before/after scoped list indexes', async () => {
  const { seedHybridQuality, hybridLabels } = await import('../helpers/hybrid-quality-fixtures.js');
  const { qualityMetrics } = await import('../helpers/hybrid-metrics.js');
  const { STORAGE_RELIABILITY_SQL } = await import(
    '../../packages/core/src/storage-reliability-migration.js'
  );
  const f = retrievalFixture();
  cleanups.push(f.close);
  seedHybridQuality(f);
  const measure = () =>
    hybridLabels.map((q) => {
      const start = performance.now(),
        r = f.retrieval.selectionCards({ context: q.context, limit: 10 });
      return {
        ...q,
        names: r.skills.map((s) => s.name),
        outcome: r.outcome,
        bytes: Buffer.byteLength(JSON.stringify(r)),
        latency_ms: performance.now() - start,
        identities: r.skills.map((s) => ({
          skill_id: s.skill_id,
          version: s.active_version_id,
          digest: s.content_digest,
        })),
      };
    });
  f.db.exec('DROP INDEX memories_scope_recent; DROP INDEX experiences_scope_recent');
  const before = measure();
  f.db.exec(STORAGE_RELIABILITY_SQL);
  const after = measure();
  expect(after.map(({ names, outcome, identities }) => ({ names, outcome, identities }))).toEqual(
    before.map(({ names, outcome, identities }) => ({ names, outcome, identities })),
  );
  writeFileSync(
    join(tmpdir(), 'agentmind-p5004-ranking.json'),
    JSON.stringify(
      {
        method:
          'Same approved fixtures and hybrid algorithm; only scoped chronological indexes absent/present. Deterministic candidate retrieval, no real model selection.',
        before: qualityMetrics(before),
        after: qualityMetrics(after),
      },
      null,
      2,
    ),
  );
});

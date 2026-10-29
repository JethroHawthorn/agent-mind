import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import {
  backupDatabase,
  migrateDatabase,
  planDatabaseMigration,
  stageDatabaseRestore,
  verifyDatabaseBackup,
} from '../../packages/core/src/index.js';
import { checkDocs } from '../../scripts/docs-check.mjs';
import { buildRelease, releasePlan, sourceArchive } from '../../scripts/release.mjs';
import { upgradePlan } from '../../scripts/upgrade-plan.mjs';
import { installerFixture } from '../helpers/installer-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
function temp() {
  const p = realpathSync(mkdtempSync(join(tmpdir(), 'agentmind-rc-')));
  chmodSync(p, 0o700);
  cleanup.push(() => rmSync(p, { recursive: true, force: true }));
  return p;
}
function snapshot(root: string): string[] {
  const out: string[] = [];
  function walk(p: string) {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const f = join(p, e.name);
      if (e.isDirectory()) walk(f);
      else
        out.push(
          `${f.slice(root.length)}:${createHash('sha256').update(readFileSync(f)).digest('hex')}`,
        );
    }
  }
  walk(root);
  return out.sort();
}
it('checks curated docs links, JSON, shell syntax and profile caveats without executing prose', () => {
  expect(checkDocs()).toMatchObject({ status: 'PASS', errors: [] });
});
it('plans without writing; builds identical normalized source archives and refuses overwriting', () => {
  const before = releasePlan(),
    root = temp();
  expect(before).toMatchObject({
    artifact_type: 'SOURCE_WORKSPACE_RC',
    release_approved: false,
    dependencies_bundled: false,
    license: 'NO_LICENSE_GRANT_PRESENT',
  });
  expect(
    before.files.every(
      (f: { path: string }) =>
        !/(node_modules|\/dist\/|\.env|\.sqlite|\.db|native\/bin)/.test(f.path),
    ),
  ).toBe(true);
  const first = buildRelease(join(root, 'first.tgz')),
    second = buildRelease(join(root, 'second.tgz'));
  expect(first.sha256).toBe(second.sha256);
  expect(readFileSync(join(root, 'first.tgz'))).toEqual(readFileSync(join(root, 'second.tgz')));
  expect(() => buildRelease(join(root, 'first.tgz'))).toThrow();
  const link = join(root, 'linked');
  symlinkSync(root, link);
  expect(() => buildRelease(join(link, 'alias.tgz'))).toThrow();
  expect(releasePlan().source_identity).toBe(before.source_identity);
});
it.each([
  ['codex'],
  ['claude'],
  ['gemini'],
  ['codex', 'claude'],
  ['codex', 'gemini'],
  ['claude', 'gemini'],
  ['codex', 'claude', 'gemini'],
] as const)(
  'installs provider subset %j, updates idempotently, removes and reinstalls without knowledge loss',
  (...ids) => {
    const f = installerFixture();
    cleanup.push(f.cleanup);
    writeFileSync(f.options.database, 'PERSISTENT_KNOWLEDGE_SENTINEL');
    const original = snapshot(f.root);
    const plans = f.service.plan('setup', ids);
    expect(snapshot(f.root)).toEqual(original);
    f.service.apply(plans);
    expect(f.service.plan('setup', ids).every((p) => p.disposition === 'SKIP')).toBe(true);
    expect(f.service.plan('update', ids).every((p) => p.disposition === 'SKIP')).toBe(true);
    f.service.apply(f.service.plan('uninstall', ids));
    expect(readFileSync(f.options.database, 'utf8')).toBe('PERSISTENT_KNOWLEDGE_SENTINEL');
    f.service.apply(f.service.plan('setup', ids));
    expect(f.service.status(ids).integrations.every((i) => i.state === 'CONFIGURED')).toBe(true);
  },
  30000,
);
it('backs up real original v1, restores offline before migration, rejects stale plans and preserves memory/FTS', async () => {
  const root = temp(),
    path = join(root, 'historical.sqlite');
  const db = new Database(path);
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,canonical_path TEXT NOT NULL UNIQUE);
 CREATE TABLE memories(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL CHECK(kind IN ('fact','decision','preference')),title TEXT NOT NULL,content TEXT NOT NULL,source_agent TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'unverified' CHECK(status='unverified'),created_at TEXT NOT NULL);
 CREATE VIRTUAL TABLE memories_fts USING fts5(title,content,content='memories',content_rowid='rowid');
 CREATE TRIGGER memories_insert AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(rowid,title,content) VALUES(new.rowid,new.title,new.content);END;
 CREATE TRIGGER memories_delete AFTER DELETE ON memories BEGIN INSERT INTO memories_fts(memories_fts,rowid,title,content) VALUES('delete',old.rowid,old.title,old.content);END;
 PRAGMA user_version=1;`);
  db.prepare('INSERT INTO projects VALUES (?,?)').run('original-project', root);
  db.exec(
    "INSERT INTO memories VALUES('original-id','original-project','fact','Original','preserved knowledge','codex','unverified','2026-01-01T00:00:00Z')",
  );
  db.close();
  chmodSync(path, 0o600);
  const plan = planDatabaseMigration(path),
    backup = await backupDatabase(path, join(root, 'backup'));
  await expect(verifyDatabaseBackup(join(root, 'backup'), backup.sha256)).resolves.toMatchObject({
    status: 'PASS',
  });
  expect(await upgradePlan(path)).toMatchObject({ status: 'BLOCKED', applied: false });
  expect(await upgradePlan(path, join(root, 'backup'), backup.sha256)).toMatchObject({
    status: 'PREFLIGHT_ONLY',
    applied: false,
  });
  const restored = join(root, 'offline.sqlite');
  await stageDatabaseRestore(join(root, 'backup'), restored, backup.sha256, false);
  expect(existsSync(restored)).toBe(false);
  await stageDatabaseRestore(join(root, 'backup'), restored, backup.sha256, true);
  expect(() => migrateDatabase(path, '0'.repeat(64))).toThrow();
  const unchanged = new Database(path);
  expect(unchanged.pragma('user_version', { simple: true })).toBe(1);
  unchanged.close();
  migrateDatabase(path, plan.digest);
  const upgraded = new Database(path);
  expect(upgraded.pragma('user_version', { simple: true })).toBe(11);
  expect(upgraded.prepare('SELECT id,content,status FROM memories').all()).toEqual([
    { id: 'original-id', content: 'preserved knowledge', status: 'unverified' },
  ]);
  expect(
    upgraded.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'preserved'").all(),
  ).toHaveLength(1);
  upgraded.close();
  const old = new Database(restored);
  expect(old.pragma('user_version', { simple: true })).toBe(1);
  old.close();
});
it('extracts RC, builds both packages without repo dist, and executes documented offline examples', () => {
  const root = temp(),
    archive = join(root, 'rc.tgz');
  writeFileSync(archive, sourceArchive().bytes);
  const extraction = spawnSync('/usr/bin/tar', ['-xzf', archive, '-C', root], {
    encoding: 'utf8',
    timeout: 10000,
  });
  expect(extraction.status, extraction.stderr).toBe(0);
  const artifact = join(
    root,
    `agentmind-${JSON.parse(readFileSync('package.json', 'utf8')).version}`,
  );
  expect(existsSync(join(artifact, 'packages/core/dist'))).toBe(false);
  const manifest = JSON.parse(readFileSync(join(artifact, 'RELEASE-MANIFEST.json'), 'utf8'));
  for (const row of manifest.files) {
    expect(
      createHash('sha256')
        .update(readFileSync(join(artifact, row.path)))
        .digest('hex'),
    ).toBe(row.sha256);
  }
  // Deliberately reused installed dependencies: not a clean install or fresh resolution claim.
  symlinkSync(resolve('node_modules'), join(artifact, 'node_modules'));
  symlinkSync(resolve('packages/core/node_modules'), join(artifact, 'packages/core/node_modules'));
  const mcpModules = join(artifact, 'packages/mcp-server/node_modules');
  mkdirSync(join(mcpModules, '@agentmind'), { recursive: true });
  symlinkSync(join(artifact, 'packages/core'), join(mcpModules, '@agentmind/core'));
  for (const id of ['@modelcontextprotocol', 'better-sqlite3', 'zod'])
    symlinkSync(resolve('packages/mcp-server/node_modules', id), join(mcpModules, id));
  const home = join(root, 'isolated-home');
  mkdirSync(home);
  const env = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, NO_COLOR: '1' };
  for (const pkg of ['core', 'mcp-server']) {
    const r = spawnSync(
      process.execPath,
      [
        resolve('node_modules/typescript/bin/tsc'),
        '-p',
        join(artifact, `packages/${pkg}/tsconfig.json`),
      ],
      { cwd: artifact, env, encoding: 'utf8', timeout: 30000 },
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
  }
  const cli = join(artifact, 'packages/mcp-server/dist/agentmind.js'),
    project = join(root, 'project');
  mkdirSync(project);
  const db = join(root, 'registry.sqlite');
  const run = (entry: string, args: string[]) =>
    spawnSync(process.execPath, [entry, ...args], {
      cwd: project,
      env,
      encoding: 'utf8',
      timeout: 20000,
    });
  expect(run(cli, ['--help']).status).toBe(0);
  const common = ['--project-root', project, '--db', db, '--json'];
  const preview = run(cli, ['setup', '--cli', 'all', '--dry-run', ...common]);
  expect(preview.status, preview.stdout + preview.stderr).toBe(5);
  expect(() => JSON.parse(preview.stdout)).not.toThrow();
  expect(existsSync(db)).toBe(false);
  expect(existsSync(join(project, '.agentmind'))).toBe(false);
  const text = readFileSync('docs/v1/QUICK_START.md', 'utf8');
  const calls = [
    ...text.matchAll(
      /mcp-call\.mjs" "\$PROJECT" "\$DB" (codex|claude) (memory_save|memory_search) '(.*?)'/g,
    ),
  ];
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    if (!call[1] || !call[2] || !call[3]) throw Error('Invalid documented call');
    const r = run(join(artifact, 'scripts/mcp-call.mjs'), [project, db, call[1], call[2], call[3]]);
    expect(r.status, r.stderr).toBe(0);
    if (call[2] === 'memory_search') expect(r.stdout).toContain('synthetic');
  }
  const initialize = run(join(artifact, 'packages/mcp-server/dist/skill-retrieve.js'), [
    '--project-root',
    project,
    '--db',
    db,
    '--initialize',
  ]);
  expect(initialize.status, initialize.stdout + initialize.stderr).toBe(0);
  for (const args of [
    ['memory', 'list'],
    ['skills', 'search', 'sqlite retry'],
    ['learning', 'inbox'],
    ['proposals', 'list'],
  ]) {
    const r = run(cli, [...args, ...common]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  }
}, 90000);

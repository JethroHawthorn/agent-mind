import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentMindError } from '../../packages/core/dist/index.js';
import {
  initializeProtectedRegistry,
  MemoryService,
  migrateDatabase,
  openDatabase,
  planDatabaseMigration,
  SCHEMA_VERSION,
} from '../../packages/core/src/index.js';
import * as registry from '../../packages/mcp-server/src/installer/registry.js';
import { UnifiedInstaller } from '../../packages/mcp-server/src/installer/service.js';
import { completeSetup } from '../../packages/mcp-server/src/installer/setup.js';
import * as driver from '../../packages/mcp-server/src/installer/sqlite-driver.js';
import { installerFixture } from '../helpers/installer-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const clean of cleanup.splice(0).reverse()) clean();
});
function fixture() {
  const f = installerFixture();
  cleanup.push(f.cleanup);
  return f;
}
function snapshot(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .flatMap((file) => {
      const full = join(path, file.name);
      return file.isDirectory()
        ? snapshot(full)
        : [
            `${full}:${statSync(full).mode}:${statSync(full).mtimeMs}:${readFileSync(full).toString('base64')}`,
          ];
    })
    .sort();
}
function run(f: ReturnType<typeof fixture>, args: string[]) {
  return spawnSync(
    process.execPath,
    [
      resolve('packages/mcp-server/dist/agentmind.js'),
      ...args,
      '--project-root',
      f.root,
      '--db',
      f.options.database,
      '--codex',
      f.options.executables.codex,
      '--claude',
      f.options.executables.claude,
      '--gemini',
      f.options.executables.gemini,
      '--json',
    ],
    {
      cwd: f.root,
      env: { PATH: process.env.PATH, HOME: f.home },
      encoding: 'utf8',
      timeout: 30000,
    },
  );
}

it('bootstraps once, verifies all actual MCP adapters, preserves memories and avoids configuration rewrites on repeat', async () => {
  const f = fixture();
  const first = await completeSetup(f.service, ['codex', 'claude', 'gemini'], true);
  expect(first, JSON.stringify(first)).toMatchObject({
    ready: true,
    applied: true,
    exit_code: 0,
    registry: { created: true, schema: SCHEMA_VERSION, fts5: 'PASS' },
  });
  expect(first.checks.filter((check) => check.id.endsWith('mcp-health-tools'))).toHaveLength(3);
  expect(statSync(f.options.database).mode & 0o777).toBe(0o600);
  const db = openDatabase(f.options.database);
  const memory = new MemoryService(db, f.service.project);
  const saved = memory.save({
    title: 'sqlite existing decision',
    content: 'preserve actual user knowledge',
  });
  const ledger = db.prepare('SELECT * FROM schema_migrations').all();
  db.close();
  const before = snapshot(join(f.root, '.agentmind'));
  const repeated = await completeSetup(f.service, ['codex', 'claude', 'gemini'], true);
  expect(repeated, JSON.stringify(repeated)).toMatchObject({
    ready: true,
    exit_code: 0,
    registry: { created: false, migrations_applied: [] },
  });
  expect(repeated.results.every((entry) => entry.action === 'SKIP')).toBe(true);
  expect(snapshot(join(f.root, '.agentmind'))).toEqual(before);
  const reopened = openDatabase(f.options.database);
  expect(reopened.prepare('SELECT content FROM memories WHERE id=?').get(saved.id)).toEqual({
    content: 'preserve actual user knowledge',
  });
  expect(reopened.prepare('SELECT * FROM schema_migrations').all()).toEqual(ledger);
  reopened.close();
}, 45000);

it('preview uses only a header read even for a closed WAL database, with no database/sidecar/config changes', async () => {
  const f = fixture();
  openDatabase(f.options.database).close();
  const before = snapshot(f.root);
  const result = await completeSetup(f.service, ['claude'], false);
  expect(result).toMatchObject({
    dry_run: true,
    applied: false,
    ready: false,
    exit_code: 0,
    registry: { header_only: true },
  });
  expect(result.checks.some((check) => check.id === 'fts' && check.status === 'NOT_VERIFIED')).toBe(
    true,
  );
  expect(snapshot(f.root)).toEqual(before);
});

it.each([
  ['SQLITE_DRIVER_MISSING', 5],
  ['SQLITE_BINDING_MISSING', 5],
  ['SQLITE_NATIVE_INCOMPATIBLE', 5],
  ['SQLITE_PLATFORM_UNSUPPORTED', 5],
  ['SQLITE_DRIVER_PERMISSION', 6],
  ['SQLITE_FTS5_UNAVAILABLE', 5],
] as const)('refuses %s before any persistent change', async (code, exit) => {
  const f = fixture(),
    before = snapshot(f.root);
  vi.spyOn(driver, 'verifySqliteDriver').mockResolvedValue({ status: 'FAIL', code });
  const result = await completeSetup(f.service, ['claude'], true);
  expect(result).toMatchObject({ applied: false, ready: false, exit_code: exit });
  expect(snapshot(f.root)).toEqual(before);
});

it('rejects an unwritable database directory without changing its permissions', async () => {
  const f = fixture(),
    parent = join(f.root, 'blocked');
  mkdirSync(parent, { mode: 0o500 });
  const service = new UnifiedInstaller({ ...f.options, database: join(parent, 'registry.db') });
  const result = await completeSetup(service, ['claude'], true);
  expect(result).toMatchObject({ exit_code: 6, ready: false });
  expect(statSync(parent).mode & 0o777).toBe(0o500);
  expect(existsSync(join(f.root, '.mcp.json'))).toBe(false);
});

it('creates only the needed private directories for a new default registry', async () => {
  const f = fixture();
  const service = new UnifiedInstaller({ ...f.options, database: undefined });
  const result = await completeSetup(service, ['claude'], true);
  expect(result, JSON.stringify(result)).toMatchObject({
    ready: true,
    registry: { path: join(f.home, '.agentmind/agentmind.db'), created: true },
  });
  expect(statSync(join(f.home, '.agentmind')).mode & 0o777).toBe(0o700);
});

it('refuses corruption and preserves the original file', async () => {
  const f = fixture();
  writeFileSync(f.options.database, 'CORRUPT_USER_DATA', { mode: 0o600 });
  const result = await completeSetup(f.service, ['claude'], true);
  expect(result).toMatchObject({ ready: false, exit_code: 7 });
  expect(readFileSync(f.options.database, 'utf8')).toBe('CORRUPT_USER_DATA');
  expect(existsSync(join(f.root, '.mcp.json'))).toBe(false);
});

it('refuses a locked database without treating it as a missing registry', async () => {
  const f = fixture(),
    db = openDatabase(f.options.database);
  try {
    db.pragma('journal_mode=DELETE');
    db.exec('BEGIN EXCLUSIVE');
    const result = await completeSetup(f.service, ['claude'], true);
    expect(result).toMatchObject({ ready: false, exit_code: 3 });
    expect(existsSync(join(f.root, '.mcp.json'))).toBe(false);
  } finally {
    db.exec('ROLLBACK');
    db.close();
  }
});

it.each(['empty', 'historical'])(
  'requires owner digest for an existing %s registry; no automatic migration',
  async (kind) => {
    const f = fixture(),
      db = new Database(f.options.database);
    if (kind === 'historical') db.pragma('user_version=1');
    db.close();
    chmodSync(f.options.database, 0o600);
    const before = readFileSync(f.options.database);
    const result = await completeSetup(f.service, ['claude'], true);
    expect(result).toMatchObject({ exit_code: 3, ready: false });
    expect(
      result.checks.some((check) => check.message === 'INSTALLER_MIGRATION_OWNER_REQUIRED'),
    ).toBe(true);
    expect(readFileSync(f.options.database)).toEqual(before);
    expect(existsSync(join(f.root, '.mcp.json'))).toBe(false);
  },
);

it('stops before configuration on a bootstrap/migration failure and retains recoverable files', async () => {
  const f = fixture();
  vi.spyOn(registry, 'prepareRegistry').mockImplementation((path, stage) => {
    stage('schema');
    writeFileSync(path, 'RECOVERY_EVIDENCE', { mode: 0o600 });
    throw new AgentMindError('MIGRATION_INTEGRITY', 'secret driver message');
  });
  const result = await completeSetup(f.service, ['claude'], true);
  expect(result).toMatchObject({ ready: false, exit_code: 7 });
  expect(JSON.stringify(result)).not.toContain('secret driver message');
  expect(readFileSync(f.options.database, 'utf8')).toBe('RECOVERY_EVIDENCE');
  expect(existsSync(join(f.root, '.mcp.json'))).toBe(false);
});

it('preserves the receipt binding and rejects explicit conflicting databases for installed providers', async () => {
  const f = fixture();
  f.service.apply(f.service.plan('setup', ['claude']));
  expect(new UnifiedInstaller({ ...f.options, database: undefined }).context.database).toBe(
    f.options.database,
  );
  expect(
    () => new UnifiedInstaller({ ...f.options, database: join(f.root, 'other.db') }),
  ).toThrow();
  expect(existsSync(join(f.root, 'other.db'))).toBe(false);
});

it('refuses protected broker registries before config mutation', async () => {
  const f = fixture(),
    db = openDatabase(f.options.database);
  initializeProtectedRegistry(db, 'ba688c5f-38ab-4dfc-a035-3297e130077e');
  db.close();
  const before = readFileSync(f.options.database);
  const result = await completeSetup(f.service, ['claude'], true);
  expect(result).toMatchObject({ ready: false, exit_code: 3 });
  expect(readFileSync(f.options.database)).toEqual(before);
  expect(existsSync(join(f.root, '.mcp.json'))).toBe(false);
});

it('rejects a missing FTS index rather than rebuilding or falsely reporting readiness', async () => {
  const f = fixture(),
    db = openDatabase(f.options.database);
  db.exec('DROP TABLE memories_fts');
  db.close();
  const result = await completeSetup(f.service, ['claude'], true);
  expect(result).toMatchObject({ ready: false, exit_code: 7 });
  expect(existsSync(join(f.root, '.mcp.json'))).toBe(false);
});

it('detects damaged FTS postings without repairing them or modifying user records', async () => {
  const f = fixture(),
    db = openDatabase(f.options.database);
  const memory = new MemoryService(db, f.service.project);
  const saved = memory.save({ title: 'sqlite', content: 'preserved text' });
  db.exec("INSERT INTO memories_fts(memories_fts) VALUES('delete-all')");
  db.close();
  const result = await completeSetup(f.service, ['claude'], true);
  expect(result).toMatchObject({ ready: false, exit_code: 7 });
  const read = new Database(f.options.database, { readonly: true });
  expect(read.prepare('SELECT id FROM memories WHERE id=?').get(saved.id)).toEqual({
    id: saved.id,
  });
  read.close();
  expect(existsSync(join(f.root, '.mcp.json'))).toBe(false);
});

it.each(['codex', 'claude', 'gemini'] as const)(
  'reports missing %s separately while preparing installed providers',
  async (id) => {
    const f = fixture();
    unlinkSync(f.options.executables[id]);
    const result = await completeSetup(f.service, ['codex', 'claude', 'gemini'], true);
    expect(result, JSON.stringify(result)).toMatchObject({ ready: true, exit_code: 2 });
    expect(result.providers).toContainEqual({ cli: id, status: 'SKIP', reason: 'NOT_INSTALLED' });
  },
  30000,
);

it('refuses no installed providers and a missing MCP build without creating a registry', async () => {
  const f = fixture();
  const missing = new UnifiedInstaller({
    ...f.options,
    adapters: { ...f.options.adapters, claude: join(f.root, 'missing.js') },
  });
  expect(await completeSetup(missing, ['claude'], true)).toMatchObject({
    ready: false,
    exit_code: 5,
  });
  expect(existsSync(f.options.database)).toBe(false);
  writeFileSync(
    f.options.executables.claude,
    `#!${process.execPath}\nconsole.log('not-semver');\n`,
  );
  const unsupported = new UnifiedInstaller(f.options);
  expect(await completeSetup(unsupported, ['claude'], true)).toMatchObject({
    ready: false,
    exit_code: 5,
  });
  expect(existsSync(f.options.database)).toBe(false);
  unlinkSync(f.options.executables.claude);
  expect(await completeSetup(f.service, ['claude'], true)).toMatchObject({
    ready: false,
    exit_code: 5,
  });
});

it('retains the initialized registry when provider apply fails, preserving existing compensation mechanics', async () => {
  const f = fixture();
  vi.spyOn(f.service.adapters.claude, 'apply').mockImplementation(() => {
    throw Error('provider config failure secret');
  });
  const result = await completeSetup(f.service, ['codex', 'claude'], true);
  expect(result).toMatchObject({ ready: false, exit_code: 3 });
  expect(existsSync(f.options.database)).toBe(true);
  expect(JSON.stringify(result)).not.toContain('provider config failure secret');
  expect(
    JSON.parse(readFileSync(join(f.root, '.agentmind/installer/last-run.json'), 'utf8')).phase,
  ).toBe('recovery-required');
});

it('preserves user-owned conflicting configuration and refuses unsupported Codex user scope before bootstrap', async () => {
  const f = fixture();
  writeFileSync(
    join(f.root, '.mcp.json'),
    JSON.stringify({ mcpServers: { agentmind: { command: 'USER_OWNED' } } }),
  );
  expect(await completeSetup(f.service, ['claude'], true)).toMatchObject({
    ready: false,
    exit_code: 3,
  });
  expect(existsSync(f.options.database)).toBe(false);
  const user = new UnifiedInstaller({ ...f.options, scope: 'user' });
  expect((await completeSetup(user, ['codex'], true)).ready).toBe(false);
  expect(readFileSync(join(f.root, '.mcp.json'), 'utf8')).toContain('USER_OWNED');
});

it('CLI apply returns actual readiness and ordinary doctor/status do not initialize missing registries', () => {
  const f = fixture();
  expect(run(f, ['status']).status).toBe(0);
  expect(run(f, ['doctor']).status).toBe(7);
  expect(existsSync(f.options.database)).toBe(false);
  const dry = run(f, ['setup', '--cli', 'all', '--dry-run']);
  expect(dry.status, dry.stdout + dry.stderr).toBe(0);
  expect(existsSync(f.options.database)).toBe(false);
  const apply = run(f, ['setup', '--cli', 'all', '--apply']);
  expect(apply.status, apply.stdout + apply.stderr).toBe(0);
  expect(JSON.parse(apply.stdout)).toMatchObject({
    ready: true,
    applied: true,
    registry: { created: true },
  });
  expect(run(f, ['doctor', '--connect']).status).toBe(2);
}, 45000);

it('reports actual installed MCP process startup failure, retaining database and configuration', async () => {
  const f = fixture(),
    broken = join(f.root, 'broken-adapter.js');
  writeFileSync(broken, '// loadClaudeEnrollment\nprocess.exit(1);\n');
  const service = new UnifiedInstaller({
    ...f.options,
    adapters: { ...f.options.adapters, claude: broken },
  });
  const result = await completeSetup(service, ['claude'], true);
  expect(result, JSON.stringify(result)).toMatchObject({
    applied: true,
    ready: false,
    exit_code: 7,
  });
  expect(existsSync(f.options.database)).toBe(true);
  expect(existsSync(join(f.root, '.mcp.json'))).toBe(true);
});

it('refuses an interrupted installer lock before database creation without removing recovery evidence', async () => {
  const f = fixture();
  mkdirSync(join(f.root, '.agentmind/installer'), { recursive: true, mode: 0o700 });
  writeFileSync(join(f.root, '.agentmind/installer/operation.lock'), 'PRESERVED_LOCK', {
    mode: 0o600,
  });
  expect(await completeSetup(f.service, ['claude'], true)).toMatchObject({
    ready: false,
    exit_code: 3,
  });
  expect(existsSync(f.options.database)).toBe(false);
  expect(readFileSync(join(f.root, '.agentmind/installer/operation.lock'), 'utf8')).toBe(
    'PRESERVED_LOCK',
  );
});

it('resumes safely after explicit owner migration of a real original schema, retaining historical memory and FTS', async () => {
  const f = fixture(),
    db = new Database(f.options.database);
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,canonical_path TEXT NOT NULL UNIQUE);
    CREATE TABLE memories(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL CHECK(kind IN ('fact','decision','preference')),title TEXT NOT NULL,content TEXT NOT NULL,source_agent TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'unverified' CHECK(status='unverified'),created_at TEXT NOT NULL);
    CREATE VIRTUAL TABLE memories_fts USING fts5(title,content,content='memories',content_rowid='rowid');
    CREATE TRIGGER memories_insert AFTER INSERT ON memories BEGIN INSERT INTO memories_fts(rowid,title,content) VALUES(new.rowid,new.title,new.content);END;
    CREATE TRIGGER memories_delete AFTER DELETE ON memories BEGIN INSERT INTO memories_fts(memories_fts,rowid,title,content) VALUES('delete',old.rowid,old.title,old.content);END;
    PRAGMA user_version=1;`);
  db.prepare('INSERT INTO projects VALUES (?,?)').run(f.service.project.id, f.root);
  db.prepare(
    "INSERT INTO memories VALUES('original',?,'fact','SQLite historical memory','retain this knowledge','codex','unverified','2026-01-01T00:00:00Z')",
  ).run(f.service.project.id);
  db.close();
  chmodSync(f.options.database, 0o600);
  expect(await completeSetup(f.service, ['claude'], true)).toMatchObject({
    ready: false,
    exit_code: 3,
  });
  const plan = planDatabaseMigration(f.options.database);
  migrateDatabase(f.options.database, plan.digest); // Explicit test-owner action; setup never synthesizes this approval.
  const result = await completeSetup(f.service, ['claude'], true);
  expect(result, JSON.stringify(result)).toMatchObject({
    ready: true,
    exit_code: 0,
    registry: { created: false, migrations_applied: [] },
  });
  const read = new Database(f.options.database, { readonly: true });
  expect(read.prepare("SELECT content FROM memories WHERE id='original'").get()).toEqual({
    content: 'retain this knowledge',
  });
  expect(
    read.prepare("SELECT count(*) n FROM memories_fts WHERE memories_fts MATCH 'historical'").get(),
  ).toEqual({ n: 1 });
  read.close();
});

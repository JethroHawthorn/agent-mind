import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  assertRunnerIdentity,
  inspectProtectedDeployment,
  validateRunnerPolicy,
} from '../../packages/core/src/index.js';

const policy = {
  schema_version: 1,
  runner_uid: 203,
  broker_uid: 201,
  operator_uids: [202],
  allowed_gids: [303],
  home: '/var/agentmind/home',
  workspace: '/var/agentmind/work',
  helper: '/opt/agentmind/native/bin/agentmind-peer',
  client_config: '/etc/agentmind/client.json',
  executables: {
    codex: '/opt/agentmind/bin/codex',
    claude: '/opt/agentmind/bin/claude',
    gemini: '/opt/agentmind/bin/gemini',
  },
};
const observation = {
  uid: 203,
  euid: 203,
  gid: 303,
  egid: 303,
  groups: [303],
  group_names: ['_agentmind_project'],
};
it('accepts the synthetic identity contract without claiming real OS separation', () => {
  expect(() => assertRunnerIdentity(validateRunnerPolicy(policy), observation)).not.toThrow();
});
it.each([
  { uid: 202 },
  { euid: 0 },
  { uid: 0 },
  { euid: 202 },
  { gid: 0 },
  { groups: [303, 80] },
  { group_names: ['admin'] },
  { group_names: ['wheel'] },
  { group_names: ['docker'] },
])('denies unexpected runner authority %j', (patch) => {
  expect(() =>
    assertRunnerIdentity(validateRunnerPolicy(policy), { ...observation, ...patch }),
  ).toThrow();
});
it.each([
  { runner_uid: 202 },
  { runner_uid: 201 },
  { broker_uid: 0 },
  { operator_uids: [202, 202] },
  { executables: {} },
  { home: '../operator' },
  { uid: 203 },
  { verified: true },
])('rejects invalid/forged runner policy %j', (patch) =>
  expect(() => validateRunnerPolicy({ ...policy, ...patch })).toThrow(),
);
it('read-only security diagnostic never upgrades a user-controlled fixture configuration into deployment PASS', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentmind-protected-diagnostic-'));
  try {
    const path = join(root, 'config.json');
    writeFileSync(path, JSON.stringify({ password: 'never-reflect-this', ...policy }));
    const report = inspectProtectedDeployment(path);
    expect(report.protected_deployment).toBe('NOT_VERIFIED');
    expect(report.checks.some((c) => c.status === 'FAIL')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('never-reflect-this');
    expect(readdirSync(root)).toEqual(['config.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('unified doctor supports isolated protected inspection without starting models, broker or normal installer', () => {
  const r = spawnSync(
    process.execPath,
    [
      resolve('packages/mcp-server/dist/agentmind.js'),
      'doctor',
      '--protected-config',
      '/not-installed/broker.json',
      '--json',
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  expect(r.status).toBe(7);
  const result = JSON.parse(r.stdout);
  expect(result.mode).toBe('READ_ONLY_SECURITY_DIAGNOSTIC');
  expect(result.checks.find((c: { id: string }) => c.id === 'operator.approval').status).toBe(
    'NOT_VERIFIED',
  );
  expect(result.mutations_performed).toBe(false);
});
it('runner cannot be enabled by a same-UID shell flag or environment credential', () => {
  for (const cli of ['codex', 'claude', 'gemini']) {
    const r = spawnSync(
      process.execPath,
      [
        resolve('packages/mcp-server/dist/broker-runner.js'),
        '--policy',
        '/not-installed/runner.json',
        '--cli',
        cli,
        '--check',
      ],
      {
        encoding: 'utf8',
        timeout: 3000,
        env: { PATH: process.env.PATH, APPROVED_BY: 'operator', AGENTMIND_PROTECTED: 'true' },
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('PROTECTED_RUNNER_DENIED');
    expect(r.stdout).toBe('');
  }
});
it.skipIf(process.platform !== 'darwin')(
  'native helper closes an explicitly inherited extra descriptor (single-UID primitive, not separation)',
  () => {
    if (process.platform !== 'darwin') return;
    const fd = openSync('/dev/null', 'r');
    try {
      const r = spawnSync(resolve('native/bin/agentmind-peer'), ['selftest-fds'], {
        stdio: ['ignore', 'pipe', 'pipe', fd],
        encoding: 'utf8',
        timeout: 3000,
      });
      expect(r.status).toBe(0);
    } finally {
      closeSync(fd);
    }
  },
);
it('OS harness refuses mutations without explicit administrator test authorization', () => {
  const r = spawnSync(process.execPath, [resolve('scripts/verify-broker-os.mjs')], {
    encoding: 'utf8',
    timeout: 3000,
  });
  expect(r.status).toBe(2);
  expect(JSON.parse(r.stdout).overall).toBe('NOT VERIFIED');
  expect(r.stdout).toContain('No changes performed');
});
it('protected content retrieval rejects imported legacy active approvals instead of upgrading their labels', async () => {
  const { authoringFixture } = await import('../helpers/authoring-fixture.js');
  const { BrokerService, validateBrokerConfig } = await import('../../packages/core/src/index.js');
  const f = authoringFixture(true);
  try {
    const broker = new BrokerService(
      f.db,
      validateBrokerConfig({
        schema_version: 1,
        deployment_id: 'd2cdd4dc-8dce-4006-a829-75a6029d0da7',
        broker_uid: 201,
        runtime_root: f.root,
        registry_directory: f.root,
        socket_directory: f.root,
        projects: [{ name: 'a', root: f.root, scope_id: f.scope.id, distribution_home: f.root }],
        agents: [{ uid: 203, project: 'a', source: 'codex' }],
        operators: [{ uid: 202, projects: ['a'] }],
      }),
    );
    const version = f.store.getVersion(f.base as string).version;
    expect(() =>
      broker.handle(
        'agent',
        { uid: 203, gid: 20 },
        { schema_version: 1, op: 'skill_load', input: { skill_id: version.skill_id } },
      ),
    ).toThrow(/deployment|authority/);
    // Explicit history/proposal inspection remains available as lower-trust records, not protected active retrieval.
    expect(
      broker.handle(
        'agent',
        { uid: 203, gid: 20 },
        { schema_version: 1, op: 'skill_get', input: { version_id: version.id } },
      ),
    ).toBeTruthy();
  } finally {
    f.close();
  }
});
it('rejects a legacy SQLite file before write-capable protected admission or checkpoint adoption', async () => {
  const { openDatabase, openDatabaseReadOnly, verifyProtectedRegistry } = await import(
    '../../packages/core/src/index.js'
  );
  const root = mkdtempSync(join(tmpdir(), 'agentmind-origin-'));
  try {
    const file = join(root, 'legacy.db');
    const db = openDatabase(file);
    db.close();
    const ro = openDatabaseReadOnly(file);
    try {
      expect(() => verifyProtectedRegistry(ro, 'df758260-5095-481e-ab6b-e296401e9759')).toThrow(
        /origin|unsupported/,
      );
      expect(
        ro.prepare("SELECT 1 FROM sqlite_master WHERE name='broker_deployment'").get(),
      ).toBeUndefined();
    } finally {
      ro.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('binds a fresh private registry checkpoint, rejects a changed deployment and protects history', async () => {
  const { openDatabase, verifyProtectedRegistry, initializeProtectedRegistry } = await import(
    '../../packages/core/src/index.js'
  );
  const db = openDatabase(':memory:');
  try {
    const id = 'df758260-5095-481e-ab6b-e296401e9759';
    initializeProtectedRegistry(db, id);
    expect(() => verifyProtectedRegistry(db, id)).not.toThrow();
    expect(() => verifyProtectedRegistry(db, '7b3d41f2-b8ed-456a-9462-0f2b4d2806d4')).toThrow();
    expect(() => initializeProtectedRegistry(db, id)).toThrow();
    expect(() => db.exec("UPDATE broker_deployment SET deployment_id='forged'")).toThrow(
      'immutable',
    );
    expect(() => db.exec('DELETE FROM broker_deployment')).toThrow('immutable');
  } finally {
    db.close();
  }
});

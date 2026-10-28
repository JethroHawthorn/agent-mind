import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openDatabase } from '../../packages/core/src/index.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentmind-db-cli-'))),
    path = join(root, 'db.sqlite');
  const db = openDatabase(path);
  db.close();
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, path };
}
function cli(...args: string[]) {
  const r = spawnSync(
    process.execPath,
    [resolve('packages/mcp-server/dist/agentmind.js'), 'db', ...args],
    { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, NO_COLOR: '1' } },
  );
  return { ...r, value: r.stdout ? JSON.parse(r.stdout) : null };
}
it('help requires no configuration, models or database', () => {
  const r = spawnSync(
    process.execPath,
    [resolve('packages/mcp-server/dist/agentmind.js'), 'db', '--help'],
    { encoding: 'utf8' },
  );
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('never replaces a live registry');
});
it('status has stable JSON, explicit incomplete assurance and does not migrate', () => {
  const f = fixture(),
    r = cli('status', '--db', f.path, '--json');
  expect(r.status).toBe(2);
  expect(r.value).toMatchObject({
    schema_version: 1,
    status: 'WARNING',
    integrity: 'NOT_VERIFIED',
  });
  expect(r.stderr).toBe('');
});
it('dry-run backup creates no output, mutation needs explicit owner-wide acknowledgement', () => {
  const f = fixture(),
    output = join(f.root, 'backup');
  expect(cli('backup', '--db', f.path, '--output', output, '--dry-run', '--json').status).toBe(0);
  expect(existsSync(output)).toBe(false);
  expect(cli('backup', '--db', f.path, '--output', output, '--apply', '--json').status).toBe(4);
  expect(existsSync(output)).toBe(false);
});
it('backup, verification and staged restore work through actual CLI entry point', () => {
  const f = fixture(),
    bundle = join(f.root, 'backup'),
    output = join(f.root, 'restore.sqlite');
  const b = cli(
    'backup',
    '--db',
    f.path,
    '--output',
    bundle,
    '--apply',
    '--whole-registry',
    '--json',
  );
  expect(b.status).toBe(0);
  const hash = b.value.sha256;
  expect(cli('verify-backup', '--bundle', bundle, '--checksum', hash, '--json').status).toBe(0);
  expect(
    cli(
      'restore',
      '--bundle',
      bundle,
      '--checksum',
      hash,
      '--output',
      output,
      '--dry-run',
      '--json',
    ).value.applied,
  ).toBe(false);
  expect(existsSync(output)).toBe(false);
  expect(
    cli(
      'restore',
      '--bundle',
      bundle,
      '--checksum',
      hash,
      '--output',
      output,
      '--apply',
      '--whole-registry',
      '--json',
    ).status,
  ).toBe(0);
});
it('rejects unknown/action-incompatible flags, SQL and forged scope metadata', () => {
  const f = fixture();
  for (const args of [
    ['status', '--apply'],
    ['status', '--sql', 'DROP TABLE memories'],
    ['status', '--project-id', 'forged'],
    ['backup', '--deep'],
    ['status', 'extra'],
  ]) {
    const r = cli(...args, '--db', f.path, '--json');
    expect(r.status).toBe(4);
    expect(r.value.error).toBeDefined();
  }
});

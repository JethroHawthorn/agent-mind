import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentmind-skill-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const install = (root: string, client: string) =>
  spawnSync(
    process.execPath,
    [resolve('scripts/install-reflect.mjs'), '--project-root', root, '--client', client],
    { encoding: 'utf8' },
  );
it.each(['codex', 'claude'])(
  'installs explicit reflection for %s without changing existing configuration',
  (client) => {
    const root = fixture();
    const cliDir = join(root, client === 'codex' ? '.agents' : '.claude');
    mkdirSync(cliDir);
    writeFileSync(join(cliDir, 'settings.json'), '{"existing":true}\n');
    const result = install(root, client);
    expect(result.status, result.stderr).toBe(0);
    const skill = readFileSync(join(cliDir, 'skills', 'reflect', 'SKILL.md'), 'utf8');
    expect(skill).toContain('name: reflect');
    expect(readFileSync(join(cliDir, 'settings.json'), 'utf8')).toBe('{"existing":true}\n');
    if (client === 'claude') expect(skill).toContain('disable-model-invocation: true');
    else
      expect(
        readFileSync(join(cliDir, 'skills', 'reflect', 'agents', 'openai.yaml'), 'utf8'),
      ).toContain('allow_implicit_invocation: false');
    expect(install(root, client).status).toBe(1);
    expect(readFileSync(join(cliDir, 'skills', 'reflect', 'SKILL.md'), 'utf8')).toBe(skill);
  },
);
it('refuses a skill parent symlink pointing outside the project', () => {
  const root = fixture();
  const outside = fixture();
  symlinkSync(outside, join(root, '.agents'), 'dir');
  const result = install(root, 'codex');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('outside the project');
});

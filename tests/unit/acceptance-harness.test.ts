import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  acceptanceGates,
  classifySuite,
  releaseProfiles,
  SCENARIOS,
} from '../../scripts/acceptance/model.mjs';
import { operatorTTY } from '../helpers/operator-pty.js';
import { writeReviewArtifact } from '../helpers/review-artifact.js';

const clean: (() => void)[] = [];
afterEach(() => {
  for (const f of clean.splice(0).reverse()) f();
});
function report(status = 'passed') {
  return {
    testResults: [
      { name: '/repository/tests/case.test.ts', status: 'passed', assertionResults: [{ status }] },
    ],
  };
}
it('test-only PTY recognizes CRLF prompts after terminal newline translation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentmind-pty-newline-'));
  clean.push(() => rmSync(root, { recursive: true, force: true }));
  const program = join(root, 'synthetic-prompt.mjs');
  const challenge = `CONFIRM ${'a'.repeat(64)} ${'b'.repeat(32)}`;
  // A fixed echo program, not an approval service or evidence of operator identity.
  writeFileSync(
    program,
    `import { writeSync } from 'node:fs';
const challenge = ${JSON.stringify(challenge)};
process.stdin.once('data', input => {
  process.exitCode = input.toString().trim() === challenge ? 0 : 2;
  process.stdin.pause();
});
writeSync(1, '\\r\\n' + challenge + '\\r\\n> ');
`,
  );
  const p = operatorTTY(root, [], program);
  const ready = await p.ready;
  expect(ready.event).toBe('ready');
  expect(ready.output).toContain(`${challenge}\r\r\n> `);
  p.respond();
  expect((await p.exit).status).toBe(0);
}, 20000);
it('repository defaults disable pnpm implicit installs even with a fresh HOME', () => {
  const home = mkdtempSync(join(tmpdir(), 'agentmind-pnpm-readonly-'));
  clean.push(() => rmSync(home, { recursive: true, force: true }));
  const result = spawnSync('pnpm', ['config', 'get', 'verify-deps-before-run'], {
    cwd: resolve('.'),
    env: { PATH: process.env.PATH, HOME: home, CI: '1' },
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('false');
});
it('requires observed success, matching suites and nonempty passed assertions, never stdout PASS', () => {
  expect(classifySuite(report(), 0, ['tests/case.test.ts']).status).toBe('PASS');
  expect(classifySuite(report(), 1, ['tests/case.test.ts']).status).toBe('FAIL');
  expect(classifySuite(report(), null, ['tests/case.test.ts']).status).toBe('FAIL');
  expect(classifySuite(report('pending'), 0, ['tests/case.test.ts']).status).toBe('NOT VERIFIED');
  expect(classifySuite(report(), 0, ['tests/missing.test.ts']).status).toBe('FAIL');
  expect(classifySuite({ stdout: 'PASS', native: true }, 0, ['tests/case.test.ts']).status).toBe(
    'FAIL',
  );
});
it('fixture/native claims cannot promote protected or full release profiles', () => {
  const fake = SCENARIOS.map((s) => ({
    ...s,
    status: 'PASS',
    native_model: true,
    os_verified: true,
  }));
  const gates = acceptanceGates(fake);
  expect(gates.A.status).toBe('PASS');
  expect(acceptanceGates(fake.filter((s) => s.id !== 'P6-B-MEMORY')).A.status).toBe('NOT VERIFIED');
  for (const id of ['B', 'C', 'D', 'E'] as const) expect(gates[id].status).toBe('NOT VERIFIED');
  expect(gates.J.status).toBe('FAIL');
  expect(releaseProfiles(gates).full_protected_v1.status).toBe('NOT VERIFIED');
});
it('native/model flags and live-output targets are rejected before execution', () => {
  for (const args of [
    ['--native', 'codex'],
    ['--allow-model'],
    ['--repeat', '0'],
    ['--output', resolve('agentmind-p6-001-unrelated')],
  ]) {
    const run = spawnSync(process.execPath, [resolve('scripts/acceptance.mjs'), ...args], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(run.status).toBe(4);
  }
  expect(existsSync(resolve('agentmind-p6-001-unrelated'))).toBe(false);
});
it('routine benchmark artifact writes never replace historical review evidence', () => {
  const path = resolve('docs/reviews/P5-002_PERFORMANCE.json'),
    before = existsSync(path) ? readFileSync(path) : null;
  // Runner exports explicit artifact variables; temporarily clear only test artifact controls.
  const enabled = process.env.AGENTMIND_WRITE_REVIEW_ARTIFACTS;
  delete process.env.AGENTMIND_WRITE_REVIEW_ARTIFACTS;
  try {
    writeReviewArtifact('P5-002_PERFORMANCE.json', { synthetic: 'routine-no-publish' });
  } finally {
    if (enabled !== undefined) process.env.AGENTMIND_WRITE_REVIEW_ARTIFACTS = enabled;
  }
  expect(existsSync(path) ? readFileSync(path) : null).toEqual(before);
  expect(() => writeReviewArtifact('../user-owned.json', {})).toThrow();
});
it('SIGTERM leaves inspectable incomplete evidence and cleans only its disposable workspace', async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'agentmind-acceptance-cancel-')));
  clean.push(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'agentmind-p6-001-cancel');
  const child = spawn(
    process.execPath,
    [resolve('scripts/acceptance.mjs'), '--output', root, '--repeat', '1'],
    { env: { PATH: '', HOME: parent, TMPDIR: tmpdir() }, stdio: 'ignore' },
  );
  clean.push(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  const done = once(child, 'exit');
  const deadline = Date.now() + 6000;
  while (!existsSync(join(root, 'progress.json')) && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 20));
  expect(existsSync(join(root, 'progress.json'))).toBe(true);
  child.kill('SIGTERM');
  await done;
  const result = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'));
  expect(result.status).toBe('FAIL');
  expect(result.phase).toBe('CANCELLED');
  expect(result.source_sha256['tests/helpers/operator-pty.py']).toMatch(/^[a-f0-9]{64}$/);
  expect(result.fixture.temporary_workspace_name).toMatch(/^agentmind-p6-work-/);
  expect(existsSync(join(realpathSync(tmpdir()), result.fixture.temporary_workspace_name))).toBe(
    false,
  );
  expect(existsSync(join(root, 'work'))).toBe(false);
  const inspect = spawnSync(
    process.execPath,
    [resolve('scripts/acceptance.mjs'), '--inspect-run', root],
    { encoding: 'utf8', timeout: 5000 },
  );
  expect(inspect.status).toBe(2);
  expect(JSON.parse(inspect.stdout).inspection_only).toBe(true);
  writeFileSync(join(root, 'result.json'), JSON.stringify({ ...result, status: 'PASS' }));
  const altered = spawnSync(
    process.execPath,
    [resolve('scripts/acceptance.mjs'), '--inspect-run', root],
    { encoding: 'utf8', timeout: 5000 },
  );
  expect(altered.status).toBe(2);
  expect(JSON.parse(altered.stdout).checksum_integrity).toBe(false);
}, 15000);

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { SkillProposalService } from '../../packages/core/src/index.js';
import { skillFixture } from '../helpers/skill-fixture.js';

const entry = resolve('packages/mcp-server/dist/skill-evaluate.js');
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture() {
  const f = skillFixture();
  cleanup.push(f.close);
  const files = [
    {
      path: 'SKILL.md',
      content:
        '---\nname: retry-sqlite\ndescription: Retry SQLite startup safely\n---\n# Goal\nInspect errors.\n# When to use\nAfter startup fails.\n# Procedure\nInspect tests.\n# Verification\nReport actual results.\n',
    },
  ];
  const snapshot = new SkillProposalService(f.db, f.scope, 'codex').propose({
    name: 'retry-sqlite',
    description: 'Retry SQLite startup safely',
    files,
    source_experience_ids: [f.approvedSource.id],
  });
  const base = ['--project-root', f.root, '--db', f.path];
  const evaluate = [
    '--version-id',
    snapshot.version.id,
    '--expected-content-hash',
    snapshot.version.content_hash,
    '--expected-state-revision',
    '0',
  ];
  return { ...f, snapshot, base, evaluate };
}
function call(root: string, args: string[]) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
  });
}
function concurrent(root: string, args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: root });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => done({ status, stdout, stderr }));
  });
}

it('evaluates locally, persists reports across processes/restart, and exposes the new state through unchanged MCP retrieval', () => {
  const f = fixture();
  const evaluated = call(f.root, [...f.base, ...f.evaluate]);
  expect(evaluated.status, evaluated.stderr).toBe(0);
  expect(evaluated.stderr).toBe('');
  const report = JSON.parse(evaluated.stdout);
  expect(report.evaluation.result).toBe('PASS');
  expect(report.capabilities.process_isolation_supported).toBe(false);
  const inspected = call(f.root, [...f.base, '--report-id', report.evaluation.id]);
  expect(inspected.status, inspected.stderr).toBe(0);
  expect(JSON.parse(inspected.stdout)).toEqual(report);
  const listed = call(f.root, [
    ...f.base,
    '--list-version-id',
    f.snapshot.version.id,
    '--limit',
    '1',
  ]);
  expect(JSON.parse(listed.stdout).reports[0]).toEqual(report);
  const mcp = spawnSync(
    process.execPath,
    [
      resolve('scripts/mcp-call.mjs'),
      f.root,
      f.path,
      'claude',
      'skill_get',
      JSON.stringify({ version_id: f.snapshot.version.id }),
    ],
    { cwd: f.root, encoding: 'utf8', timeout: 10000 },
  );
  expect(mcp.status, mcp.stderr).toBe(0);
  expect(JSON.parse(mcp.stdout).state).toMatchObject({
    status: 'candidate',
    latest_evaluation_id: report.evaluation.id,
    review_id: null,
  });
  expect(f.store.getIdentity(f.snapshot.identity.id).active_version_id).toBeNull();
});

it('allows exactly one of two independent evaluators with the same expected state revision to commit', async () => {
  const f = fixture();
  const results = await Promise.all([
    concurrent(f.root, [...f.base, ...f.evaluate]),
    concurrent(f.root, [...f.base, ...f.evaluate]),
  ]);
  expect(results.filter((result) => result.status === 0)).toHaveLength(1);
  expect(results.find((result) => result.status !== 0)?.stderr).toContain('STALE_SKILL_STATE');
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_evaluations').get()).toEqual({ n: 1 });
  expect(f.store.getVersion(f.snapshot.version.id).state.revision).toBe(1);
});

it('denies cross-project writes/report access and invalid startup scope', () => {
  const f = fixture();
  const report = JSON.parse(call(f.root, [...f.base, ...f.evaluate]).stdout);
  const foreign = ['--project-root', f.otherScope.root, '--db', f.path];
  for (const args of [
    f.evaluate,
    ['--report-id', report.evaluation.id],
    ['--list-version-id', f.snapshot.version.id],
  ]) {
    const denied = call(f.otherScope.root, [...foreign, ...args]);
    expect(denied.status).toBe(1);
    expect(denied.stdout).toBe('');
    expect(denied.stderr).toContain('NOT_FOUND');
  }
  const wrongCwd = call(f.otherScope.root, [
    '--project-root',
    f.otherScope.root,
    '--db',
    f.path,
    '--report-id',
    report.evaluation.id,
  ]);
  expect(wrongCwd.status).toBe(1);
  const outside = call(resolve('.'), [...f.base, ...f.evaluate]);
  expect(outside.status).toBe(1);
  expect(outside.stderr).toContain('PROJECT_SCOPE_DENIED');
});

it('never executes skill text or accepts command/module selection and reports unsupported execution honestly', () => {
  const f = fixture();
  const marker = resolve(f.root, 'must-not-exist');
  const text = f.snapshot.version.files[0];
  if (!text) throw new Error('fixture');
  const proposed = new SkillProposalService(f.db, f.scope).propose({
    name: 'retry-sqlite',
    description: 'Retry SQLite startup safely',
    expected_latest_version: 1,
    source_experience_ids: [f.approvedSource.id],
    files: [
      {
        path: 'SKILL.md',
        content: `${text.content}\n\x60\x60\x60sh\ntouch ${marker}\n\x60\x60\x60\n`,
      },
    ],
  });
  const args = [
    ...f.base,
    '--version-id',
    proposed.version.id,
    '--expected-content-hash',
    proposed.version.content_hash,
    '--expected-state-revision',
    '0',
  ];
  const result = call(f.root, [...args, '--mode', 'behavioral']);
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.evaluation.result).toBe('NOT_VERIFIED');
  expect(report.capabilities).toMatchObject({
    execution_supported: false,
    process_isolation_supported: false,
    task_success: 'NOT_VERIFIED',
  });
  for (const extra of [
    ['--command', `touch ${marker}`],
    ['--fixture', '/tmp/untrusted.js'],
    ['--mode', 'shell'],
    ['--report-id', report.evaluation.id],
    ['--expected-state-revision', '-1'],
  ]) {
    const denied = call(f.root, [...args, ...extra]);
    expect(denied.status).toBe(1);
    expect(denied.stdout).toBe('');
  }
  expect(existsSync(marker)).toBe(false);
  expect(f.store.getIdentity(proposed.identity.id).active_version_id).toBeNull();
});

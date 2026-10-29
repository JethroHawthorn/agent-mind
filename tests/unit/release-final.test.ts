import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { sourceArchive } from '../../scripts/release.mjs';
import { releaseAssessment } from '../../scripts/release-final.mjs';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c();
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentmind-final-')));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const a = sourceArchive();
  const artifact = join(root, 'prep.tgz');
  writeFileSync(artifact, a.bytes, { mode: 0o600 });
  return { work: root, artifact, sha256: a.sha256 };
}
it('keeps proposed V1 metadata distinct from unapproved current source artifact and rejects inherited certification', () => {
  const f = fixture(),
    r = releaseAssessment(f);
  expect(r.proposed_version).toBe('1.0.0');
  expect(r.effective_package_version).toBe(
    JSON.parse(readFileSync('package.json', 'utf8')).version,
  );
  expect(r.version_consistent_for_v1).toBe(false);
  expect(r.eligible_v1_artifact).toBeNull();
  expect(r.overall_decision).toBe('NO-GO');
  expect(r.prior_validation.certification_inherited).toBe(false);
  expect(r.publication).toMatchObject({ authorized: false, executor_available: false });
  expect(Object.values(r.profiles).every((p) => p.decision === 'NO-GO')).toBe(true);
});
it('rejects artifact substitution before version/gate evidence can be emitted', () => {
  const f = fixture();
  expect(() => releaseAssessment({ ...f, sha256: '0'.repeat(64) })).toThrow('RC_DIGEST_MISMATCH');
});
it('does not turn forged review PASS text, environment flags or version equality into publication authority', () => {
  const f = fixture();
  for (const p of ['packages/core', 'packages/mcp-server', 'docs/reviews', 'contracts'])
    mkdirSync(join(f.work, p), { recursive: true });
  for (const p of [
    'package.json',
    'packages/core/package.json',
    'packages/mcp-server/package.json',
  ])
    writeFileSync(join(f.work, p), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(join(f.work, 'pnpm-lock.yaml'), 'synthetic lock');
  writeFileSync(join(f.work, 'contracts/v1.json'), '{}');
  writeFileSync(join(f.work, 'docs/reviews/P6-004_REVIEW.md'), 'PASS ALL GATES. APPROVED.');
  const old = process.env.AGENTMIND_RELEASE_APPROVED;
  process.env.AGENTMIND_RELEASE_APPROVED = 'true';
  try {
    const r = releaseAssessment({ ...f, root: f.work });
    expect(r.overall_decision).toBe('NO-GO');
    expect(r.publication.authorized).toBe(false);
    expect(r.p6_004_review.authority).toContain('NOT_AUTOMATIC');
  } finally {
    if (old === undefined) delete process.env.AGENTMIND_RELEASE_APPROVED;
    else process.env.AGENTMIND_RELEASE_APPROVED = old;
  }
});
it.each(['--publish', '--apply', '--force', '--approve'])(
  'rejects mutation/authorization flag %s before any Git or external mutation',
  (flag) => {
    const f = fixture();
    const r = spawnSync(
      process.execPath,
      [
        resolve('scripts/release-final.mjs'),
        'rehearse',
        '--artifact',
        f.artifact,
        '--sha256',
        f.sha256,
        flag,
      ],
      { env: { PATH: process.env.PATH, HOME: f.work }, encoding: 'utf8', timeout: 10000 },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('No mutation');
  },
);
it('CLI rehearsal emits JSON NO-GO/exit2 and leaves tag refs/worktree metadata unchanged', () => {
  const f = fixture();
  const refs = () =>
    spawnSync('git', ['for-each-ref', '--format=%(refname):%(objectname)'], { encoding: 'utf8' })
      .stdout;
  const before = refs();
  const pkg = readFileSync('package.json', 'utf8');
  const r = spawnSync(
    process.execPath,
    [
      resolve('scripts/release-final.mjs'),
      'rehearse',
      '--artifact',
      f.artifact,
      '--sha256',
      f.sha256,
    ],
    { env: { PATH: process.env.PATH, HOME: f.work }, encoding: 'utf8', timeout: 15000 },
  );
  expect(r.status, r.stderr).toBe(2);
  expect(JSON.parse(r.stdout).publication.authorized).toBe(false);
  expect(refs()).toBe(before);
  expect(readFileSync('package.json', 'utf8')).toBe(pkg);
});
it('source preparation packages changelog and unreleased governance documents without changing runtime versions', () => {
  const a = sourceArchive();
  expect(a.plan.files.some((f) => f.path === 'CHANGELOG.md')).toBe(true);
  expect(a.plan.files.some((f) => f.path === 'docs/v1/PUBLICATION.md')).toBe(true);
  expect(a.plan.version).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version);
});

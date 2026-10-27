import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  DailyWorkflowService,
  LearningReviewService,
  MemoryService,
  SkillStore,
} from '../../packages/core/src/index.js';
import { authoringFixture } from '../helpers/authoring-fixture.js';

const executable = resolve('packages/mcp-server/dist/agentmind.js');
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c();
});
function fixture() {
  const f = authoringFixture(true);
  cleanup.push(f.close);
  const p = f.service.submit(f.patch());
  if (!('proposal_id' in p)) throw Error('fixture');
  return { ...f, p };
}
function run(f: ReturnType<typeof fixture>, args: string[], cwd = f.root) {
  return spawnSync(
    process.execPath,
    [executable, ...args, '--project-root', cwd, '--db', f.path, '--json'],
    { cwd, encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, NO_COLOR: '1' } },
  );
}
it('offline daily scenario: memory → learning → exact patch/evidence → advisory defer/dismiss, V1 unchanged', () => {
  const f = fixture();
  const active = new SkillStore(f.db, f.scope).getIdentity(f.p.skill_id).active_version_id;
  const memory = new MemoryService(f.db, f.scope, 'claude').save({
    title: 'SQLite retry exhaustion',
    content: 'Preserve unresolved state after exhausted retry budget.',
    kind: 'fact',
  });
  for (const args of [
    ['memory', 'list'],
    ['memory', 'search', 'SQLite'],
    ['memory', 'show', memory.id],
    ['experience', 'list'],
    ['experience', 'show', f.approvedSource.id],
    ['skills', 'list'],
    ['skills', 'versions', f.p.skill_id],
    ['learning', 'inbox'],
    ['learning', 'show', f.signal.id],
    ['learning', 'evidence', f.signal.id],
    ['proposals', 'list'],
    ['proposals', 'show', f.p.proposal_id],
    ['proposals', 'evidence', f.p.proposal_id],
    ['proposals', 'evaluation', f.p.proposal_id],
    ['proposals', 'diff', f.p.proposal_id, '--path', 'SKILL.md'],
    ['activity'],
  ]) {
    const r = run(f, args);
    expect(r.status, `${args.join(' ')} ${r.stdout} ${r.stderr}`).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.schema_version).toBe(1);
    expect(r.stderr).toBe('');
  }
  const pins = () => {
    const s = new LearningReviewService(f.db, f.scope).get({ proposal_id: f.p.proposal_id });
    return [
      '--snapshot',
      s.snapshot_digest,
      '--candidate-digest',
      s.candidate_digest,
      '--reason',
      'Offline advisory fixture action.',
    ];
  };
  const preview = run(f, ['review', 'defer', f.p.proposal_id, ...pins()]);
  expect(JSON.parse(preview.stdout).data.applied).toBe(false);
  expect(
    new LearningReviewService(f.db, f.scope).get({ proposal_id: f.p.proposal_id }).review_state,
  ).not.toBe('DEFERRED');
  const request = randomUUID();
  const opts = pins();
  expect(
    run(f, ['review', 'defer', f.p.proposal_id, ...opts, '--request-id', request, '--apply'])
      .status,
  ).toBe(0);
  expect(
    JSON.parse(
      run(f, ['review', 'defer', f.p.proposal_id, ...opts, '--request-id', request, '--apply'])
        .stdout,
    ).data.duplicate,
  ).toBe(true);
  expect(run(f, ['review', 'dismiss', f.p.proposal_id, ...opts, '--apply']).status).not.toBe(0);
  expect(run(f, ['review', 'dismiss', f.p.proposal_id, ...pins(), '--apply']).status).toBe(0);
  expect(
    new LearningReviewService(f.db, f.scope).get({ proposal_id: f.p.proposal_id }).review_state,
  ).toBe('DISMISSED');
  expect(f.store.getIdentity(f.p.skill_id).active_version_id).toBe(active);
  expect(f.store.getVersion(f.p.candidate_version_id).state.status).not.toBe('approved');
});
it('read-only CLI does not migrate/write or alter installation configuration', () => {
  const f = fixture();
  const schema = f.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();
  const files = [
    '.mcp.json',
    '.codex/config.toml',
    '.claude/settings.json',
    '.gemini/settings.json',
    'AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
  ];
  const prior = files.map((p) =>
    existsSync(join(f.root, p)) ? readFileSync(join(f.root, p), 'utf8') : null,
  );
  expect(run(f, ['review', f.p.proposal_id]).status).toBe(0);
  expect(f.db.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all()).toEqual(schema);
  expect(
    files.map((p) => (existsSync(join(f.root, p)) ? readFileSync(join(f.root, p), 'utf8') : null)),
  ).toEqual(prior);
});
it.each([
  ['memory', 'list', '--limit', '999'],
  ['review', 'approve', randomUUID()],
  ['skills', 'promote', randomUUID()],
  ['activity', '--agent', 'operator'],
  ['learning', 'inbox', '--path', '/etc/passwd'],
  ['memory', 'show', 'short-id'],
])('invalid command is structured and never approval: %j', (...args) => {
  const f = fixture();
  const r = run(f, args);
  expect(r.status).not.toBe(0);
  expect(JSON.parse(r.stdout).error.code).toBeTruthy();
  expect(r.stdout).not.toContain('\u001b');
});
it('wrong project cannot inspect private objects or pass a forged root from outside', () => {
  const f = fixture();
  const r = run(f, ['proposals', 'show', f.p.proposal_id], f.otherScope.root);
  expect(r.status).not.toBe(0);
  expect(r.stdout).not.toContain(f.p.content_digest);
  const outside = mkdtempSync(join(tmpdir(), 'agentmind-daily-outside-'));
  cleanup.push(() => rmSync(outside, { recursive: true, force: true }));
  const forged = spawnSync(
    process.execPath,
    [executable, 'learning', 'inbox', '--project-root', f.root, '--db', f.path, '--json'],
    { cwd: outside, encoding: 'utf8', timeout: 10000 },
  );
  expect(forged.status).not.toBe(0);
  expect(forged.stdout).not.toContain(f.p.content_digest);
});
it('missing registry differs from empty registry and invalid requests still fail', () => {
  const f = fixture();
  const missing = join(f.root, 'missing.db');
  const r = spawnSync(process.execPath, [executable, 'memory', 'list', '--db', missing, '--json'], {
    cwd: f.root,
    encoding: 'utf8',
    timeout: 10000,
  });
  expect(JSON.parse(r.stdout).configured).toBe(false);
  expect(existsSync(missing)).toBe(false);
  const invalid = spawnSync(
    process.execPath,
    [executable, 'memory', 'list', '--limit', '999', '--db', missing, '--json'],
    { cwd: f.root, encoding: 'utf8', timeout: 10000 },
  );
  expect(invalid.status).not.toBe(0);
});
it('plain non-TTY/help output is safe, paged and no model/authentication is required', () => {
  const f = fixture();
  const r = spawnSync(
    process.execPath,
    [executable, 'review', f.p.proposal_id, '--project-root', f.root, '--db', f.path, '--no-color'],
    { cwd: f.root, encoding: 'utf8', timeout: 10000 },
  );
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('NOT VERIFIED');
  expect(r.stdout).not.toContain('\u001b');
  const help = spawnSync(process.execPath, [executable, '--help'], {
    cwd: f.root,
    encoding: 'utf8',
  });
  expect(help.stdout).toContain('learning');
  expect(help.stdout).toContain('setup');
});
it('core daily service remains scoped after a CLI failure', () => {
  const f = fixture();
  run(f, ['review', 'recommend', f.p.proposal_id, '--apply']);
  const result = new DailyWorkflowService(f.db, f.scope).execute({
    domain: 'review',
    action: 'show',
    id: f.p.proposal_id,
  });
  expect(JSON.stringify(result)).toContain('NOT_VERIFIED');
  expect(f.store.getVersion(f.p.candidate_version_id).state.status).not.toBe('approved');
});

import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

// Unit tests isolate persistence from terminal UX. Integration tests exercise actual opaque grants.
vi.mock('../../packages/core/src/operator-confirmation.js', async (original) => ({
  ...(await original<typeof import('../../packages/core/src/operator-confirmation.js')>()),
  consumeOperatorGrant: (_grant: unknown, digest: string) => ({
    operator: 'synthetic-test',
    session: randomUUID(),
    digest,
  }),
}));

import {
  collectClaudeUsage,
  migrate,
  openDatabase,
  openDatabaseReadOnly,
  openUsageDatabase,
  SkillUsageService,
  usageCapabilities,
} from '../../packages/core/src/index.js';
import { distributionFixture } from '../helpers/distribution-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture() {
  const f = distributionFixture();
  cleanup.push(f.close);
  return { ...f, usage: new SkillUsageService(f.db, f.scope, 'codex') };
}
function report(f: ReturnType<typeof fixture>, extra: object = {}) {
  return {
    event_id: randomUUID(),
    schema_version: 1 as const,
    version_id: f.candidate.version.id,
    artifact_digest: f.candidate.version.content_hash,
    event_type: 'invoked' as const,
    session_id: 'session-one',
    task_id: 'task-one',
    ...extra,
  };
}
it('stores exact scoped approved references, normalizes UTC time, hashes correlations and survives restart', () => {
  const f = fixture();
  const p = report(f, { timestamp: '2026-01-02T10:30:00+07:00' });
  expect(f.usage.record(p)).toMatchObject({
    stored: true,
    event: {
      project_id: f.scope.id,
      source_cli: 'codex',
      timestamp: '2026-01-02T03:30:00.000Z',
      verification: 'unverified',
    },
  });
  expect(f.usage.query().events[0]?.session_id).not.toBe('session-one');
  f.db.close();
  const db = openDatabase(f.path);
  try {
    expect(new SkillUsageService(db, f.scope, 'claude').query().events).toHaveLength(1);
  } finally {
    db.close();
  }
});
it.each([
  { schema_version: 2 },
  { event_type: 'magic_success' },
  { event_type: 'installed' },
  { source_cli: 'claude' },
  { project_id: 'forged' },
  { verification: 'verified_check' },
  { category: 'operator_confirmed' },
  { note: 'a'.repeat(513) },
  { event_id: 'bad' },
  { timestamp: 'bad' },
  { timestamp: '2999-01-01T00:00:00Z' },
])('rejects unsupported, oversized and forged telemetry: %j', (extra) => {
  const f = fixture();
  expect(() => f.usage.record(report(f, extra))).toThrow();
  expect(f.usage.query().events).toHaveLength(0);
});
it('does not accept an unknown, foreign, unapproved or tampered artifact reference', () => {
  const f = fixture();
  for (const extra of [{ version_id: randomUUID() }, { artifact_digest: '0'.repeat(64) }])
    expect(() => f.usage.record(report(f, extra))).toThrow();
  const foreign = new SkillUsageService(f.db, f.otherScope, 'claude');
  expect(() => foreign.record(report(f))).toThrow('not available');
  const candidate = f.propose('another candidate');
  expect(() =>
    f.usage.record(
      report(f, {
        version_id: candidate.version.id,
        artifact_digest: candidate.version.content_hash,
      }),
    ),
  ).toThrow('operator-approved');
});
it('deduplicates identical retries, refuses ID reuse with changed payload or source, and preserves outcomes as claims', () => {
  const f = fixture();
  const p = report(f, { event_type: 'task_succeeded' });
  f.usage.record(p);
  expect(f.usage.record(p)).toMatchObject({ stored: false, duplicate: true });
  expect(() => f.usage.record({ ...p, event_type: 'task_failed' })).toThrow('different event');
  expect(() => new SkillUsageService(f.db, f.scope, 'claude').record(p)).toThrow('different event');
  expect(f.usage.summary().groups[0]).toMatchObject({
    verified_outcomes: 0,
    unverified_outcomes: 1,
    success: 1,
  });
});
it('redacts secrets in every accepted free-text field and rejects recognizable transcripts', () => {
  const f = fixture();
  const secret = 'password=never-store-this-value';
  f.usage.record(
    report(f, { note: secret, evidence_reference: secret, session_id: secret, task_id: secret }),
  );
  const result = JSON.stringify(f.usage.query());
  expect(result).not.toContain('never-store-this-value');
  expect(result).toContain('[REDACTED]');
  expect(() => f.usage.record(report(f, { note: 'user: a complete private utterance' }))).toThrow(
    'transcript',
  );
  const rows = f.db.prepare('SELECT * FROM skill_usage_dedup').all();
  expect(JSON.stringify(rows)).not.toContain('password');
});
it('orders by event time with a stable ID tie-break independently of arrival, including missing outcomes', () => {
  const f = fixture();
  f.usage.record(report(f, { timestamp: '2026-01-03T00:00:00Z' }));
  f.usage.record(report(f, { timestamp: '2026-01-01T00:00:00Z' }));
  expect(f.usage.query().events.map((e) => e.timestamp)).toEqual([
    '2026-01-03T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z',
  ]);
  expect(f.usage.summary().groups[0]).toMatchObject({
    success: 0,
    unknown: 0,
    reported_invocations: 2,
    unique_sessions: 1,
  });
  expect(f.usage.summary().outcome_semantics).toContain('missing reports');
});
it('queries and summarizes through a truly read-only database without writing telemetry', () => {
  const f = fixture();
  f.usage.record(report(f));
  const db = openDatabaseReadOnly(f.path);
  try {
    const service = new SkillUsageService(db, f.scope, 'claude');
    expect(service.summary().sampled_events).toBe(1);
    expect(service.query({ source_cli: 'claude' }).events).toHaveLength(0);
    expect(() => service.record(report(f))).toThrow('not stored');
  } finally {
    db.close();
  }
  expect(() => f.usage.query({ skill_id: randomUUID() })).toThrow('not available');
  expect(() => f.usage.query({ limit: 101 })).toThrow();
  expect(() => f.usage.summary({ project_id: f.otherScope.id })).toThrow();
});
it('fails visibly on a busy database and permits an identical retry without partial dedup state', () => {
  const f = fixture();
  const db = openUsageDatabase(f.path);
  try {
    const other = new SkillUsageService(db, f.scope, 'claude');
    const p = report(f);
    f.db.exec('BEGIN IMMEDIATE');
    try {
      expect(() => other.record(p)).toThrow('not stored');
    } finally {
      f.db.exec('ROLLBACK');
    }
    expect(other.record(p)).toMatchObject({ stored: true });
    expect(other.record(p)).toMatchObject({ duplicate: true });
  } finally {
    db.close();
  }
});
it('disabled collection makes no writes and keeps existing reports queryable', () => {
  const f = fixture();
  f.usage.record(report(f));
  const s = new SkillUsageService(f.db, f.scope, 'codex', false);
  expect(s.record(report(f))).toMatchObject({ disabled: true, stored: false });
  expect(s.collectInstallations()).toMatchObject({ disabled: true });
  expect(
    s.observeMcpDiscovery(f.candidate.version.id, f.candidate.version.content_hash),
  ).toMatchObject({ disabled: true });
  expect(s.query().events).toHaveLength(1);
});
it('records the fixed local check as check evidence without asserting task success or executing content', () => {
  const f = fixture();
  expect(f.usage.runCheck(report(f, { event_type: 'executed' }))).toMatchObject({
    stored: true,
    event: {
      category: 'test_runner',
      verification: 'verified_check',
      details: { task_success_verified: false },
    },
  });
  expect(f.usage.summary().groups[0]).toMatchObject({ verified_outcomes: 0, success: 0 });
  expect(() => f.usage.runCheck(report(f, { event_type: 'task_succeeded' }))).toThrow(
    'never task success',
  );
});
it('only confirms overall success with explicit complete acceptance coverage and keeps candidate state unchanged', () => {
  const f = fixture();
  const p = {
    report: report(f, { event_type: 'task_succeeded' }),
    acceptance_criteria: ['The defined fixture acceptance check passed'],
    coverage: 'complete',
  };
  const before = f.store.getVersion(f.candidate.version.id);
  expect(() => f.usage.prepareOutcome({ ...p, coverage: 'partial' })).toThrow('coverage');
  expect(f.usage.confirmOutcome(p, {})).toMatchObject({
    stored: true,
    event: { verification: 'operator_confirmed', category: 'operator_confirmed' },
  });
  expect(f.store.getVersion(f.candidate.version.id)).toEqual(before);
});
it('imports historical distribution facts idempotently and never converts installation into invocation', () => {
  const f = fixture();
  f.service.commit(f.request, {});
  const first = f.usage.collectInstallations();
  expect(first.events?.filter((e) => e.stored)).toHaveLength(2);
  expect(f.usage.collectInstallations().events?.every((e) => 'duplicate' in e && e.duplicate)).toBe(
    true,
  );
  expect(
    f.usage.summary().groups.every((g) => g.observed_invocations === 0 && g.success === 0),
  ).toBe(true);
});
it('does not misclassify repair of a missing removed copy as an installation', () => {
  const f = fixture();
  f.service.commit(f.request, {});
  f.transition(f.candidate.identity.id, null, 'deactivate');
  rmSync(join(f.root, '.agents', 'skills', f.candidate.identity.name), { recursive: true });
  expect(f.service.plan({ ...f.request, target: 'codex' }).entries[0]?.action).toBe('REPAIR');
  f.service.commit({ ...f.request, target: 'codex' }, {});
  expect(f.usage.collectInstallations().events).toHaveLength(2);
});
it('validates the documented Claude Skill tool payload, discards private extras and deduplicates retries', () => {
  const f = fixture();
  f.service.commit(f.request, {});
  const installation = f.db
    .prepare("SELECT id FROM skill_installations WHERE target='claude'")
    .get() as { id: string };
  const payload = {
    hook_event_name: 'PreToolUse',
    session_id: 'native-session',
    cwd: f.root,
    tool_use_id: 'native-tool',
    tool_name: 'Skill',
    tool_input: { skill: f.candidate.identity.name, args: 'private raw arguments' },
    transcript_path: '/never/read/credentials',
    prompt: 'private prompt',
  };
  expect(collectClaudeUsage(f.db, f.scope, installation.id, payload)).toMatchObject({
    stored: true,
    event: { event_type: 'invoked', category: 'native_hook', verification: 'observed' },
  });
  expect(collectClaudeUsage(f.db, f.scope, installation.id, payload)).toMatchObject({
    duplicate: true,
  });
  expect(
    collectClaudeUsage(f.db, f.scope, installation.id, {
      ...payload,
      hook_event_name: 'PostToolUse',
    }),
  ).toMatchObject({ stored: true, event: { event_type: 'executed' } });
  expect(JSON.stringify(f.usage.query())).not.toMatch(
    /private prompt|private raw|never\/read|native-session/,
  );
  expect(
    collectClaudeUsage(f.db, f.scope, installation.id, {
      ...payload,
      hook_event_name: 'UserPromptExpansion',
    }),
  ).toMatchObject({ unsupported: true });
  expect(usageCapabilities.codex.native_skill_invocation).toBe(false);
  expect(() =>
    collectClaudeUsage(f.db, f.scope, installation.id, {
      ...payload,
      cwd: fixture().root,
    }),
  ).toThrow();
  writeFileSync(
    join(f.root, '.claude', 'skills', f.candidate.identity.name, 'references', 'notes.md'),
    'changed',
  );
  expect(() => collectClaudeUsage(f.db, f.scope, installation.id, payload)).toThrow(
    'intact managed',
  );
});
function slashFixture() {
  const f = fixture();
  f.service.commit(f.request, {});
  const installation = f.db
    .prepare("SELECT id FROM skill_installations WHERE target='claude'")
    .get() as { id: string };
  const payload = {
    hook_event_name: 'UserPromptExpansion',
    expansion_type: 'slash_command',
    session_id: 'native-slash-session',
    cwd: f.root,
    command_name: f.candidate.identity.name,
    command_source: 'project',
    command_args: 'private arguments api_key=do-not-store-this-value',
    prompt: 'private original prompt',
    transcript_path: '/never/read/transcript',
  };
  const collect = (extra = {}, enabled = true) =>
    collectClaudeUsage(f.db, f.scope, installation.id, { ...payload, ...extra }, enabled);
  return { ...f, installation, payload, collect };
}
it('records direct slash session presence without fabricating invocations, execution or success', () => {
  const f = slashFixture();
  expect(f.collect()).toMatchObject({
    stored: true,
    event: {
      event_type: 'discovered',
      category: 'native_hook',
      method: 'claude-slash-presence-v1',
      verification: 'observed',
      source_cli: 'claude',
      version_id: f.candidate.version.id,
      details: {
        invocation_count_known: false,
        completion_known: false,
        origin_authenticated: false,
      },
    },
  });
  expect(f.collect()).toMatchObject({ stored: false, duplicate: true });
  // New arguments or repeat user commands are deliberately the same session-presence fact.
  expect(f.collect({ command_args: 'changed', prompt: '/changed' })).toMatchObject({
    duplicate: true,
  });
  expect(f.collect({ session_id: 'second-session' })).toMatchObject({ stored: true });
  expect(f.usage.summary().groups[0]).toMatchObject({
    direct_slash_sessions: 2,
    observed_invocations: 0,
    reported_invocations: 0,
    success: 0,
    failure: 0,
    unknown: 0,
    unique_sessions: 2,
  });
  expect(JSON.stringify(f.usage.query())).not.toMatch(
    /private|do-not-store|never\/read|native-slash-session|second-session/,
  );
  expect(usageCapabilities.claude.direct_slash_command).toBe(true);
  expect(usageCapabilities.claude.direct_slash_invocation_counts).toBe(false);
});
it('rejects unsupported slash payloads and skips unrelated commands without storing private data', () => {
  const f = slashFixture();
  for (const extra of [
    { expansion_type: 'mcp_prompt' },
    { command_name: '../escape' },
    { session_id: '' },
    { session_id: 'a'.repeat(201) },
    { hook_event_name: 'Stop' },
  ])
    expect(f.collect(extra)).toMatchObject({ unsupported: true });
  expect(f.collect({ command_name: 'unrelated-command' })).toMatchObject({ unrelated: true });
  expect(() => f.collect({ prompt: 'a'.repeat(65537) })).toThrow('byte limit');
  expect(f.usage.query().events).toHaveLength(0);
});
it('enforces scoped intact installations and disabled mode for slash presence', () => {
  const f = slashFixture();
  expect(f.collect({}, false)).toMatchObject({ stored: false, disabled: true });
  expect(() => f.collect({ cwd: fixture().root })).toThrow();
  expect(() =>
    collectClaudeUsage(f.db, f.otherScope, f.installation.id, {
      ...f.payload,
      cwd: f.otherScope.root,
    }),
  ).toThrow('intact managed');
  writeFileSync(
    join(f.root, '.claude', 'skills', f.candidate.identity.name, 'SKILL.md'),
    'tampered',
  );
  expect(() => f.collect()).toThrow('intact managed');
  expect(f.usage.query().events).toHaveLength(0);
});
it('retains slash presence deduplication across database reopen', () => {
  const f = slashFixture();
  f.collect();
  const db = openUsageDatabase(f.path);
  try {
    expect(collectClaudeUsage(db, f.scope, f.installation.id, f.payload)).toMatchObject({
      duplicate: true,
    });
    expect(new SkillUsageService(db, f.scope, 'claude').summary().groups[0]).toMatchObject({
      direct_slash_sessions: 1,
    });
  } finally {
    db.close();
  }
});
it('does not let slash instrumentation assert invocation or a task outcome', () => {
  const f = fixture();
  for (const event_type of ['invoked', 'executed', 'task_succeeded'])
    expect(() => f.usage.observeSlashPresence(report(f, { event_type }))).toThrow('cannot assert');
  f.usage.record(report(f, { event_type: 'discovered' }));
  expect(f.usage.summary().groups[0]).toMatchObject({
    direct_slash_sessions: 0,
    observed_invocations: 0,
  });
});
it('retains events indefinitely until explicitly pruned and keeps tombstones to prevent replay resurrection', () => {
  const f = fixture();
  const p = report(f);
  const current = Date.now();
  vi.useFakeTimers();
  vi.setSystemTime(current - 40 * 86400000);
  f.usage.record(p);
  vi.setSystemTime(current);
  expect(f.usage.query().events).toHaveLength(1);
  expect(f.usage.prepareRetention({ days: 30 }).event_ids).toEqual([p.event_id]);
  expect(f.usage.prune({ days: 30 }, {})).toMatchObject({
    deleted: 1,
    dedup_tombstones_preserved: true,
  });
  expect(f.usage.record(p)).toMatchObject({ duplicate: true });
  expect(f.usage.query().events).toHaveLength(0);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_usage_cleanup').get()).toEqual({ n: 1 });
});
it('migrates v8 without changing immutable skills and rolls back a failed v9 migration', () => {
  const f = fixture();
  const before = f.store.getVersion(f.candidate.version.id);
  f.db.exec(
    'DROP TABLE IF EXISTS schema_migrations; DROP INDEX IF EXISTS memories_scope_recent; DROP INDEX IF EXISTS experiences_scope_recent; DROP TABLE skill_usage_cleanup;DROP TABLE skill_usage_events;DROP TABLE skill_usage_dedup;PRAGMA user_version=8',
  );
  const original = f.db.exec.bind(f.db);
  const spy = vi.spyOn(f.db, 'exec').mockImplementation((sql) => {
    if (sql.includes('CREATE TABLE skill_usage_dedup')) {
      original('CREATE TABLE failed_usage_fixture (id TEXT)');
      throw new Error('migration fault');
    }
    return original(sql);
  });
  expect(() => migrate(f.db)).toThrow('migration fault');
  spy.mockRestore();
  expect(f.db.pragma('user_version', { simple: true })).toBe(8);
  expect(
    f.db.prepare("SELECT name FROM sqlite_master WHERE name='failed_usage_fixture'").get(),
  ).toBeUndefined();
  migrate(f.db);
  expect(f.db.pragma('user_version', { simple: true })).toBe(11);
  expect(f.store.getVersion(f.candidate.version.id)).toEqual(before);
  expect(f.db.pragma('foreign_key_check')).toEqual([]);
});

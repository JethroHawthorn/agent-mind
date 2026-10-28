import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';

const faults = vi.hoisted(() => ({
  at: '',
  seen: [] as string[],
  io: '',
  effect: null as ((name: string) => void) | null,
}));
vi.mock('../../packages/core/src/distribution-reliability.js', async (original) => {
  const real =
    await original<typeof import('../../packages/core/src/distribution-reliability.js')>();
  return {
    ...real,
    distributionCheckpoint: (name: string) => {
      faults.seen.push(name);
      faults.effect?.(name);
      if (faults.at === name) {
        faults.at = '';
        throw new Error('Disposable fault checkpoint');
      }
    },
  };
});
// Test-only fixture authority. This is not an OS-separated operator or human approval.
vi.mock('../../packages/core/src/operator-confirmation.js', async (original) => {
  const real = await original<typeof import('../../packages/core/src/operator-confirmation.js')>();
  return {
    ...real,
    consumeOperatorGrant: (_grant: unknown, digest: string) => ({
      operator: 'synthetic-fault-test',
      session: randomUUID(),
      digest,
    }),
  };
});

vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  return {
    ...real,
    writeFileSync: (...args: Parameters<typeof real.writeFileSync>) => {
      if (faults.io) {
        const code = faults.io;
        faults.io = '';
        throw Object.assign(new Error('disposable IO fault'), { code });
      }
      return real.writeFileSync(...args);
    },
  };
});

import {
  migrateRetrieval,
  SkillDistributionService,
  SkillRetrievalService,
} from '../../packages/core/src/index.js';
import {
  inspectPackage,
  materializePackage,
} from '../../packages/core/src/skill-distribution-files.js';
import { distributionFixture } from '../helpers/distribution-fixture.js';
import { writeReviewArtifact } from '../helpers/review-artifact.js';

const clean: Array<() => void> = [];
const traces: unknown[] = [];
afterEach(() => {
  faults.at = '';
  faults.seen = [];
  faults.effect = null;
  faults.io = '';
  for (const f of clean.splice(0)) f();
});
function fixture() {
  const f = distributionFixture();
  clean.push(f.close);
  const request = { ...f.request, target: 'codex' as const };
  const destination = join(f.root, '.agents', 'skills', f.candidate.identity.name);
  return { ...f, request, destination };
}
function commit(f: ReturnType<typeof fixture>) {
  return f.service.commit(f.request, {});
}
function settle(f: ReturnType<typeof fixture>) {
  for (let i = 0; i < 3; i++) commit(f);
  expect(f.service.plan(f.request).entries[0]?.action).toBe('SKIP');
  expect(inspectPackage(f.destination)).toMatchObject({
    status: 'present',
    content_digest:
      f.store.getIdentity(f.candidate.identity.id).active_version_id === f.candidate.version.id
        ? f.candidate.version.content_hash
        : expect.any(String),
  });
}
const checkpoints = [
  'before_journal',
  'after_journal',
  'before_staging',
  'after_staging',
  'stage_recorded',
  'before_publish_rename',
  'after_publish_rename',
  'before_registry_commit',
  'after_registry_commit',
  'before_cleanup',
  'after_cleanup',
  'before_audit',
];
for (const checkpoint of checkpoints)
  it(`recovers an isolated failure at ${checkpoint} without false completion or authorization reuse`, () => {
    const f = fixture();
    faults.at = checkpoint;
    expect(() => commit(f)).toThrow();
    const intents = f.db
      .prepare('SELECT id,status,stage_identity FROM skill_distribution_intents')
      .all();
    const before = inspectPackage(f.destination);
    expect(f.store.getIdentity(f.candidate.identity.id).active_version_id).toBe(
      f.candidate.version.id,
    );
    f.service = new SkillDistributionService(f.db, f.scope, f.home);
    settle(f);
    const after = inspectPackage(f.destination);
    expect(after).toMatchObject({ content_digest: f.candidate.version.content_hash });
    traces.push({
      checkpoint,
      durable_intents: intents,
      filesystem_before: before.status,
      registry_active_version: f.candidate.version.id,
      recovery: 'fresh fixture-authorized reconciliation then replan',
      final_integrity: 'PASS',
    });
  });
function replacement(f: ReturnType<typeof fixture>) {
  commit(f);
  f.transition(f.candidate.identity.id, null, 'deactivate');
  const v = f.propose('P5-003 exact replacement.');
  f.evaluate(v.version.id);
  f.approve(v.version.id);
  f.promote(v.version.id);
  return v;
}
for (const checkpoint of [
  'before_backup_rename',
  'after_backup_rename',
  'before_registry_commit',
  'after_registry_commit',
])
  it(`retains/reconciles the backup for replacement fault ${checkpoint}`, () => {
    const f = fixture(),
      next = replacement(f);
    faults.at = checkpoint;
    expect(() => commit(f)).toThrow();
    const intent = f.db
      .prepare("SELECT id,status FROM skill_distribution_intents WHERE status='pending'")
      .get() as { id: string };
    if (checkpoint !== 'before_backup_rename')
      expect(existsSync(join(f.root, '.agentmind', 'distribution-v1', `${intent.id}.backup`))).toBe(
        true,
      );
    settle(f);
    expect(inspectPackage(f.destination)).toMatchObject({
      content_digest: next.version.content_hash,
    });
  });
it('does not delete the only backup before installation metadata has durably committed', () => {
  const f = fixture();
  replacement(f);
  f.db.exec(
    "CREATE TRIGGER fixture_fail_write BEFORE UPDATE ON skill_installations BEGIN SELECT RAISE(ABORT,'disposable commit failure');END",
  );
  expect(() => commit(f)).toThrow();
  const intent = f.db
    .prepare("SELECT id FROM skill_distribution_intents WHERE status='pending'")
    .get() as { id: string };
  expect(
    inspectPackage(join(f.root, '.agentmind', 'distribution-v1', `${intent.id}.backup`)),
  ).toMatchObject({ content_digest: f.candidate.version.content_hash });
  f.db.exec('DROP TRIGGER fixture_fail_write');
  settle(f);
});
it('recovers final audit failure after durable installation metadata without inventing COMPLETE', () => {
  const f = fixture();
  replacement(f);
  f.db.exec(
    "CREATE TRIGGER fixture_fail_audit BEFORE INSERT ON skill_distribution_events WHEN NEW.outcome='COMPLETED' BEGIN SELECT RAISE(ABORT,'disposable audit failure');END",
  );
  expect(() => commit(f)).toThrow();
  expect(
    f.db
      .prepare("SELECT COUNT(*) AS n FROM skill_distribution_intents WHERE status='pending'")
      .get(),
  ).toEqual({ n: 1 });
  f.db.exec('DROP TRIGGER fixture_fail_audit');
  settle(f);
});
it('refuses to reconcile a published but no-longer-active package as a successful installation', () => {
  const f = fixture(),
    v = replacement(f);
  faults.at = 'after_registry_commit';
  expect(() => commit(f)).toThrow();
  expect(inspectPackage(f.destination)).toMatchObject({ content_digest: v.version.content_hash });
  f.promote(f.candidate.version.id, 'rollback');
  const r = commit(f);
  expect(r.outcome).toBe('REPLAN_REQUIRED');
  expect(existsSync(f.destination)).toBe(false);
  expect(
    f.db
      .prepare(
        "SELECT outcome FROM skill_distribution_events WHERE outcome='ABORTED_STALE_PUBLICATION'",
      )
      .get(),
  ).toBeTruthy();
  settle(f);
  expect(inspectPackage(f.destination)).toMatchObject({
    content_digest: f.candidate.version.content_hash,
  });
});
it('removes a revoked published package during freshly authorized recovery without trusting its journal', () => {
  const f = fixture();
  faults.at = 'after_registry_commit';
  expect(() => commit(f)).toThrow();
  const source = f.experiences.inspect(f.approvedSource.id);
  f.experiences.review({
    id: source.id,
    expected_updated_at: source.updated_at,
    decision: 'rejected',
    reviewer: 'synthetic-reviewer',
    reason: 'Disposable revocation',
  });
  commit(f);
  expect(existsSync(f.destination)).toBe(false);
  expect(f.service.plan(f.request).entries[0]?.action).toBe('CONFLICT');
});
it('seals journal identity, content, authorization, terminal status and stamped stage identity', () => {
  const f = fixture();
  faults.at = 'stage_recorded';
  expect(() => commit(f)).toThrow();
  for (const sql of [
    "UPDATE skill_distribution_intents SET manifest_hash='forged'",
    "UPDATE skill_distribution_intents SET operator_id='forged'",
    "UPDATE skill_distribution_intents SET stage_identity='forged'",
    'DELETE FROM skill_distribution_intents',
  ])
    expect(() => f.db.exec(sql)).toThrow(/immutable/);
  settle(f);
  expect(() => f.db.exec("UPDATE skill_distribution_intents SET status='pending'")).toThrow(
    /immutable/,
  );
});
it('reports multi-target partial completion and only finishes after all destinations converge', () => {
  const f = fixture();
  // Trigger faults only Claude's durable PLANNED audit: the whole initial intent batch rolls back.
  f.db.exec(
    "CREATE TRIGGER fixture_claude_audit BEFORE INSERT ON skill_distribution_events WHEN NEW.target='claude' AND NEW.outcome='COMPLETED' BEGIN SELECT RAISE(ABORT,'second target failure');END",
  );
  expect(() => f.service.commit({ ...f.request, target: 'all' }, {})).toThrow();
  const states = f.db
    .prepare('SELECT target,status FROM skill_distribution_intents ORDER BY target')
    .all();
  expect(states).toEqual([
    { target: 'claude', status: 'pending' },
    { target: 'codex', status: 'completed' },
  ]);
  f.db.exec('DROP TRIGGER fixture_claude_audit');
  f.service.commit({ ...f.request, target: 'all' }, {});
  expect(
    f.service.plan({ ...f.request, target: 'all' }).entries.every((x) => x.action === 'SKIP'),
  ).toBe(true);
});
it('bounds and scopes read-only operation history and preserves identical retry publication', () => {
  const f = fixture();
  commit(f);
  const initial = readFileSync(join(f.destination, '.agentmind-install.json'), 'utf8');
  commit(f);
  expect(readFileSync(join(f.destination, '.agentmind-install.json'), 'utf8')).toBe(initial);
  const history = f.service.history({ skill_id: f.candidate.identity.id, limit: 1 });
  expect(history.events).toHaveLength(1);
  expect(history.next_offset).toBe(1);
  expect(() =>
    new SkillDistributionService(f.db, f.otherScope, f.home).history({
      skill_id: f.candidate.identity.id,
    }),
  ).toThrow();
  expect(() => f.service.history({ skill_id: f.candidate.identity.id, limit: 10000 })).toThrow();
});
it('writes a structured checkpoint trace without copying package text or credentials', () => {
  writeReviewArtifact('P5-003_FAULT_TRACES.json', {
    schema_version: 1,
    evidence: 'APPLICATION_FAULT_FIXTURES',
    os_identity_separation: 'NOT_VERIFIED',
    traces,
  });
  expect(traces).toHaveLength(checkpoints.length);
});

for (const error of ['ENOSPC', 'EACCES'])
  it(`preserves unproven work and safely retries ${error} during staging`, () => {
    const f = fixture();
    faults.io = error;
    expect(() => commit(f)).toThrow();
    expect(existsSync(f.destination)).toBe(false);
    settle(f);
  });
it('refuses a destination substituted immediately before publication and preserves user content', () => {
  const f = fixture();
  faults.effect = (point) => {
    if (point === 'before_publish_rename') {
      faults.effect = null;
      mkdirSync(f.destination);
      writeFileSync(join(f.destination, 'user-owned'), 'preserve');
    }
  };
  expect(() => commit(f)).toThrow();
  expect(readFileSync(join(f.destination, 'user-owned'), 'utf8')).toBe('preserve');
  expect(() => commit(f)).toThrow();
});
it('rejects tampered journal content at recovery even after guard corruption by a fixture database owner', () => {
  const f = fixture();
  faults.at = 'stage_recorded';
  expect(() => commit(f)).toThrow();
  f.db.exec('DROP TRIGGER distribution_intent_binding');
  f.db.exec("UPDATE skill_distribution_intents SET manifest_hash='invalid'");
  expect(() => commit(f)).toThrow();
  expect(existsSync(f.destination)).toBe(false);
});
it('does not permit operation IDs, paths, versions, or forged operators to select publication authority', () => {
  const f = fixture();
  for (const extra of [
    { operation_id: randomUUID() },
    { destination: '/tmp/foreign' },
    { operator_uid: 501 },
    { version_id: f.candidate.version.id },
  ])
    expect(() => f.service.plan({ ...f.request, ...extra })).toThrow();
});

it('does not create intent/files while SQLite is locked and safely retries after release', () => {
  const f = fixture(),
    other = new Database(f.path);
  f.db.pragma('busy_timeout=1');
  try {
    other.exec('BEGIN IMMEDIATE');
    expect(() => commit(f)).toThrow();
    expect(existsSync(f.destination)).toBe(false);
    other.exec('ROLLBACK');
    settle(f);
  } finally {
    other.close();
  }
});
it('validates resource paths before materialization even for internal callers', () => {
  const f = fixture();
  faults.at = 'stage_recorded';
  expect(() => commit(f)).toThrow();
  const intent = f.db
    .prepare("SELECT manifest_json FROM skill_distribution_intents WHERE status='pending'")
    .get() as { manifest_json: string };
  const bad = join(f.root, 'invalid-stage');
  expect(() =>
    materializePackage(
      f.root,
      bad,
      [
        { path: 'SKILL.md', content: 'data' },
        { path: '../escape.md', content: 'escape' },
      ],
      JSON.parse(intent.manifest_json),
    ),
  ).toThrow();
  expect(existsSync(bad)).toBe(false);
  expect(existsSync(join(f.root, 'escape.md'))).toBe(false);
});
it('rejects a FIFO manifest without blocking the host reader', () => {
  const f = fixture();
  commit(f);
  const file = join(f.destination, '.agentmind-install.json');
  rmSync(file);
  const mk = spawnSync('/usr/bin/mkfifo', [file], { timeout: 1000 });
  expect(mk.status).toBe(0);
  expect(inspectPackage(f.destination).status).toBe('unsafe');
  expect(f.service.plan(f.request).entries[0]?.action).toBe('CONFLICT');
});
it('keeps warm discovery and version-pinned retrieval consistent across publication, rollback and deactivation', () => {
  const f = fixture();
  migrateRetrieval(f.db);
  const retrieval = new SkillRetrievalService(f.db, f.scope),
    task = { context: { summary: 'Harmless local distribution guidance' } };
  expect(retrieval.route(task).skills[0]?.active_version_id).toBe(f.candidate.version.id);
  expect(retrieval.route(task).diagnostics.cache_hit).toBe(true);
  const v = replacement(f);
  commit(f);
  expect(retrieval.route(task).skills[0]?.active_version_id).toBe(v.version.id);
  expect(() =>
    retrieval.load({
      skill_id: f.candidate.identity.id,
      expected_version_id: f.candidate.version.id,
    }),
  ).toThrow();
  f.promote(f.candidate.version.id, 'rollback');
  commit(f);
  expect(retrieval.route(task).skills[0]?.active_version_id).toBe(f.candidate.version.id);
  expect(inspectPackage(f.destination)).toMatchObject({
    content_digest: f.candidate.version.content_hash,
  });
  f.transition(f.candidate.identity.id, null, 'deactivate');
  expect(retrieval.route(task).skills).toEqual([]);
  expect(() => retrieval.load({ skill_id: f.candidate.identity.id })).toThrow();
});

it('does not retain the old native copy when its source is revoked during interrupted replacement', () => {
  const f = fixture();
  replacement(f);
  faults.at = 'stage_recorded';
  expect(() => commit(f)).toThrow();
  expect(existsSync(f.destination)).toBe(true);
  const source = f.experiences.inspect(f.approvedSource.id);
  f.experiences.review({
    id: source.id,
    expected_updated_at: source.updated_at,
    decision: 'rejected',
    reviewer: 'synthetic-reviewer',
    reason: 'Disposable revoked source',
  });
  commit(f);
  expect(existsSync(f.destination)).toBe(false);
  expect(f.service.plan(f.request).entries[0]?.action).toBe('CONFLICT');
});

for (const point of ['stage_recorded', 'before_publish_rename'])
  it(`F01 rejects staged tampering at ${point} before native publication`, () => {
    const f = fixture();
    faults.effect = (name) => {
      if (name === point) {
        faults.effect = null;
        const row = f.db
          .prepare("SELECT id FROM skill_distribution_intents WHERE status='pending'")
          .get() as { id: string };
        writeFileSync(
          join(f.root, '.agentmind', 'distribution-v1', `${row.id}.stage`, 'SKILL.md'),
          'TAMPERED',
        );
      }
    };
    expect(() => commit(f)).toThrow();
    expect(existsSync(f.destination)).toBe(false);
    commit(f);
    commit(f);
    expect(inspectPackage(f.destination)).toMatchObject({
      content_digest: f.candidate.version.content_hash,
    });
  });
it('F01 quarantines a known failed publication instead of leaving it live or deadlocking recovery', () => {
  const f = fixture();
  faults.effect = (name) => {
    if (name === 'after_publish_rename') {
      faults.effect = null;
      writeFileSync(join(f.destination, 'SKILL.md'), 'TAMPERED AFTER RENAME');
    }
  };
  expect(() => commit(f)).toThrow();
  expect(existsSync(f.destination)).toBe(false);
  const row = f.db
    .prepare("SELECT id FROM skill_distribution_intents WHERE status='pending'")
    .get() as { id: string };
  expect(existsSync(join(f.root, '.agentmind', 'distribution-v1', `${row.id}.corrupt`))).toBe(true);
  commit(f);
  settle(f);
});
it('F01 recovers an older corrupt published directory only when the stamped inode proves its identity', () => {
  const f = fixture();
  faults.at = 'after_registry_commit';
  expect(() => commit(f)).toThrow();
  writeFileSync(join(f.destination, 'SKILL.md'), 'old failed publication');
  commit(f);
  expect(existsSync(f.destination)).toBe(false);
  settle(f);
});
for (const point of ['after_recovery_commit', 'before_cleanup'])
  it(`F02 preserves the committed abort across recovery interruption at ${point}`, () => {
    const f = fixture();
    replacement(f);
    faults.at = 'stage_recorded';
    expect(() => commit(f)).toThrow();
    faults.at = point;
    expect(() => commit(f)).toThrow();
    expect(existsSync(f.destination)).toBe(false);
    const decision = f.db
      .prepare('SELECT intent_id,outcome FROM distribution_recovery_decisions')
      .get() as { intent_id: string; outcome: string };
    expect(decision.outcome).toBe('ABORTED_UNPUBLISHED');
    commit(f);
    expect(existsSync(f.destination)).toBe(false);
    expect(
      f.db
        .prepare(
          "SELECT COUNT(*) AS n FROM skill_distribution_events WHERE intent_id=? AND outcome='RECOVERY_STATE_COMMITTED'",
        )
        .get(decision.intent_id),
    ).toEqual({ n: 1 });
    expect(() =>
      f.db.exec("UPDATE distribution_recovery_decisions SET outcome='RECOVERED_INSTALL'"),
    ).toThrow(/immutable/);
    settle(f);
  });
it('F03 records normal action completions and null installed identity for removal', () => {
  const f = fixture();
  commit(f);
  replacement(f);
  commit(f);
  f.service.commit({ ...f.request, operation: 'remove' }, {});
  const rows = f.db
    .prepare(
      "SELECT action,version_id,installed_digest FROM skill_distribution_events WHERE outcome='COMPLETED'",
    )
    .all() as { action: string; version_id: string | null; installed_digest: string | null }[];
  expect(rows.map((r) => r.action)).toContain('INSTALL');
  expect(rows.map((r) => r.action)).toContain('UPDATE');
  expect(rows.at(-1)).toEqual({ action: 'REMOVE', version_id: null, installed_digest: null });
});
it('F07 lists only previously active rollback targets with current eligibility', () => {
  const f = fixture();
  expect(f.service.rollbackPlan({ skill_id: f.candidate.identity.id }).targets).toEqual([]);
  replacement(f);
  const plan = f.service.rollbackPlan({ skill_id: f.candidate.identity.id });
  expect(plan.targets).toContainEqual({
    version_id: f.candidate.version.id,
    digest: f.candidate.version.content_hash,
    eligibility: 'ELIGIBLE',
  });
});

it('F01/F02 removes known corrupt live content even while finalizing a previously committed successful recovery', () => {
  const f = fixture();
  faults.at = 'after_registry_commit';
  expect(() => commit(f)).toThrow();
  faults.at = 'after_recovery_commit';
  expect(() => commit(f)).toThrow();
  writeFileSync(join(f.destination, 'SKILL.md'), 'CORRUPTION AFTER RECOVERY COMMIT');
  commit(f);
  expect(existsSync(f.destination)).toBe(false);
  const row = f.db.prepare('SELECT outcome FROM distribution_recovery_decisions').get();
  expect(row).toEqual({ outcome: 'RECOVERED_PUBLISHED' });
  expect(
    f.db
      .prepare("SELECT COUNT(*) AS n FROM skill_distribution_intents WHERE status='pending'")
      .get(),
  ).toEqual({ n: 0 });
  settle(f);
});

for (const point of ['after_recovery_commit', 'before_cleanup'])
  for (const change of ['revoke', 'rollback', 'deactivate'])
    it(`F09 terminally resolves ${change} after committed recovery interrupted at ${point}`, () => {
      const f = fixture();
      replacement(f);
      faults.at = 'after_registry_commit';
      expect(() => commit(f)).toThrow();
      faults.at = point;
      expect(() => commit(f)).toThrow();
      if (change === 'rollback') f.promote(f.candidate.version.id, 'rollback');
      else if (change === 'deactivate') f.transition(f.candidate.identity.id, null, 'deactivate');
      else {
        const e = f.experiences.inspect(f.approvedSource.id);
        f.experiences.review({
          id: e.id,
          expected_updated_at: e.updated_at,
          decision: 'rejected',
          reviewer: 'fixture',
          reason: 'Post-decision revocation',
        });
      }
      const r = commit(f);
      expect(r.outcome).toBe('REPLAN_REQUIRED');
      expect(existsSync(f.destination)).toBe(false);
      expect(
        f.db
          .prepare("SELECT COUNT(*) AS n FROM skill_distribution_intents WHERE status='pending'")
          .get(),
      ).toEqual({ n: 0 });
      if (change === 'rollback') {
        settle(f);
        expect(inspectPackage(f.destination)).toMatchObject({
          content_digest: f.candidate.version.content_hash,
        });
      } else f.service.commit({ ...f.request, operation: 'remove' }, {});
    });
it('F09 retries an abort resolution after a second crash without restoring the stale package', () => {
  const f = fixture();
  faults.at = 'after_registry_commit';
  expect(() => commit(f)).toThrow();
  faults.at = 'after_recovery_commit';
  expect(() => commit(f)).toThrow();
  f.transition(f.candidate.identity.id, null, 'deactivate');
  faults.at = 'after_resolution_commit';
  expect(() => commit(f)).toThrow();
  expect(existsSync(f.destination)).toBe(false);
  commit(f);
  f.service.commit({ ...f.request, operation: 'remove' }, {});
  expect(
    f.db
      .prepare("SELECT COUNT(*) AS n FROM skill_distribution_intents WHERE status='pending'")
      .get(),
  ).toEqual({ n: 0 });
  expect(() =>
    f.db.exec("UPDATE distribution_recovery_resolutions SET outcome='RECOVERED_INSTALL'"),
  ).toThrow(/immutable/);
});
it('F09 withdraws a retained old copy if it becomes revoked after an abort decision committed', () => {
  const f = fixture();
  replacement(f);
  faults.at = 'stage_recorded';
  expect(() => commit(f)).toThrow();
  f.promote(f.candidate.version.id, 'rollback');
  faults.at = 'after_recovery_commit';
  expect(() => commit(f)).toThrow();
  expect(existsSync(f.destination)).toBe(true);
  f.transition(f.candidate.identity.id, null, 'deactivate');
  commit(f);
  expect(existsSync(f.destination)).toBe(false);
  f.service.commit({ ...f.request, operation: 'remove' }, {});
});
it('F09 preserves a user-substituted destination instead of abort-cleaning an unknown inode', () => {
  const f = fixture();
  faults.at = 'after_registry_commit';
  expect(() => commit(f)).toThrow();
  faults.at = 'after_recovery_commit';
  expect(() => commit(f)).toThrow();
  rmSync(f.destination, { recursive: true });
  mkdirSync(f.destination);
  writeFileSync(join(f.destination, 'user-data'), 'preserve');
  expect(() => commit(f)).toThrow();
  expect(readFileSync(join(f.destination, 'user-data'), 'utf8')).toBe('preserve');
});
it('F10 prioritizes recent historical promotions beyond fifty distinct versions', () => {
  const f = fixture();
  f.transition(f.candidate.identity.id, null, 'deactivate');
  const versions = [];
  for (let i = 0; i < 52; i++) {
    const p = f.propose(`History version ${i}`);
    f.evaluate(p.version.id);
    f.approve(p.version.id);
    f.promote(p.version.id);
    f.transition(p.identity.id, null, 'deactivate');
    versions.push(p);
  }
  const latest = versions.at(-1);
  if (!latest) throw Error('fixture');
  f.promote(latest.version.id, 'rollback');
  const plan = f.service.rollbackPlan({ skill_id: f.candidate.identity.id });
  expect(plan.truncated).toBe(true);
  expect(plan.targets[0]?.version_id).toBe(versions.at(-2)?.version.id);
}, 20000);

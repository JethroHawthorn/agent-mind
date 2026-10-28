import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ publisher: null as unknown, fail: false }));
vi.mock('../../packages/core/src/broker/publication.js', () => ({
  publicationService: () => state.publisher,
}));

import {
  AgentMindError,
  BrokerService,
  validateBrokerConfig,
} from '../../packages/core/src/index.js';
import { distributionFixture } from '../helpers/distribution-fixture.js';

const clean: Array<() => void> = [];
afterEach(() => {
  state.fail = false;
  for (const f of clean.splice(0)) f();
});
/** Protocol/audit tests mock only the publisher boundary; no OS protection or real approval claimed. */
function fixture() {
  const f = distributionFixture();
  clean.push(f.close);
  state.publisher = {
    plan: (input: unknown) => ({ ...f.service.plan(input), entries: [] }),
    history: (input: unknown) => f.service.history(input),
    rollbackPlan: (input: unknown, validator?: (id: string) => void) =>
      f.service.rollbackPlan(input, validator),
    commit: () => {
      if (state.fail)
        throw new AgentMindError(
          'DISTRIBUTION_RECOVERY_REQUIRED',
          'Fixture partial publisher result',
        );
      return { outcome: 'COMPLETE' };
    },
  };
  const config = validateBrokerConfig({
    schema_version: 1,
    broker_uid: 201,
    runtime_root: f.root,
    registry_directory: f.root,
    socket_directory: f.root,
    projects: [
      {
        name: 'a',
        root: f.root,
        scope_id: f.scope.id,
        distribution_home: f.home,
        distribution: 'protected',
        publication: { root: join(f.root, 'pub'), gid: 300 },
      },
    ],
    agents: [{ uid: 203, project: 'a', source: 'codex' }],
    operators: [{ uid: 202, projects: ['a'] }],
  });
  const broker = new BrokerService(f.db, config);
  const request = (op: string, input: unknown, channel: 'agent' | 'operator' = 'operator') =>
    broker.handle(
      channel,
      { uid: channel === 'operator' ? 202 : 203, gid: 20 },
      { schema_version: 1, project: 'a', op, input },
    );
  const prepare = () =>
    request('operator_prepare', { kind: 'distribution', request: f.request }) as {
      challenge_id: string;
      digest: string;
    };
  const commit = (p: ReturnType<typeof prepare>) =>
    request('operator_commit', { challenge_id: p.challenge_id, review_digest: p.digest });
  return { ...f, request, prepare, commit };
}
it('F05 binds broker distribution audits to the exact candidate digest and evaluation', () => {
  const f = fixture(),
    p = f.prepare();
  f.commit(p);
  const rows = f.db
    .prepare(
      'SELECT s.version_id,s.content_digest,s.evaluation_id FROM broker_security_events s WHERE request_id=?',
    )
    .all(p.challenge_id) as { version_id: string; content_digest: string; evaluation_id: string }[];
  expect(rows.length).toBeGreaterThan(1);
  for (const r of rows) {
    expect(r.version_id).toBe(f.candidate.version.id);
    expect(r.content_digest).toBe(f.candidate.version.content_hash);
    expect(r.evaluation_id).toBeTruthy();
  }
});
it('F05 records recovery-required execution as partial rather than authorization denial', () => {
  const f = fixture(),
    p = f.prepare();
  state.fail = true;
  expect(() => f.commit(p)).toThrow(/partial/);
  const row = f.db
    .prepare(
      'SELECT a.result,s.failure_code,s.version_id,s.content_digest FROM broker_audit a JOIN broker_security_events s ON s.audit_id=a.id WHERE s.request_id=? ORDER BY a.rowid DESC LIMIT 1',
    )
    .get(p.challenge_id);
  expect(row).toMatchObject({
    result: 'partial_or_recovery_required',
    failure_code: 'PARTIAL_OR_RECOVERY_REQUIRED',
    version_id: f.candidate.version.id,
    content_digest: f.candidate.version.content_hash,
  });
});
it('F07 permits scoped operator history/rollback reads while denying the agent channel', () => {
  const f = fixture();
  expect(f.request('distribution_history', { skill_id: f.candidate.identity.id })).toMatchObject({
    skill_id: f.candidate.identity.id,
  });
  expect(
    f.request('distribution_rollback_plan', { skill_id: f.candidate.identity.id }),
  ).toMatchObject({ targets: [] });
  for (const op of ['distribution_plan', 'distribution_history', 'distribution_rollback_plan'])
    expect(() => f.request(op, { skill_id: f.candidate.identity.id }, 'agent')).toThrow();
});

it('F10 keeps broker distribution_verify read-only and avoids daemon-local audit attribution', () => {
  const f = fixture(),
    before = f.db.prepare('SELECT total_changes() AS n').get();
  f.request('distribution_verify', {
    skill_id: f.candidate.identity.id,
    target: 'codex',
    scope: 'project',
  });
  expect(f.db.prepare('SELECT total_changes() AS n').get()).toEqual(before);
});
it('F10 broker rollback inspection rejects an otherwise eligible historical version without protected approval', () => {
  const f = fixture();
  f.transition(f.candidate.identity.id, null, 'deactivate');
  const next = f.propose('Later version');
  f.evaluate(next.version.id);
  f.approve(next.version.id);
  f.promote(next.version.id);
  const result = f.request('distribution_rollback_plan', { skill_id: f.candidate.identity.id }) as {
    targets: { version_id: string; eligibility: string }[];
  };
  expect(result.targets.find((t) => t.version_id === f.candidate.version.id)?.eligibility).toBe(
    'BROKER_DENIED',
  );
});

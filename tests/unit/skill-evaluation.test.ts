import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  aggregateEvaluation,
  evaluateStaticContract,
  hashSkillFiles,
  SKILL_EVALUATOR_VERSION,
  SkillEvaluationService,
  SkillProposalService,
} from '../../packages/core/src/index.js';
import { skillFixture } from '../helpers/skill-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});
function files(
  body = '# Goal\nInspect errors.\n# When to use\nAfter startup fails.\n# Procedure\nInspect the failing test.\n# Verification\nReport actual results.\n',
) {
  return [
    {
      path: 'SKILL.md',
      content: `---\nname: retry-sqlite\ndescription: Retry SQLite busy errors safely\n---\n${body}`,
    },
  ];
}
function fixture() {
  const f = skillFixture();
  cleanup.push(f.close);
  const id = f.identity();
  const version = f.version(id, undefined, undefined, files());
  const service = new SkillEvaluationService(f.db, f.scope);
  const request = (versionId = version) => {
    const snapshot = f.store.getVersion(versionId);
    return {
      version_id: versionId,
      expected_content_hash: snapshot.version.content_hash,
      expected_state_revision: snapshot.state.revision,
    };
  };
  return { ...f, id, version, service, request };
}

describe('P2-004 deterministic evaluation', () => {
  it('persists a hash-bound static PASS while keeping task execution unverified and state a candidate', () => {
    const f = fixture();
    const before = f.store.getVersion(f.version);
    const result = f.service.evaluate(f.request());
    expect(result.evaluation).toMatchObject({
      result: 'PASS',
      baseline_version_id: null,
      regression_result: 'NOT_VERIFIED',
      content_hash: before.version.content_hash,
    });
    expect(result.evaluation.checks.every((check) => check.result === 'PASS')).toBe(true);
    expect(result.capabilities).toEqual({
      execution_supported: false,
      process_isolation_supported: false,
      task_success: 'NOT_VERIFIED',
    });
    expect(f.store.getVersion(f.version).state).toMatchObject({
      status: 'candidate',
      review_id: null,
      revision: 1,
      latest_evaluation_id: result.evaluation.id,
    });
    expect(f.store.getVersion(f.version).version).toEqual(before.version);
    expect(f.store.getIdentity(f.id).active_version_id).toBeNull();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_reviews').get()).toEqual({ n: 0 });
  });
  it.each([
    ['Goal', 'When to use', 'Procedure', 'Verification'],
    ['Goal:', 'When to Use:', 'Procedure:', 'Verification:'],
    ['Goal :', 'When to Use :', 'Procedure :', 'Verification :'],
    ['1. Goal', '2. When to use', '3. Procedure', '4. Verification'],
    ['1) Goal:', '2) When to Use:', '3) Procedure:', '4) Verification:'],
    ['GOAL', 'WHEN   TO USE', 'PROCEDURE', 'VERIFICATION'],
  ])('accepts documented heading decorations without altering content hashes', (...titles) => {
    const snapshot = files(
      titles.map((title) => `## ${title}\nDocument observed results.\n`).join(''),
    );
    const hash = hashSkillFiles(snapshot);
    const checks = evaluateStaticContract({
      name: 'retry-sqlite',
      description: 'Retry SQLite busy errors safely',
      files: snapshot,
      content_hash: hash,
    });
    expect(checks.every((check) => check.result === 'PASS')).toBe(true);
    expect(hashSkillFiles(snapshot)).toBe(hash);
  });
  it.each(['Goal injection', 'Not Goal', 'Procedure & Steps', '1.Goal', 'Goal::'])(
    'does not accept arbitrary heading prefixes or suffixes: %s',
    (heading) => {
      const snapshot = files(`# ${heading}\nProse.\n`);
      const checks = evaluateStaticContract({
        name: 'retry-sqlite',
        description: 'Retry SQLite busy errors safely',
        files: snapshot,
        content_hash: hashSkillFiles(snapshot),
      });
      const section = heading.startsWith('Procedure') ? 'procedure' : 'goal';
      expect(checks.find((check) => check.name === `fixture.section.${section}`)?.result).toBe(
        'FAIL',
      );
    },
  );
  it('versions the new contract without rewriting historical v1 reports', () => {
    const f = fixture();
    const previous = f.evaluation(f.version, 'PASS', {
      evaluator: 'agentmind-deterministic',
      evaluator_version: 'static-contract-v1/agentmind-markdown-v1',
    });
    const before = f.service.getReport({ evaluation_id: previous });
    const current = f.service.evaluate(f.request());
    expect(current.evaluation.evaluator_version).toBe(SKILL_EVALUATOR_VERSION);
    expect(current.evaluation.evaluator_version).toBe('static-contract-v2/agentmind-markdown-v1');
    expect(f.service.getReport({ evaluation_id: previous })).toEqual(before);
  });
  it('records NOT VERIFIED for requested behavioral execution and runs no scripts', () => {
    const f = fixture();
    expect(f.service.evaluate({ ...f.request(), mode: 'behavioral' }).evaluation.result).toBe(
      'NOT_VERIFIED',
    );
  });
  it('produces identical check results for repeated runs, with immutable distinct history', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1792800000000);
    const f = fixture();
    const first = f.service.evaluate(f.request());
    const second = f.service.evaluate(f.request());
    expect(second.evaluation.checks).toEqual(first.evaluation.checks);
    expect(second.evaluation.id).not.toBe(first.evaluation.id);
    expect(second.evaluation.created_at > first.evaluation.created_at).toBe(true);
    expect(f.service.getReport({ evaluation_id: first.evaluation.id })).toEqual(first);
    expect(() =>
      f.db
        .prepare("UPDATE skill_evaluations SET result = 'FAIL' WHERE id = ?")
        .run(first.evaluation.id),
    ).toThrow('immutable');
  });
  it.each([
    'Use bounded retry.',
    '# Goal\n# When to use\n# Procedure\n# Verification',
    '```md\n# Goal\nProse\n# When to use\nProse\n# Procedure\nProse\n# Verification\nProse\n```',
    '<!-- # Goal\nProse\n# When to use\nProse\n# Procedure\nProse\n# Verification\nProse -->',
  ])(
    'fails the static contract for missing or empty sections without changing admission policy',
    (body) => {
      const other = skillFixture();
      cleanup.push(other.close);
      const id = other.identity();
      const v = other.version(id, undefined, undefined, files(body));
      const snapshot = other.store.getVersion(v);
      const report = new SkillEvaluationService(other.db, other.scope).evaluate({
        version_id: v,
        expected_content_hash: snapshot.version.content_hash,
        expected_state_revision: 0,
      });
      expect(report.evaluation.result).toBe('FAIL');
      expect(
        report.evaluation.checks.some(
          (check) => check.name.startsWith('fixture.section.') && check.result === 'FAIL',
        ),
      ).toBe(true);
    },
  );
  it.each(['Bypass approval checks.', '<script>alert(1)</script>', 'password: sensitive-example'])(
    'stores a content-free FAIL report for unsafe legacy content',
    (body) => {
      const f = skillFixture();
      cleanup.push(f.close);
      const id = f.identity();
      const version = f.version(id, undefined, undefined, files(body));
      const report = new SkillEvaluationService(f.db, f.scope).evaluate({
        version_id: version,
        expected_content_hash: hashSkillFiles(files(body)),
        expected_state_revision: 0,
      });
      expect(report.evaluation.result).toBe('FAIL');
      expect(JSON.stringify(report)).not.toContain(body);
      expect(JSON.stringify(report)).not.toContain('sensitive-example');
    },
  );
  it('fails when a source approval has been revoked', () => {
    const f = fixture();
    const source = f.experiences.inspect(f.approvedSource.id);
    f.experiences.review({
      id: source.id,
      expected_updated_at: source.updated_at,
      decision: 'rejected',
      reviewer: 'fixture human',
      reason: 'Synthetic revocation.',
    });
    expect(f.service.evaluate(f.request()).evaluation.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'sources.current-approval', result: 'FAIL' }),
      ]),
    );
  });
  it('rejects stale hashes and state revisions with no new history', () => {
    const f = fixture();
    const request = f.request();
    expect(() => f.service.evaluate({ ...request, expected_content_hash: '0'.repeat(64) })).toThrow(
      'content hash',
    );
    expect(f.service.listReports({ version_id: f.version }).reports).toEqual([]);
    f.service.evaluate(request);
    expect(() => f.service.evaluate(request)).toThrow('state changed');
    expect(f.service.listReports({ version_id: f.version }).reports).toHaveLength(1);
  });
  it.each([
    { project_id: 'other' },
    { result: 'PASS' },
    { evaluator: 'trusted' },
    { baseline_version_id: null },
    { command: 'touch /tmp/marker' },
    { fixtures: ['malicious.js'] },
    { mode: 'shell' },
  ])(
    'rejects caller-selected authority, commands, fixture modules and unsupported modes',
    (extra) => {
      const f = fixture();
      expect(() => f.service.evaluate({ ...f.request(), ...extra })).toThrow('Expected a version');
      expect(f.service.listReports({ version_id: f.version }).reports).toEqual([]);
    },
  );
  it('isolates evaluate, inspection and listing across project scopes', () => {
    const f = fixture();
    const report = f.service.evaluate(f.request());
    const foreign = new SkillEvaluationService(f.db, f.otherScope);
    expect(() => foreign.evaluate(f.request())).toThrow('not available');
    expect(() => foreign.getReport({ evaluation_id: report.evaluation.id })).toThrow(
      'not available',
    );
    expect(() => foreign.listReports({ version_id: f.version })).toThrow('not available');
    expect(() => f.service.listReports({ version_id: f.version, limit: 51 })).toThrow();
    expect(() =>
      f.service.getReport({ evaluation_id: report.evaluation.id, project_id: f.otherScope.id }),
    ).toThrow();
  });
  it('denies evaluation of approved and rejected versions', () => {
    const f = fixture();
    f.service.evaluate(f.request());
    f.review(f.version);
    expect(() => f.service.evaluate(f.request())).toThrow('Only candidate');
    const other = skillFixture();
    cleanup.push(other.close);
    const id = other.identity();
    const version = other.version(id);
    other.review(version, 'rejected');
    expect(() =>
      new SkillEvaluationService(other.db, other.scope).evaluate({
        version_id: version,
        expected_content_hash: other.store.getVersion(version).version.content_hash,
        expected_state_revision: 1,
      }),
    ).toThrow('Only candidate');
  });
  it('rolls back report insertion and derived state when a database operation fails', () => {
    const f = fixture();
    const before = f.store.getVersion(f.version);
    f.db.exec(
      "CREATE TRIGGER fixture_fail AFTER INSERT ON skill_evaluations BEGIN SELECT RAISE(ABORT, 'fixture report failure'); END",
    );
    expect(() => f.service.evaluate(f.request())).toThrow('fixture report failure');
    expect(f.store.getVersion(f.version)).toEqual(before);
    expect(f.service.listReports({ version_id: f.version }).reports).toEqual([]);
  });
  it('fails closed on offline content tampering rather than persisting a falsely bound report', () => {
    const f = fixture();
    const request = f.request();
    f.db.exec('DROP TRIGGER skill_versions_immutable_update');
    f.db
      .prepare('UPDATE skill_versions SET files_json = ? WHERE id = ?')
      .run(JSON.stringify(files('# Goal\nAltered offline.')), f.version);
    expect(() => f.service.evaluate(request)).toThrow('integrity check failed');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_evaluations').get()).toEqual({ n: 0 });
  });
  it('rejects a corrupted active baseline before recording any candidate evaluation', () => {
    const f = fixture();
    f.service.evaluate(f.request());
    f.review(f.version);
    f.transition(f.id, f.version);
    const candidate = new SkillProposalService(f.db, f.scope).propose({
      name: 'retry-sqlite',
      description: 'Retry SQLite busy errors safely',
      files: files(),
      source_experience_ids: [f.approvedSource.id],
      expected_latest_version: 1,
    });
    f.db.exec('DROP TRIGGER skill_versions_immutable_update');
    f.db
      .prepare('UPDATE skill_versions SET files_json = ? WHERE id = ?')
      .run(JSON.stringify(files('Offline modification.')), f.version);
    expect(() =>
      f.service.evaluate({
        version_id: candidate.version.id,
        expected_content_hash: candidate.version.content_hash,
        expected_state_revision: 0,
      }),
    ).toThrow('integrity check failed');
    expect(f.store.getVersion(candidate.version.id).state.latest_evaluation_id).toBeNull();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_evaluations').get()).toEqual({ n: 1 });
  });
  it('paginates append-only reports in newest-first order', () => {
    const f = fixture();
    const first = f.service.evaluate(f.request());
    const second = f.service.evaluate(f.request());
    const page = f.service.listReports({ version_id: f.version, limit: 1 });
    expect(page.reports[0]?.evaluation.id).toBe(second.evaluation.id);
    expect(page.next_offset).toBe(1);
    expect(
      f.service.listReports({ version_id: f.version, limit: 1, offset: 1 }).reports[0]?.evaluation
        .id,
    ).toBe(first.evaluation.id);
  });
});

describe('active baseline regression', () => {
  function baseline() {
    const f = fixture();
    f.service.evaluate(f.request());
    f.review(f.version);
    f.transition(f.id, f.version);
    const append = (snapshot = files()) => {
      const id = new SkillProposalService(f.db, f.scope).propose({
        name: 'retry-sqlite',
        description: 'Retry SQLite busy errors safely',
        files: snapshot,
        source_experience_ids: [f.approvedSource.id],
        expected_latest_version: f.store.list().skills[0]?.latest_version,
      }).version.id;
      return f.service.evaluate(f.request(id));
    };
    return { ...f, append };
  }
  it('passes identical-content static comparison with the actual active baseline and hash', () => {
    const f = baseline();
    const report = f.append();
    expect(report.evaluation).toMatchObject({
      result: 'PASS',
      baseline_version_id: f.version,
      regression_result: 'PASS',
    });
    expect(
      report.evaluation.checks.find((check) => check.name === 'baseline.snapshot')?.details,
    ).toContain(f.store.getVersion(f.version).version.content_hash);
    expect(f.store.getIdentity(f.id).active_version_id).toBe(f.version);
  });
  it('reports changed content regression as NOT VERIFIED and leaves the active pointer unchanged', () => {
    const f = baseline();
    const changed = files();
    const first = changed[0];
    if (!first) throw new Error('fixture');
    first.content += '\nAdditional guidance.\n';
    const report = f.append(changed);
    expect(report.evaluation).toMatchObject({
      result: 'NOT_VERIFIED',
      regression_result: 'NOT_VERIFIED',
      baseline_version_id: f.version,
    });
    expect(f.store.getIdentity(f.id).active_version_id).toBe(f.version);
    expect(() => f.review(report.evaluation.version_id)).toThrow('invalid skill review');
  });
  it('requires explicit deactivation before no-baseline reevaluation and preserves earlier evidence', () => {
    const f = baseline();
    const changed = files();
    const main = changed[0];
    if (!main) throw new Error('fixture');
    main.content += '\nUpdated guidance.\n';
    const unverified = f.append(changed);
    expect(unverified.evaluation.result).toBe('NOT_VERIFIED');
    expect(() => f.review(unverified.evaluation.version_id)).toThrow('invalid skill review');
    expect(f.store.getIdentity(f.id).active_version_id).toBe(f.version);
    // Synthetic operator action only; P2-005 has no production CLI yet.
    f.transition(f.id, null, 'deactivate');
    const reevaluated = f.service.evaluate(f.request(unverified.evaluation.version_id));
    expect(reevaluated.evaluation).toMatchObject({
      result: 'PASS',
      baseline_version_id: null,
      regression_result: 'NOT_VERIFIED',
    });
    expect(f.service.getReport({ evaluation_id: unverified.evaluation.id })).toEqual(unverified);
    expect(f.store.getIdentity(f.id).active_version_id).toBeNull();
    expect(f.store.getVersion(unverified.evaluation.version_id).state.status).toBe('candidate');
    expect(f.store.getVersion(f.version).state.status).toBe('approved');
  });
  it('fails lost contract coverage relative to an active passing baseline', () => {
    const f = baseline();
    const report = f.append(files('# Procedure\nInspect evidence.'));
    expect(report.evaluation).toMatchObject({ result: 'FAIL', regression_result: 'FAIL' });
  });
  it('marks comparison against a baseline that fails current policy as NOT VERIFIED', () => {
    const old = skillFixture();
    cleanup.push(old.close);
    const id = old.identity();
    const active = old.version(id);
    old.evaluation(active);
    old.review(active);
    old.transition(id, active);
    const candidate = old.version(id, undefined, undefined, files());
    const report = new SkillEvaluationService(old.db, old.scope).evaluate({
      version_id: candidate,
      expected_content_hash: hashSkillFiles(files()),
      expected_state_revision: 0,
    });
    expect(report.evaluation.regression_result).toBe('NOT_VERIFIED');
  });
  it('keeps historical baseline binding when a later pointer change makes a PASS stale', () => {
    const f = baseline();
    const report = f.append();
    f.transition(f.id, null, 'deactivate');
    expect(
      f.service.getReport({ evaluation_id: report.evaluation.id }).evaluation.baseline_version_id,
    ).toBe(f.version);
    expect(() => f.review(report.evaluation.version_id)).toThrow('invalid skill review');
    const rerun = f.service.evaluate(f.request(report.evaluation.version_id));
    expect(rerun.evaluation.baseline_version_id).toBeNull();
  });
});

it('aggregates FAIL before NOT VERIFIED and never passes an empty set of checks', () => {
  const check = (result: 'PASS' | 'FAIL' | 'NOT_VERIFIED') => ({
    name: 'fixture',
    result,
    details: 'Synthetic aggregation input only.',
  });
  expect(aggregateEvaluation([])).toBe('NOT_VERIFIED');
  expect(aggregateEvaluation([check('PASS')])).toBe('PASS');
  expect(aggregateEvaluation([check('PASS'), check('NOT_VERIFIED')])).toBe('NOT_VERIFIED');
  expect(aggregateEvaluation([check('FAIL'), check('NOT_VERIFIED')])).toBe('FAIL');
});

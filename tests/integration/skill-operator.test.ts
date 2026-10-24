import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SkillEvaluationService,
  SkillOperatorService,
  SkillProposalService,
  SkillReviewService,
} from '../../packages/core/src/index.js';
import { operatorTTY } from '../helpers/operator-pty.js';
import { skillFixture } from '../helpers/skill-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture() {
  const f = skillFixture();
  cleanup.push(f.close);
  const proposals = new SkillProposalService(f.db, f.scope);
  const evaluations = new SkillEvaluationService(f.db, f.scope);
  const propose = (body = '') =>
    proposals.propose({
      name: 'retry-sqlite',
      description: 'Retry SQLite startup safely',
      source_experience_ids: [f.approvedSource.id],
      expected_latest_version: (
        f.db
          .prepare('SELECT COALESCE(MAX(version),0) AS n FROM skill_versions WHERE project_id=?')
          .get(f.scope.id) as { n: number }
      ).n,
      files: [
        {
          path: 'SKILL.md',
          content: `---\nname: retry-sqlite\ndescription: Retry SQLite startup safely\n---\n# Goal\nInspect errors.\n# When to use\nWhen startup fails.\n# Procedure\nInspect the failure.\n# Verification\nReport observed results.\n${body}`,
        },
      ],
    });
  const candidate = propose();
  const evaluate = (version = candidate.version.id, mode: 'static' | 'behavioral' = 'static') => {
    const v = f.store.getVersion(version);
    return evaluations.evaluate({
      version_id: version,
      expected_content_hash: v.version.content_hash,
      expected_state_revision: v.state.revision,
      mode,
    });
  };
  const base = ['--project-root', f.root, '--db', f.path];
  const tty = (action: string, version = candidate.version.id) =>
    operatorTTY(f.root, [
      ...base,
      `--${action}`,
      version,
      '--reason',
      'Reviewed the exact local artifact.',
    ]);
  const apply = async (action: string, version = candidate.version.id, response = 'exact') => {
    const p = tty(action, version);
    const ready = await p.ready;
    if (ready.event === 'ready') p.respond(response);
    return p.exit;
  };
  return { ...f, candidate, propose, evaluate, base, tty, apply };
}
function success(reply: { status: number; output: string }) {
  expect(reply.status, reply.output.slice(-2500)).toBe(0);
}
function command(root: string, args: string[]) {
  return spawnSync(
    process.execPath,
    [resolve('packages/mcp-server/dist/skill-operator.js'), ...args],
    { cwd: root, encoding: 'utf8', timeout: 10000 },
  );
}

describe('P2-005 actual local terminal workflow (not human authentication)', () => {
  it('approves, promotes, updates through explicit deactivation, and restores a prior approved version', async () => {
    const f = fixture();
    f.evaluate();
    success(await f.apply('approve'));
    success(await f.apply('approve'));
    success(await f.apply('promote'));
    success(await f.apply('promote'));
    expect(f.store.getIdentity(f.candidate.identity.id).active_version_id).toBe(
      f.candidate.version.id,
    );
    const second = f.propose('Improved guidance.');
    expect(f.evaluate(second.version.id).evaluation.result).toBe('NOT_VERIFIED');
    const blocked = await f.apply('approve', second.version.id);
    expect(blocked.status).toBe(1);
    expect(blocked.output).toContain('EVALUATION_NOT_ELIGIBLE');
    success(await f.apply('deactivate'));
    f.evaluate(second.version.id);
    success(await f.apply('approve', second.version.id));
    success(await f.apply('promote', second.version.id));
    expect(() =>
      new SkillOperatorService(f.db, f.scope).commit(
        { action: 'rollback', version_id: f.candidate.version.id },
        {},
      ),
    ).toThrow('terminal confirmation');
    success(await f.apply('rollback'));
    success(await f.apply('rollback'));
    expect(f.store.getIdentity(f.candidate.identity.id).active_version_id).toBe(
      f.candidate.version.id,
    );
    const rows = f.db
      .prepare('SELECT * FROM skill_operator_events ORDER BY created_at')
      .all() as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.action)).toEqual([
      'approve',
      'promote',
      'deactivate',
      'approve',
      'promote',
      'rollback',
    ]);
    expect(
      rows.every(
        (r) =>
          r.authorization_method === 'local-tty-confirmation-v1' &&
          String(r.operator_id).startsWith('uid:'),
      ),
    ).toBe(true);
    expect(new Set(rows.map((r) => r.session_id)).size).toBe(rows.length);
    expect(JSON.parse(String(rows[0]?.metadata_json))).toMatchObject({
      from_version_id: null,
      to_version_id: null,
      same_uid_boundary: false,
    });
    expect(rows[0]).toMatchObject({
      version_id: f.candidate.version.id,
      content_hash: f.candidate.version.content_hash,
      evaluator_version: 'static-contract-v2/agentmind-markdown-v1',
    });
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
    expect(() => f.db.prepare("UPDATE skill_operator_events SET reason='altered'").run()).toThrow(
      'immutable',
    );
    expect(() => f.db.prepare('DELETE FROM skill_operator_events').run()).toThrow('immutable');
  });
  it('rejects piped approval, forged actor flags and every noninteractive privileged action', () => {
    const f = fixture();
    f.evaluate();
    for (const action of ['approve', 'reject', 'promote', 'rollback', 'deactivate']) {
      const denied = command(f.root, [...f.base, `--${action}`, f.candidate.version.id]);
      expect(denied.status).toBe(1);
      expect(denied.stderr).toContain('INTERACTIVE_OPERATOR_REQUIRED');
      expect(denied.stdout).toBe('');
    }
    for (const extra of [
      ['--yes'],
      ['--force'],
      ['--approvedBy', 'human'],
      ['--reviewer', 'admin'],
    ]) {
      expect(
        command(f.root, [...f.base, '--approve', f.candidate.version.id, ...extra]).status,
      ).toBe(1);
    }
    expect(f.store.getVersion(f.candidate.version.id).state.status).toBe('candidate');
  });
  it('enforces authorization in the service independently of the terminal UI', () => {
    const f = fixture();
    f.evaluate();
    const service = new SkillOperatorService(f.db, f.scope);
    for (const grant of [undefined, { session: 'forged' }, true, { approvedBy: 'human' }]) {
      expect(() =>
        service.commit({ action: 'approve', version_id: f.candidate.version.id }, grant),
      ).toThrow('terminal confirmation');
    }
    expect(() =>
      service.prepare({
        action: 'approve',
        version_id: f.candidate.version.id,
        approvedBy: 'human',
      }),
    ).toThrow('Expected a supported');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_reviews').get()).toEqual({ n: 0 });
  });
  it('does not accept generic yes and cannot reuse a confirmation for state changed after display', async () => {
    const f = fixture();
    f.evaluate();
    const denied = await f.apply('approve', undefined, 'yes');
    expect(denied.status).toBe(1);
    expect(denied.output).toContain('OPERATOR_CONFIRMATION_DENIED');
    const p = f.tty('approve');
    expect((await p.ready).event).toBe('ready');
    f.evaluate();
    p.respond();
    const stale = await p.exit;
    expect(stale.status).toBe(1);
    expect(stale.output).toContain('STALE_OPERATOR_REVIEW');
    expect(f.store.getVersion(f.candidate.version.id).state.status).toBe('candidate');
  });
  it('detects superseded candidates and tampered content after evaluation', async () => {
    const f = fixture();
    f.evaluate();
    f.propose();
    const superseded = await f.apply('approve');
    expect(superseded.status).toBe(1);
    expect(superseded.output).toContain('SUPERSEDED_CANDIDATE');
    const current = f.store.list().skills[0]?.latest_version_id as string;
    f.evaluate(current);
    f.db.exec('DROP TRIGGER skill_versions_immutable_update');
    f.db
      .prepare('UPDATE skill_versions SET content_hash=? WHERE id=?')
      .run('0'.repeat(64), current);
    const corrupt = await f.apply('approve', current);
    expect(corrupt.status).toBe(1);
    expect(corrupt.output).toContain('SKILL_INTEGRITY_ERROR');
  });
  it.each(['fail', 'unverified', 'unknown-policy', 'missing-check'])(
    'denies %s evaluations despite an interactive operator',
    async (kind) => {
      const f = fixture();
      if (kind === 'unverified') f.evaluate(undefined, 'behavioral');
      else if (kind === 'fail') f.evaluation(f.candidate.version.id, 'FAIL');
      else if (kind === 'unknown-policy')
        f.evaluation(f.candidate.version.id, 'PASS', {
          evaluator: 'untrusted',
          evaluator_version: 'fake-v1',
        });
      else
        f.evaluation(f.candidate.version.id, 'PASS', {
          evaluator: 'agentmind-deterministic',
          evaluator_version: 'static-contract-v2/agentmind-markdown-v1',
        });
      const denied = await f.apply('approve');
      expect(denied.status).toBe(1);
      expect(denied.output).toContain('EVALUATION_NOT_ELIGIBLE');
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_reviews').get()).toEqual({ n: 0 });
    },
  );
  it('rejects a candidate terminally and prevents unauthorized/never-active rollback', async () => {
    const f = fixture();
    success(await f.apply('reject'));
    const denied = await f.apply('promote');
    expect(denied.status).toBe(1);
    expect(() =>
      new SkillOperatorService(f.db, f.scope).commit(
        { action: 'rollback', version_id: f.candidate.version.id },
        {},
      ),
    ).toThrow();
    expect(f.store.getVersion(f.candidate.version.id).state.status).toBe('rejected');
    const second = f.propose();
    f.evaluate(second.version.id);
    success(await f.apply('approve', second.version.id));
    const never = await f.apply('rollback', second.version.id);
    expect(never.status).toBe(1);
    expect(never.output).toContain('ROLLBACK_NOT_ELIGIBLE');
    const missing = await f.apply('rollback', '11111111-1111-4111-8111-111111111111');
    expect(missing.status).toBe(1);
    expect(missing.output).toContain('SKILL_NOT_FOUND');
  });
  it('prevents approval replay for another version and refuses legacy approval without operator provenance', async () => {
    const f = fixture();
    const first = f.evaluate();
    success(await f.apply('approve'));
    const second = f.propose();
    f.evaluation(second.version.id, 'PASS', { content_hash: first.evaluation.content_hash });
    // This candidate has identical files; a report from the other version still is not its approved review.
    f.review(second.version.id);
    expect(() =>
      f.transition(f.candidate.identity.id, second.version.id, 'promote', {
        approval_id: f.store.getVersion(f.candidate.version.id).state.review_id,
      }),
    ).toThrow('invalid skill promotion');
    const denied = await f.apply('promote', second.version.id);
    expect(denied.status).toBe(1);
    expect(denied.output).toMatch(/EVALUATION_NOT_ELIGIBLE|OPERATOR_APPROVAL_REQUIRED/);
    expect(f.store.getIdentity(f.candidate.identity.id).active_version_id).toBeNull();
  });
  it('allows only one of two independently confirmed concurrent promotions to change the pointer', async () => {
    const f = fixture();
    f.evaluate();
    success(await f.apply('approve'));
    const second = f.propose();
    f.evaluate(second.version.id);
    success(await f.apply('approve', second.version.id));
    const firstPrompt = f.tty('promote');
    const secondPrompt = f.tty('promote', second.version.id);
    expect((await firstPrompt.ready).event).toBe('ready');
    expect((await secondPrompt.ready).event).toBe('ready');
    firstPrompt.respond();
    secondPrompt.respond();
    const replies = await Promise.all([firstPrompt.exit, secondPrompt.exit]);
    expect(replies.filter((r) => r.status === 0)).toHaveLength(1);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_promotions').get()).toEqual({ n: 1 });
    expect([f.candidate.version.id, second.version.id]).toContain(
      f.store.getIdentity(f.candidate.identity.id).active_version_id,
    );
  });
  it('rolls back the pointer, history and audit together when the audit write fails', async () => {
    const f = fixture();
    f.evaluate();
    success(await f.apply('approve'));
    success(await f.apply('promote'));
    success(await f.apply('deactivate'));
    const second = f.propose('Changed guidance.');
    f.evaluate(second.version.id);
    success(await f.apply('approve', second.version.id));
    success(await f.apply('promote', second.version.id));
    const before = f.store.getIdentity(f.candidate.identity.id);
    const count = f.db.prepare('SELECT COUNT(*) AS n FROM skill_promotions').get();
    f.db.exec(
      "CREATE TRIGGER fixture_audit_fail BEFORE INSERT ON skill_operator_events WHEN NEW.action='rollback' BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
    );
    const denied = await f.apply('rollback');
    expect(denied.status).toBe(1);
    expect(f.store.getIdentity(f.candidate.identity.id)).toEqual(before);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_promotions').get()).toEqual(count);
    expect(f.store.getVersion(f.candidate.version.id).state.status).toBe('approved');
  });
  it('retains the previous active version when promotion audit insertion fails', async () => {
    const f = fixture();
    f.evaluate();
    success(await f.apply('approve'));
    success(await f.apply('promote'));
    const second = f.propose();
    f.evaluate(second.version.id);
    success(await f.apply('approve', second.version.id));
    const before = f.store.getIdentity(f.candidate.identity.id);
    const histories = f.db.prepare('SELECT COUNT(*) AS n FROM skill_promotions').get();
    const audits = f.db.prepare('SELECT COUNT(*) AS n FROM skill_operator_events').get();
    f.db.exec(
      "CREATE TRIGGER fixture_promotion_fail BEFORE INSERT ON skill_operator_events WHEN NEW.action='promote' BEGIN SELECT RAISE(ABORT,'fixture promotion failure'); END",
    );
    const denied = await f.apply('promote', second.version.id);
    expect(denied.status).toBe(1);
    expect(f.store.getIdentity(f.candidate.identity.id)).toEqual(before);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_promotions').get()).toEqual(histories);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_operator_events').get()).toEqual(audits);
    expect(f.store.getVersion(f.candidate.version.id).state.status).toBe('approved');
  });
  it('denies foreign reads and privileged writes at the scoped service boundary', () => {
    const f = fixture();
    f.evaluate();
    const foreign = new SkillOperatorService(f.db, f.otherScope);
    expect(() =>
      foreign.prepare({ action: 'approve', version_id: f.candidate.version.id }),
    ).toThrow('not available');
    expect(() =>
      new SkillReviewService(f.db, f.otherScope).review({ version_id: f.candidate.version.id }),
    ).toThrow('not available');
    expect(new SkillReviewService(f.db, f.otherScope).pending().candidates).toEqual([]);
  });
  it.each(['replay', 'mismatch', 'expired'])(
    'denies a real terminal-issued grant on %s at the mutation service boundary',
    async (scenario) => {
      const f = fixture();
      f.evaluate();
      const p = operatorTTY(
        f.root,
        [
          '--project-root',
          f.root,
          '--db',
          f.path,
          '--version',
          f.candidate.version.id,
          '--scenario',
          scenario,
        ],
        resolve('tests/fixtures/operator-grant.mjs'),
      );
      expect((await p.ready).event).toBe('ready');
      p.respond();
      const result = await p.exit;
      success(result);
      expect(result.output).toContain(
        scenario === 'replay' ? 'OPERATOR_AUTHORIZATION_REQUIRED' : 'STALE_OPERATOR_REVIEW',
      );
      expect(f.store.getVersion(f.candidate.version.id).state.status).toBe(
        scenario === 'replay' ? 'approved' : 'candidate',
      );
    },
  );
  it('exposes four scoped read-only MCP review capabilities and rejects privileged mutations', async () => {
    const f = fixture();
    f.evaluate();
    const client = new Client({ name: 'adversarial-review-sdk', version: '1' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve('packages/mcp-server/dist/index.js'), ...f.base],
        cwd: f.root,
        stderr: 'pipe',
      }),
    );
    try {
      const tools = (await client.listTools()).tools;
      for (const name of ['skill_pending', 'skill_review', 'skill_diff', 'skill_evaluation']) {
        expect(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
        const result = await client.callTool({
          name,
          arguments: name === 'skill_pending' ? {} : { version_id: f.candidate.version.id },
        });
        expect(result.isError).not.toBe(true);
      }
      for (const name of [
        'skill_approve',
        'skill_promote',
        'skill_rollback',
        'skill_deactivate',
        'skill_operator',
      ])
        expect(
          (await client.callTool({ name, arguments: { version_id: f.candidate.version.id } }))
            .isError,
        ).toBe(true);
      expect(
        (
          await client.callTool({
            name: 'skill_review',
            arguments: { version_id: f.candidate.version.id, decision: 'approved' },
          })
        ).isError,
      ).toBe(true);
      expect(
        (
          await client.callTool({
            name: 'skill_pending',
            arguments: { project_id: f.otherScope.id },
          })
        ).isError,
      ).toBe(true);
      expect(f.store.getVersion(f.candidate.version.id).state.status).toBe('candidate');
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_reviews').get()).toEqual({ n: 0 });
    } finally {
      await client.close();
    }
  });
  it('KNOWN LIMITATION: same-user raw SQLite access can bypass workflow attribution', () => {
    const f = fixture();
    f.evaluate();
    // Deliberately simulate a same-UID actor using raw SQL fixture writers.
    f.review(f.candidate.version.id);
    f.transition(f.candidate.identity.id, f.candidate.version.id);
    expect(f.store.getIdentity(f.candidate.identity.id).active_version_id).toBe(
      f.candidate.version.id,
    );
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_operator_events').get()).toEqual({ n: 0 });
    expect(() =>
      new SkillOperatorService(f.db, f.scope).prepare({
        action: 'promote',
        version_id: f.candidate.version.id,
      }),
    ).toThrow('operator confirmation provenance');
  });
  it('KNOWN LIMITATION: automated same-user PTY confirmation succeeds and is not proof of a human', async () => {
    const f = fixture();
    f.evaluate();
    success(await f.apply('approve'));
    const event = f.db.prepare('SELECT metadata_json FROM skill_operator_events').get() as {
      metadata_json: string;
    };
    expect(JSON.parse(event.metadata_json).same_uid_boundary).toBe(false);
  });
});

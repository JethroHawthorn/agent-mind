import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { expect, it, vi } from 'vitest';

vi.mock('../../packages/core/src/operator-confirmation.js', async (original) => {
  const real = await original<typeof import('../../packages/core/src/operator-confirmation.js')>();
  return {
    ...real,
    consumeOperatorGrant: (_grant: unknown, digest: string) => ({
      operator: 'synthetic-benchmark',
      session: randomUUID(),
      digest,
    }),
  };
});

import { SkillProposalService } from '../../packages/core/src/index.js';
import { inspectPackage } from '../../packages/core/src/skill-distribution-files.js';
import { distributionFixture } from '../helpers/distribution-fixture.js';
import { writeReviewArtifact } from '../helpers/review-artifact.js';

const phases = vi.hoisted(() => ({ runs: new Map<string, Record<string, number>>() }));
vi.mock('../../packages/core/src/distribution-reliability.js', async (original) => {
  const real =
    await original<typeof import('../../packages/core/src/distribution-reliability.js')>();
  return {
    ...real,
    distributionCheckpoint: (name: string, id: string) => {
      if (id) {
        const r = phases.runs.get(id) ?? {};
        r[name] = performance.now();
        phases.runs.set(id, r);
      }
    },
  };
});

it('measures real disposable filesystem publication for bounded package profiles, never models', () => {
  const results = [];
  const percentile = (xs: number[], p: number) =>
    [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
  for (const [profile, count, chars] of [
    ['instruction-only', 0, 0],
    ['many-resources', 12, 1024],
    ['large', 30, 6000],
  ] as const) {
    phases.runs.clear();
    const f = distributionFixture(false);
    try {
      const main = f.candidate.version.files[0];
      if (!main) throw Error('fixture');
      const candidate = new SkillProposalService(f.db, f.scope, 'codex').propose({
        name: f.candidate.identity.name,
        description: f.candidate.version.description,
        expected_latest_version: 1,
        source_experience_ids: [f.approvedSource.id],
        files: [
          {
            path: 'SKILL.md',
            content: main.content.replace('[notes](references/notes.md)', 'the scoped workflow'),
          },
          ...Array.from({ length: count }, (_, i) => ({
            path: `references/r${i}.md`,
            content: 'Bounded harmless resource.\n'.repeat(Math.ceil(chars / 26)).slice(0, chars),
          })),
        ],
      });
      f.evaluate(candidate.version.id);
      f.approve(candidate.version.id);
      f.promote(candidate.version.id);
      const timings: number[] = [];
      for (let i = 0; i < 20; i++) {
        const t = performance.now();
        f.service.plan(f.request);
        timings.push(performance.now() - t);
      }
      const one = { ...f.request, target: 'codex' as const };
      let t = performance.now();
      f.service.commit(one, {});
      const single = performance.now() - t;
      f.service.commit({ ...one, operation: 'remove' }, {});
      t = performance.now();
      f.service.commit(f.request, {});
      const multi = performance.now() - t;
      const plan = f.service.plan(f.request),
        dest = plan.entries[0]?.destination;
      if (!dest) throw Error('destination');
      const checks: number[] = [];
      for (let i = 0; i < 20; i++) {
        t = performance.now();
        expect(inspectPackage(dest)).toMatchObject({
          content_digest: candidate.version.content_hash,
        });
        checks.push(performance.now() - t);
      }
      t = performance.now();
      const history = f.service.history({ skill_id: candidate.identity.id, limit: 20 });
      const historyMs = performance.now() - t;
      results.push({
        profile,
        files: count + 1,
        package_bytes: candidate.version.files.reduce(
          (n, x) => n + Buffer.byteLength(x.content),
          0,
        ),
        planning_samples: 20,
        planning_p50_ms: percentile(timings, 0.5),
        planning_p95_ms: percentile(timings, 0.95),
        single_destination_ms: single,
        two_destinations_ms: multi,
        integrity_samples: 20,
        integrity_p50_ms: percentile(checks, 0.5),
        integrity_p95_ms: percentile(checks, 0.95),
        history_ms: historyMs,
        history_response_bytes: Buffer.byteLength(JSON.stringify(history)),
        native_package_copies: 2,
        intent_phase_samples: [...phases.runs.values()].map((r) => ({
          staging_ms:
            r.after_staging !== undefined && r.before_staging !== undefined
              ? r.after_staging - r.before_staging
              : null,
          metadata_commit_ms:
            r.after_registry_commit !== undefined && r.before_registry_commit !== undefined
              ? r.after_registry_commit - r.before_registry_commit
              : null,
          cleanup_ms:
            r.after_cleanup !== undefined && r.before_cleanup !== undefined
              ? r.after_cleanup - r.before_cleanup
              : null,
        })),
      });
    } finally {
      f.close();
    }
  }
  const rollbackFixture = distributionFixture();
  let lifecycle: Record<string, string | number> | null = null;
  try {
    const f = rollbackFixture;
    f.service.commit(f.request, {});
    f.transition(f.candidate.identity.id, null, 'deactivate');
    const next = f.propose('Measured disposable replacement');
    f.evaluate(next.version.id);
    f.approve(next.version.id);
    let start = performance.now();
    f.promote(next.version.id);
    const fixture_promotion_ms = performance.now() - start;
    f.service.commit(f.request, {});
    start = performance.now();
    f.promote(f.candidate.version.id, 'rollback');
    const fixture_rollback_ms = performance.now() - start;
    start = performance.now();
    f.service.commit(f.request, {});
    const rollback_publication_ms = performance.now() - start;
    // Roll back a DB write after real filesystem publication to measure pending reconciliation.
    f.db.exec(
      "CREATE TRIGGER perf_fault BEFORE UPDATE ON skill_installations BEGIN SELECT RAISE(ABORT,'disposable performance fault');END",
    );
    f.promote(next.version.id, 'rollback');
    expect(() => f.service.commit(f.request, {})).toThrow();
    f.db.exec('DROP TRIGGER perf_fault');
    start = performance.now();
    f.service.plan(f.request);
    const recovery_inspection_ms = performance.now() - start;
    start = performance.now();
    f.service.commit(f.request, {});
    const recovery_reconciliation_ms = performance.now() - start;
    f.service.commit(f.request, {});
    lifecycle = {
      classification: 'FIXTURE_AUTHORITY_NOT_PROTECTED_OPERATOR',
      fixture_promotion_ms,
      fixture_rollback_ms,
      rollback_publication_ms,
      recovery_inspection_ms,
      recovery_reconciliation_ms,
    };
  } finally {
    rollbackFixture.close();
  }
  const historyFixture = distributionFixture(false);
  let historyScale: Record<string, unknown> | null = null;
  try {
    const f = historyFixture;
    let latest = f.candidate;
    for (let i = 0; i < 50; i++) {
      latest = f.propose(`Approved historical fixture ${i}.`);
      f.evaluate(latest.version.id);
      f.approve(latest.version.id);
    }
    f.promote(latest.version.id);
    f.service.commit(f.request, {});
    const start = performance.now();
    const insert = f.db.prepare(
      `INSERT INTO skill_distribution_events(id,project_id,skill_id,destination,target,scope,intent_id,action,outcome,version_id,installed_digest,operator_id,authorization_method,session_id,context_digest,created_at) VALUES(?,?,?,?,'codex','project',NULL,'BENCHMARK_OBSERVATION','FIXTURE_ONLY',?,?,'synthetic-benchmark','local-observation-v1',NULL,NULL,?)`,
    );
    f.db
      .transaction(() => {
        for (let i = 0; i < 1000; i++)
          insert.run(
            randomUUID(),
            f.scope.id,
            latest.identity.id,
            f.root,
            latest.version.id,
            latest.version.content_hash,
            new Date().toISOString(),
          );
      })
      .immediate();
    const synthetic_audit_batch_ms = performance.now() - start;
    const plans: number[] = [],
      pages: number[] = [];
    let bytes = 0;
    for (let i = 0; i < 20; i++) {
      let t = performance.now();
      f.service.plan(f.request);
      plans.push(performance.now() - t);
      t = performance.now();
      const page = f.service.history({ skill_id: latest.identity.id, limit: 20 });
      pages.push(performance.now() - t);
      bytes = Buffer.byteLength(JSON.stringify(page));
    }
    historyScale = {
      classification: 'SYNTHETIC_HISTORY_NOT_OPERATOR_EVIDENCE',
      approved_versions: 50,
      synthetic_observation_rows: 1000,
      samples: 20,
      planning_p50_ms: percentile(plans, 0.5),
      planning_p95_ms: percentile(plans, 0.95),
      history_p50_ms: percentile(pages, 0.5),
      history_p95_ms: percentile(pages, 0.95),
      history_page_bytes: bytes,
      synthetic_audit_batch_ms,
      database_bytes: statSync(f.path).size,
      wal_bytes: statSync(`${f.path}-wal`).size,
      query_plan: f.db
        .prepare(
          'EXPLAIN QUERY PLAN SELECT id FROM skill_distribution_intents WHERE project_id=? AND skill_id=? ORDER BY created_at DESC,id LIMIT 20',
        )
        .all(f.scope.id, latest.identity.id),
    };
  } finally {
    historyFixture.close();
  }
  writeReviewArtifact('P5-003_PERFORMANCE.json', {
    schema_version: 1,
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    method:
      'Disposable SQLite/filesystem; synthetic fixture authority; publication includes staging/hash/fsync/journal/audit/cleanup; no native coding agent or protected OS deployment',
    results,
    lifecycle,
    historyScale,
    guest_execution: null,
    protected_operator_roundtrip: null,
    rss_bytes: process.memoryUsage().rss,
  });
}, 20000);

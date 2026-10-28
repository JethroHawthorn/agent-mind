import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { SkillEvaluationService } from '../../packages/core/src/index.js';
import { distributionFixture } from '../helpers/distribution-fixture.js';
import { writeReviewArtifact } from '../helpers/review-artifact.js';

it('measures refusal planning and evidence persistence without claiming sandbox execution costs', () => {
  const f = distributionFixture();
  try {
    const evaluator = new SkillEvaluationService(f.db, f.scope),
      p = f.propose('Bounded performance fixture.');
    const input = {
      version_id: p.version.id,
      expected_content_hash: p.version.content_hash,
      expected_state_revision: p.state.revision,
      mode: 'behavioral',
    };
    const rssBefore = process.memoryUsage().rss,
      timings: number[] = [];
    let size = 0;
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      const result = evaluator.plan(input);
      timings.push(performance.now() - start);
      size = Buffer.byteLength(JSON.stringify(result));
    }
    const records: number[] = [];
    for (let i = 0; i < 10; i++) {
      const c = f.propose(`Independent refusal ${i}`);
      const start = performance.now();
      const r = evaluator.evaluate({
        ...input,
        version_id: c.version.id,
        expected_content_hash: c.version.content_hash,
        expected_state_revision: c.state.revision,
      });
      records.push(performance.now() - start);
      expect(r.evaluation.result).toBe('NOT_VERIFIED');
    }
    const percentile = (xs: number[], p: number) =>
      [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
    const report = {
      schema_version: 1,
      method:
        'Disposable SQLite; 100 read plans, 10 fresh candidate refusal writes; no backend/model/guest execution',
      environment: { platform: process.platform, arch: process.arch, node: process.version },
      planning: {
        samples: 100,
        first_ms: timings[0],
        p50_ms: percentile(timings, 0.5),
        p95_ms: percentile(timings, 0.95),
        response_bytes: size,
      },
      refusal_persistence: {
        samples: 10,
        p50_ms: percentile(records, 0.5),
        p95_ms: percentile(records, 0.95),
      },
      rss_before_bytes: rssBefore,
      rss_after_bytes: process.memoryUsage().rss,
      sandbox_startup: null,
      guest_execution: null,
      cleanup: null,
      peak_guest_memory: null,
    };
    writeReviewArtifact('P5-002_PERFORMANCE.json', report);
    expect(size).toBeLessThan(32768);
  } finally {
    f.close();
  }
});

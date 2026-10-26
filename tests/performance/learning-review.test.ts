import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { LearningReviewService, SkillAuthoringService } from '../../packages/core/src/index.js';
import { authoringFixture } from '../helpers/authoring-fixture.js';

it('measures indexed queue reads over 100 disposable proposals without a latency SLA', () => {
  const f = authoringFixture();
  try {
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      // Each explicitly isolated synthetic session uses the public authoring invariants.
      const service = new SkillAuthoringService(f.db, f.scope, 'codex');
      const ctx = service.context(f.contextRequest),
        name = `shader-benchmark-${i}`;
      const d = f.draft({ name, context_id: ctx.id, context_digest: ctx.context_digest });
      if (!d.files) throw Error('files');
      d.files = d.files.map((x) => ({
        ...x,
        content: x.content.replaceAll('shader-adjacency', name),
      }));
      expect(service.submit(d)).toHaveProperty('proposal_id');
    }
    const setup_ms = performance.now() - start,
      read = new LearningReviewService(f.db, f.scope),
      heap = process.memoryUsage().heapUsed;
    const t = performance.now();
    let bytes = 0;
    for (let i = 0; i < 20; i++)
      bytes = Buffer.byteLength(JSON.stringify(read.list({ limit: 10, offset: (i % 10) * 10 })));
    const reads_ms = performance.now() - t;
    const plan = f.db
      .prepare(
        'EXPLAIN QUERY PLAN SELECT id FROM authoring_proposals WHERE project_id=? ORDER BY created_at,id LIMIT 101 OFFSET 0',
      )
      .all(f.scope.id);
    const measurement = {
      benchmark: 'review-queue-100',
      proposals: 100,
      setup_ms,
      reads: 20,
      reads_ms,
      mean_read_ms: reads_ms / 20,
      response_bytes: bytes,
      estimated_tokens: Math.ceil(bytes / 4),
      tokenizer: 'not measured',
      heap_delta_bytes: process.memoryUsage().heapUsed - heap,
      query_plan: plan,
    };
    writeFileSync(
      join(tmpdir(), 'agentmind-review-queue-benchmark.json'),
      JSON.stringify(measurement, null, 2),
    );
    console.info(JSON.stringify(measurement));
    expect(read.list({ limit: 10 }).items).toHaveLength(10);
    expect(bytes).toBeLessThan(49000);
    expect(JSON.stringify(plan)).toContain('authoring_pending');
  } finally {
    f.close();
  }
});

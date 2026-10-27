import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { qualityMetrics } from '../helpers/hybrid-metrics.js';
import {
  HYBRID_DATASET,
  hybridLabels,
  seedHybridQuality,
} from '../helpers/hybrid-quality-fixtures.js';
import { retrievalFixture } from '../helpers/retrieval-fixture.js';

it('records P3-008 baseline before hybrid implementation on a fixed immutable-metadata corpus', () => {
  const f = retrievalFixture();
  try {
    seedHybridQuality(f);
    const cases = hybridLabels.map((q) => {
      const start = performance.now();
      const r = f.retrieval.route({ context: q.context, limit: 10 });
      return {
        ...q,
        names: r.skills.map((s) => s.name),
        bytes: Buffer.byteLength(JSON.stringify(r)),
        latency_ms: performance.now() - start,
        outcome: r.outcome,
      };
    });
    const digest = createHash('sha256')
      .update(readFileSync('tests/helpers/hybrid-quality-fixtures.ts'))
      .update(readFileSync('tests/helpers/routing-quality-fixtures.ts'))
      .update(readFileSync('tests/helpers/retrieval-quality-fixtures.ts'))
      .digest('hex');
    const source_digest = createHash('sha256')
      .update(readFileSync('packages/core/src/retrieval/routing.ts'))
      .update(readFileSync('packages/core/src/retrieval/ranking.ts'))
      .digest('hex');
    const report = {
      dataset: HYBRID_DATASET,
      digest,
      source_digest,
      skills: f.db.prepare('SELECT count(*) AS n FROM skills').get(),
      approved_active: f.db
        .prepare('SELECT count(*) AS n FROM skills WHERE active_version_id IS NOT NULL')
        .get(),
      metrics: qualityMetrics(cases),
      cases,
      limitations:
        'Fixed synthetic corpus, labels are not exhaustive; one serial first-pass sample per query, OS/database warm; no real LLM selection or model-token measurement.',
    };
    writeFileSync(
      join(tmpdir(), 'agentmind-p4-003a-baseline.json'),
      JSON.stringify(report, null, 2),
    );
    expect(cases.length).toBe(31);
  } finally {
    f.close();
  }
});

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { qualityMetrics } from '../helpers/hybrid-metrics.js';
import { hybridLabels, seedHybridQuality } from '../helpers/hybrid-quality-fixtures.js';
import { retrievalFixture } from '../helpers/retrieval-fixture.js';

it('compares legacy and hybrid on identical fixed labels without model selection claims', () => {
  const f = retrievalFixture();
  try {
    seedHybridQuality(f);
    const measure = (hybrid: boolean) =>
      hybridLabels.map((q) => {
        const start = performance.now();
        const r = hybrid
          ? f.retrieval.selectionCards({ context: q.context, limit: 10 })
          : f.retrieval.route({ context: q.context, limit: 10 });
        return {
          ...q,
          names: r.skills.map((s) => s.name),
          outcome: r.outcome,
          bytes: Buffer.byteLength(JSON.stringify(r)),
          latency_ms: performance.now() - start,
        };
      });
    const baseline = measure(false),
      hybrid = measure(true);
    const report = {
      baseline: qualityMetrics(baseline),
      hybrid: qualityMetrics(hybrid),
      cases: hybrid,
    };
    writeFileSync(
      join(tmpdir(), 'agentmind-p4-003a-comparison.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify({ baseline: report.baseline, hybrid: report.hybrid }));
    expect(report.hybrid.recall_at_5).toBeGreaterThanOrEqual(report.baseline.recall_at_5);
  } finally {
    f.close();
  }
});

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { duplicatePolicySchema } from '../../packages/core/src/curator/similarity/model.js';
import { runSimilarity } from '../../packages/core/src/curator/similarity/pipeline.js';
import { RecommendationService } from '../../packages/core/src/index.js';
import { files, retry } from '../helpers/duplicate-fixtures.js';
import { skillFixture } from '../helpers/skill-fixture.js';

it('measures bounded real SQLite/worker analysis at 100 and 1000 skills', () => {
  const measurements = [];
  for (const count of [100, 1000]) {
    const f = skillFixture();
    try {
      const setup = performance.now();
      f.db.transaction(() => {
        for (let i = 0; i < count; i++) {
          const name = `benchmark-${i}`;
          const id = f.identity(name);
          const v = f.version(
            id,
            undefined,
            undefined,
            files(
              `${retry}\n# Output\nReport category fixturegroup${i % 25} and evidence sample${i}.`,
              name,
            ),
          );
          f.evaluation(v);
          f.review(v);
        }
      })();
      const setup_ms = performance.now() - setup;
      const result = runSimilarity(f.db, f.scope, duplicatePolicySchema.parse({}), {});
      const queryStarted = performance.now();
      const scopedCount = f.db
        .prepare('SELECT COUNT(*) AS n FROM skills WHERE project_id=?')
        .get(f.scope.id);
      const query_ms = performance.now() - queryStarted;
      const service = new RecommendationService(f.db, f.scope);
      const coldStarted = performance.now();
      const cold = service.analyzeDuplicates();
      const cold_ms = performance.now() - coldStarted;
      const warmStarted = performance.now();
      const warm = service.analyzeDuplicates();
      const warm_ms = performance.now() - warmStarted;
      expect(result.statistics.skills).toBe(count);
      expect(result.statistics.pair_count).toBeLessThanOrEqual(5000);
      expect(warm.statistics.feature_cache_hits).toBe(count);
      expect(scopedCount).toEqual({ n: count });
      measurements.push({
        skills: count,
        setup_ms,
        query_ms,
        cold_worker_ms: cold_ms,
        warm_worker_ms: warm_ms,
        cold: cold.statistics,
        warm: warm.statistics,
        direct: result.statistics,
        coverage: cold.coverage,
      });
    } finally {
      f.close();
    }
  }
  writeFileSync(
    join(tmpdir(), 'agentmind-p3-002-benchmark.json'),
    JSON.stringify(
      {
        environment: { platform: process.platform, arch: process.arch, node: process.version },
        measurements,
        limitations:
          'One synthetic local run; process peak RSS is a high-water mark; timings are not production targets. Retrieval is capped, not exhaustive.',
      },
      null,
      2,
    ),
  );
}, 60000);

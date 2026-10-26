import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import {
  buildRetrievalQuery,
  queryTerms,
  retrieveCandidates,
} from '../../packages/core/src/retrieval/ranking.js';
import { retrievalFixture } from '../helpers/retrieval-fixture.js';

const percentile = (a: number[], fraction: number) =>
  [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil(a.length * fraction) - 1)] ?? 0;
it.each([100, 1000, 5000])(
  'measures discovery and exact content/resource reads at %i active skills',
  (count) => {
    const f = retrievalFixture();
    try {
      const setup = performance.now();
      // Batch only disposable fixtures; all approvals/evaluations retain real storage guards.
      f.db
        .transaction(() => {
          for (let i = 0; i < count; i++)
            f.add({
              name: `sqlite-benchmark-${i}`,
              description: `Inspect SQLite startup scenario benchgroup${i % 25} with bounded retries.`,
              resources: [
                {
                  path: 'references/note.md',
                  content:
                    'Inspect the bounded retry fixture before applying task-specific acceptance checks.',
                },
              ],
            });
        })
        .immediate();
      const setup_ms = performance.now() - setup,
        heap = process.memoryUsage().heapUsed,
        search: number[] = [],
        loads: number[] = [],
        resources: number[] = [];
      let payload_bytes = 0;
      for (let i = 0; i < 20; i++) {
        let t = performance.now();
        const result = f.retrieval.discover({ query: `sqlite-benchmark-${i}` });
        search.push(performance.now() - t);
        expect(result.skills[0]?.name).toBe(`sqlite-benchmark-${i}`);
        payload_bytes = Math.max(payload_bytes, Buffer.byteLength(JSON.stringify(result)));
        const hit = result.skills[0];
        if (!hit) throw Error('fixture');
        const pin = {
          skill_id: hit.skill_id,
          expected_version_id: hit.active_version_id,
          expected_digest: hit.content_digest,
        };
        t = performance.now();
        f.retrieval.load(pin);
        loads.push(performance.now() - t);
        t = performance.now();
        f.retrieval.resource({ ...pin, path: 'references/note.md' });
        resources.push(performance.now() - t);
      }
      const queryPlan = buildRetrievalQuery(f.scope, queryTerms('sqlite'), 30);
      const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${queryPlan.sql}`).all(...queryPlan.parameters);
      const report = {
        active_skills: count,
        queries: 20,
        setup_ms,
        search_ms: { p50: percentile(search, 0.5), p95: percentile(search, 0.95) },
        load_ms: { p50: percentile(loads, 0.5), p95: percentile(loads, 0.95) },
        resource_ms: { p50: percentile(resources, 0.5), p95: percentile(resources, 0.95) },
        payload_bytes,
        estimated_tokens: Math.ceil(payload_bytes / 4),
        tokenizer: 'bytes/4 estimate; not measured',
        heap_delta_bytes: process.memoryUsage().heapUsed - heap,
        process_peak_rss_kb: process.resourceUsage().maxRSS,
        query_plan: plan,
        candidate_limit: 30,
        limitations:
          '20 synthetic queries; process peak RSS includes fixture setup and other process work; no production SLA.',
      };
      writeFileSync(
        join(tmpdir(), `agentmind-p3-006-benchmark-${count}.json`),
        JSON.stringify(report, null, 2),
      );
      expect(payload_bytes).toBeLessThanOrEqual(8192);
      expect(retrieveCandidates(f.db, f.scope, 'sqlite', 30).rows.length).toBeLessThanOrEqual(30);
      expect(JSON.stringify(plan)).toContain('VIRTUAL TABLE INDEX');
    } finally {
      f.close();
    }
  },
  60000,
);

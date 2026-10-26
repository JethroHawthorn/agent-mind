import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { SkillRetrievalService } from '../../packages/core/src/index.js';
import {
  buildRetrievalQuery,
  queryTerms,
  retrieveCandidates,
} from '../../packages/core/src/retrieval/ranking.js';
import { normalizeTask, rankRoutingCandidates } from '../../packages/core/src/retrieval/routing.js';
import { skillRouteSchema } from '../../packages/core/src/retrieval/routing-model.js';
import { retrievalFixture } from '../helpers/retrieval-fixture.js';

const pct = (a: number[], p: number) =>
  [...a].sort((a, b) => a - b)[Math.min(a.length - 1, Math.ceil(a.length * p) - 1)] ?? 0;
it.each([100, 1000, 5000])(
  'measures baseline/cold/warm routing, ranking and verified disclosure at %i active skills',
  (count) => {
    const f = retrievalFixture();
    try {
      const start = performance.now();
      f.db
        .transaction(() => {
          for (let i = 0; i < count; i++)
            f.add({
              name: `sqlite-route-${i}`,
              description: `Inspect SQLite startup scenario group${i % 25} with bounded retries.`,
              resources: [
                {
                  path: 'references/note.md',
                  content: 'Review bounded retry checks before applying task-specific guidance.',
                },
              ],
            });
        })
        .immediate();
      const setup_ms = performance.now() - start,
        heap = process.memoryUsage().heapUsed;
      const baseline: number[] = [],
        cold: number[] = [],
        warm: number[] = [],
        ranking: number[] = [],
        candidate: number[] = [],
        loads: number[] = [],
        resources: number[] = [];
      const payload = { baseline: 0, routing: 0, main: 0, resource: 0 };
      let hits = 0,
        misses = 0,
        max_candidates = 0;
      // Disable candidate caching for cold samples; keep it enabled on the same policy for warm pairs.
      const uncached = new SkillRetrievalService(f.db, f.scope, {}, { cache_entries: 0 });
      for (let i = 0; i < 20; i++) {
        const query = `sqlite-route-${i}`,
          request = { context: { summary: query }, limit: 5 };
        let t = performance.now();
        const b = f.retrieval.discover({ query });
        baseline.push(performance.now() - t);
        t = performance.now();
        const c = uncached.route(request);
        cold.push(performance.now() - t);
        const prime = f.retrieval.route(request);
        prime.diagnostics.cache_hit ? hits++ : misses++;
        t = performance.now();
        const w = f.retrieval.route(request);
        warm.push(performance.now() - t);
        w.diagnostics.cache_hit ? hits++ : misses++;
        expect(c.skills[0]?.name).toBe(query);
        expect(w.skills[0]?.active_version_id).toBe(c.skills[0]?.active_version_id);
        payload.baseline = Math.max(payload.baseline, Buffer.byteLength(JSON.stringify(b)));
        payload.routing = Math.max(payload.routing, Buffer.byteLength(JSON.stringify(w)));
        max_candidates = Math.max(max_candidates, w.diagnostics.candidate_count);
        t = performance.now();
        const found = retrieveCandidates(f.db, f.scope, query, 30);
        candidate.push(performance.now() - t);
        const n = normalizeTask(skillRouteSchema.parse(request).context);
        t = performance.now();
        rankRoutingCandidates(found.rows, n);
        ranking.push(performance.now() - t);
        const hit = w.skills[0];
        if (!hit) throw Error('missing fixture skill');
        const pin = {
          skill_id: hit.skill_id,
          expected_version_id: hit.active_version_id,
          expected_digest: hit.content_digest,
        };
        t = performance.now();
        const main = f.retrieval.load(pin);
        loads.push(performance.now() - t);
        payload.main = Math.max(payload.main, Buffer.byteLength(JSON.stringify(main)));
        t = performance.now();
        const resource = f.retrieval.resource({ ...pin, path: 'references/note.md' });
        resources.push(performance.now() - t);
        payload.resource = Math.max(payload.resource, Buffer.byteLength(JSON.stringify(resource)));
      }
      const plan = buildRetrievalQuery(f.scope, queryTerms('sqlite'), 30);
      const report = {
        active_skills: count,
        samples: 20,
        setup_ms,
        environment: {
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          cpu: cpus()[0]?.model,
        },
        baseline_ms: { p50: pct(baseline, 0.5), p95: pct(baseline, 0.95) },
        cold_routing_ms: { p50: pct(cold, 0.5), p95: pct(cold, 0.95) },
        warm_routing_ms: { p50: pct(warm, 0.5), p95: pct(warm, 0.95) },
        ranking_ms: { p50: pct(ranking, 0.5), p95: pct(ranking, 0.95) },
        candidate_sql_ms: { p50: pct(candidate, 0.5), p95: pct(candidate, 0.95) },
        main_ms: { p50: pct(loads, 0.5), p95: pct(loads, 0.95) },
        resource_ms: { p50: pct(resources, 0.5), p95: pct(resources, 0.95) },
        cache: {
          hits,
          misses,
          hit_ratio: hits / (hits + misses),
          meaning: 'Explicit prime/warm pairs, not observed native sessions',
        },
        max_candidates,
        payload_bytes: payload,
        payload_saving_percent: (100 * (payload.baseline - payload.routing)) / payload.baseline,
        heap_delta_bytes: process.memoryUsage().heapUsed - heap,
        peak_process_rss: process.resourceUsage().maxRSS,
        query_plan: f.db.prepare(`EXPLAIN QUERY PLAN ${plan.sql}`).all(...plan.parameters),
        router_bytes: readFileSync('skills/agentmind-router/SKILL.md').length,
        limitations:
          'Sequential synthetic 20-query samples, verified artifacts on every hit. Warm database/OS caches; cold means candidate-cache disabled, not machine cold. RSS includes fixture setup/other tests, heap delta includes GC; no production SLA or model-token saving attributed to cache.',
      };
      writeFileSync(
        join(tmpdir(), `agentmind-p3-008-benchmark-${count}.json`),
        JSON.stringify(report, null, 2),
      );
      expect(max_candidates).toBeLessThanOrEqual(30);
      expect(hits).toBe(20);
      expect(payload.routing).toBeLessThan(payload.baseline);
      expect(payload.routing).toBeLessThanOrEqual(4096);
      expect(JSON.stringify(report.query_plan)).toContain('VIRTUAL TABLE INDEX');
    } finally {
      f.close();
    }
  },
  60000,
);

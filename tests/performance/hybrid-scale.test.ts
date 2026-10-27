import { writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { SkillRetrievalService } from '../../packages/core/src/index.js';
import { retrievalFixture } from '../helpers/retrieval-fixture.js';

const pct = (a: number[], p: number) =>
  [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * p)];
it.each([100, 1000, 5000])(
  'measures bounded verified hybrid cards at %i skills',
  (count) => {
    const f = retrievalFixture();
    try {
      f.db.transaction(() => {
        for (let i = 0; i < count; i++)
          f.add({
            name: `hybrid-procedure-${i}`,
            description: `Inspect bounded SQLite recovery category${i % 20}.`,
            metadata: { 'discovery.aliases': JSON.stringify([`storage checkpoint ${i}`]) },
          });
      })();
      const uncached = new SkillRetrievalService(f.db, f.scope, {}, { cache_entries: 0 });
      const cold: number[] = [],
        warm: number[] = [],
        legacy: number[] = [];
      let hits = 0,
        maxBytes = 0;
      const heap = process.memoryUsage().heapUsed;
      for (let i = 0; i < 10; i++) {
        const req = { context: { summary: `storage checkpoint ${i}` } };
        let t = performance.now();
        uncached.selectionCards(req);
        cold.push(performance.now() - t);
        f.retrieval.selectionCards(req);
        t = performance.now();
        const r = f.retrieval.selectionCards(req);
        warm.push(performance.now() - t);
        hits += Number(r.diagnostics.cache_hit);
        maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(r)));
        t = performance.now();
        f.retrieval.route(req);
        legacy.push(performance.now() - t);
        expect(r.skills.some((s) => s.name === `hybrid-procedure-${i}`)).toBe(true);
      }
      const report = {
        count,
        samples: 10,
        environment: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          cpu: cpus()[0]?.model,
        },
        cold_ms: { p50: pct(cold, 0.5), p95: pct(cold, 0.95) },
        warm_ms: { p50: pct(warm, 0.5), p95: pct(warm, 0.95) },
        legacy_ms: { p50: pct(legacy, 0.5), p95: pct(legacy, 0.95) },
        cache_hits: hits,
        maximum_response_bytes: maxBytes,
        heap_delta: process.memoryUsage().heapUsed - heap,
        cache_accounting_limit: 131072,
        query_plan: f.db
          .prepare(
            'EXPLAIN QUERY PLAN SELECT rowid FROM skill_discovery_fts WHERE skill_discovery_fts MATCH ?',
          )
          .all('"storage"'),
      };
      writeFileSync(
        join(tmpdir(), `agentmind-p4-003a-scale-${count}.json`),
        JSON.stringify(report, null, 2),
      );
      expect(hits).toBe(10);
      expect(maxBytes).toBeLessThanOrEqual(4096);
    } finally {
      f.close();
    }
  },
  60000,
);

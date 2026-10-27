import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  DailyWorkflowService,
  MemoryService,
  SkillAuthoringService,
} from '../../packages/core/src/index.js';
import { renderDaily } from '../../packages/mcp-server/src/daily/presentation.js';
import { authoringFixture } from '../helpers/authoring-fixture.js';
import { retrievalFixture } from '../helpers/retrieval-fixture.js';

it('measures bounded daily views against disposable registries, not native/model performance', () => {
  const f = authoringFixture();
  const r = retrievalFixture();
  try {
    const empty = new DailyWorkflowService(f.db, f.otherScope);
    const s = new DailyWorkflowService(f.db, f.scope);
    const memory = new MemoryService(f.db, f.scope, 'gemini');
    const start = performance.now();
    for (let i = 0; i < 300; i++)
      memory.save({
        title: `OAuth boundary ${i}`,
        content: 'Use an explicit unknown outcome for missing inputs.',
        kind: 'fact',
      });
    for (let i = 0; i < 1000; i++)
      f.experiences.record({
        problem: `Boundary input ${i}`,
        solution: 'Preserve missing input uncertainty.',
        outcome: { status: 'unknown', summary: 'Synthetic benchmark, not task evidence.' },
      });
    for (let i = 0; i < 100; i++)
      f.learning.record({
        schema_version: 1,
        type: 'REUSABLE_WORKFLOW',
        title: `Boundary lesson ${i}`,
        summary: `Independent synthetic sample ${i} suggests checking missing numeric values explicitly before processing boundary inputs.`,
        reusability: 'potentially_reusable',
        task_ref: `sample-${i}`,
      });
    let first: string | null = null;
    for (let i = 0; i < 30; i++) {
      const name = `geometry-review-${i}`;
      const author = new SkillAuthoringService(f.db, f.scope, 'codex');
      const context = author.context(f.contextRequest);
      const draft = f.draft({
        name,
        context_id: context.id,
        context_digest: context.context_digest,
      });
      if (!draft.files) throw Error('fixture');
      draft.files = draft.files.map((v) => ({
        ...v,
        content: v.content.replaceAll('shader-adjacency', name),
      }));
      const p = author.submit(draft);
      if (!('proposal_id' in p)) throw Error('proposal');
      first ??= p.proposal_id;
    }
    for (let i = 0; i < 1000; i++)
      r.add({
        name: `boundary-${i}`,
        description: `Inspect controlled boundary condition ${i}`,
      });
    const active = r.add({
      name: 'active-boundary',
      description: 'Inspect controlled boundary inputs',
      resources: [{ path: 'references/check.md', content: 'Check explicit missing values.' }],
    });
    const skills = new DailyWorkflowService(r.db, r.scope);
    const samples = 10;
    const heap = process.memoryUsage().heapUsed;
    const timings: Record<string, { p50_ms: number; p95_ms: number; bytes: number }> = {};
    const measure = (key: string, fn: () => unknown) => {
      const times: number[] = [];
      let out: unknown;
      for (let i = 0; i < samples; i++) {
        const t = performance.now();
        out = fn();
        times.push(performance.now() - t);
      }
      times.sort((a, b) => a - b);
      timings[key] = {
        p50_ms: times[4] ?? 0,
        p95_ms: times[9] ?? 0,
        bytes: Buffer.byteLength(JSON.stringify(out)),
      };
      return out;
    };
    measure('empty', () => empty.execute({ domain: 'memory', action: 'list' }));
    const list = measure('memory_list', () =>
      s.execute({ domain: 'memory', action: 'list', limit: 10 }),
    );
    measure('memory_search', () =>
      s.execute({ domain: 'memory', action: 'search', query: 'OAuth boundary', limit: 5 }),
    );
    measure('experience_list', () => s.execute({ domain: 'experience', action: 'list' }));
    measure('learning_inbox', () => s.execute({ domain: 'learning', action: 'inbox' }));
    measure('review_queue', () => s.execute({ domain: 'proposals', action: 'list' }));
    measure('proposal_detail', () => s.execute({ domain: 'proposals', action: 'show', id: first }));
    measure('proposal_diff', () =>
      s.execute({ domain: 'proposals', action: 'diff', id: first, path: 'SKILL.md' }),
    );
    measure('activity', () => s.execute({ domain: 'activity', action: 'list' }));
    measure('skill_history', () =>
      skills.execute({ domain: 'skills', action: 'versions', id: active.identity.id }),
    );
    measure('skill_search', () =>
      skills.execute({ domain: 'skills', action: 'search', query: 'controlled boundary' }),
    );
    measure('skill_list', () => skills.execute({ domain: 'skills', action: 'list' }));
    measure('render', () => renderDaily(list, 80));
    const report = {
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      method:
        '10 warm service calls per operation; no native CLI or model; 1001 approved active identities; no production-scale claim.',
      corpus: { memories: 300, experiences: 1000, skills: 1001, signals: 100, proposals: 30 },
      samples,
      timings,
      fixture_setup_ms: performance.now() - start,
      heap_delta_bytes: process.memoryUsage().heapUsed - heap,
      peak_process_rss: process.resourceUsage().maxRSS,
      query_plans: {
        memories: f.db
          .prepare(
            'EXPLAIN QUERY PLAN SELECT id FROM memories WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 10',
          )
          .all(f.scope.id),
        experiences: f.db
          .prepare(
            'EXPLAIN QUERY PLAN SELECT id FROM experiences WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 10',
          )
          .all(f.scope.id),
      },
    };
    writeFileSync(
      join(tmpdir(), 'agentmind-p4-005-performance.json'),
      JSON.stringify(report, null, 2),
    );
    for (const metric of Object.values(timings)) expect(metric.bytes).toBeLessThan(65536);
  } finally {
    r.close();
    f.close();
  }
}, 60000);

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { seedHybridQuality } from '../helpers/hybrid-quality-fixtures.js';
import { retrievalFixture } from '../helpers/retrieval-fixture.js';

/** Deliberately narrow harness selector, NOT a model or proof of semantic suitability. */
it('evaluates a fixed eight-case harness selection/abstention protocol separately from retrieval', () => {
  const f = retrievalFixture();
  try {
    seedHybridQuality(f);
    const labels = [
      { summary: 'embedded persistence access', want: 'sqlite-retry' },
      { summary: 'database contention', want: 'sqlite-retry' },
      { summary: 'record shape checks', want: 'typescript-json' },
      { summary: 'route payload checks', want: 'nextjs-requests' },
      { summary: 'request validation', want: null },
      { summary: 'sqlite retry transaction rollback', want: null },
      { summary: 'astronomy telescope optics', want: null },
      { summary: 'help', want: null },
    ];
    const rows = labels.map((q) => {
      const cards = f.retrieval.selectionCards({ context: { summary: q.summary } }).skills;
      const exact = cards.filter((c) => c.match.exact_alias);
      const selected = exact.length === 1 ? exact[0]?.name : null;
      return { ...q, selected, correct: selected === q.want };
    });
    const report = {
      method:
        'DETERMINISTIC TEST HARNESS ONLY: unique exact approved alias or abstain; not semantic model selection',
      cases: rows,
      correct: rows.filter((r) => r.correct).length,
      total: rows.length,
      abstained: rows.filter((r) => r.selected === null).length,
      native_codex: 'NOT VERIFIED',
      native_claude: 'NOT VERIFIED',
      native_gemini: 'NOT VERIFIED',
    };
    writeFileSync(
      join(tmpdir(), 'agentmind-p4-003a-selection.json'),
      JSON.stringify(report, null, 2),
    );
    expect(report.correct).toBe(8);
    expect(report.abstained).toBe(4);
  } finally {
    f.close();
  }
});

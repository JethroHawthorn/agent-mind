import type { TaskContext } from '../../packages/core/src/index.js';
import type { retrievalFixture } from './retrieval-fixture.js';
import { retrievalCatalog, retrievalLabels } from './retrieval-quality-fixtures.js';
export type RoutingQuery = {
  label: string;
  context: Pick<TaskContext, 'summary'> & Partial<Omit<TaskContext, 'summary'>>;
  relevant: string[];
};
export const routingLabels: RoutingQuery[] = [
  ...retrievalLabels.map((q) => ({
    label: q.label,
    context: { summary: q.query },
    relevant: q.relevant,
  })),
  {
    label: 'typescript-error',
    context: {
      summary: 'validate json fields',
      languages: ['typescript'],
      diagnostic: 'malformed records',
    },
    relevant: ['typescript-json'],
  },
  {
    label: 'framework-request',
    context: { summary: 'validate request schemas', frameworks: ['nextjs'] },
    relevant: ['nextjs-requests'],
  },
  {
    label: 'incompatible-framework',
    context: { summary: 'request validation', frameworks: ['nextjs'], exclude_terms: ['express'] },
    relevant: ['nextjs-requests'],
  },
  {
    label: 'explicit-negative',
    context: { summary: 'request validation', exclude_terms: ['express'] },
    relevant: ['nextjs-requests'],
  },
  {
    label: 'ambiguous-framework',
    context: { summary: 'request validation' },
    relevant: ['express-requests', 'nextjs-requests'],
  },
  {
    label: 'multi-workflow',
    context: { summary: 'sqlite retry transaction rollback' },
    relevant: ['sqlite-retry', 'sqlite-retry-overlap', 'transaction-rollback'],
  },
  {
    label: 'complete-stemmed-task',
    context: { summary: 'validating payloads' },
    relevant: ['form-checks'],
  },
  { label: 'very-short', context: { summary: 'help' }, relevant: [] },
  {
    label: 'noisy-but-concrete',
    context: {
      summary:
        'please inspect the SQLite startup failure and bounded retry before describing unresolved task outcomes',
    },
    relevant: ['sqlite-retry', 'sqlite-retry-overlap'],
  },
  {
    label: 'unapproved-high-match',
    context: { summary: 'unpublishedgraph' },
    relevant: [],
  },
];
export function seedRoutingQuality(f: ReturnType<typeof retrievalFixture>) {
  for (const d of retrievalCatalog) f.add(d);
  f.add({
    name: 'form-checks',
    description: 'Validate payload records against task-specific schemas.',
  });
  f.add({
    name: 'quasar-geometry',
    description: 'Quasar geometry adjacency for private mesh rendering.',
    scope: f.otherScope,
  });
  const old = f.add({
    name: 'deployment-safety',
    description: 'Retiredhelium historical deployment workflow.',
  });
  f.transition(old.identity.id, null, 'deactivate');
  f.add({
    name: 'deployment-safety',
    description: 'Inspect current deployment prerequisites and recovery markers.',
  });
  f.add({
    name: 'nextjs-requests',
    description: 'Validate Nextjs request schemas with TypeScript route handlers.',
  });
  f.add({
    name: 'express-requests',
    description: 'Validate Express request schemas with JavaScript middleware.',
  });
  f.add({
    name: 'unpublishedgraph',
    description: 'Unpublishedgraph repair procedure.',
    activate: false,
  });
}
export function baselineRoutingQuery(q: RoutingQuery) {
  return [
    q.context.summary,
    ...(q.context.languages ?? []),
    ...(q.context.frameworks ?? []),
    q.context.diagnostic ?? '',
  ]
    .join(' ')
    .trim()
    .slice(0, 500);
}

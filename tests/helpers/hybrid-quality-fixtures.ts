import type { retrievalFixture } from './retrieval-fixture.js';
import {
  type RoutingQuery,
  routingLabels,
  seedRoutingQuality,
} from './routing-quality-fixtures.js';
export const HYBRID_DATASET = 'hybrid-selection-fixtures-v1';
const meta = (values: Record<string, string | string[]>) =>
  Object.fromEntries(
    Object.entries(values).map(([k, v]) => [
      `discovery.${k}`,
      Array.isArray(v) ? JSON.stringify(v) : v,
    ]),
  );
export const hybridMetadata: Record<string, Record<string, string>> = {
  'sqlite-retry': meta({
    aliases: ['database contention', 'embedded persistence access'],
    triggers: ['SQLITE_BUSY', 'storage lock recovery'],
    purpose: 'Recover bounded SQLite startup contention.',
    preconditions: ['A SQLite database reports lock contention.'],
    distinguishes: 'Connection/startup recovery, not query optimization.',
  }),
  'sqlite-retry-overlap': meta({
    triggers: ['connection recovery'],
    purpose: 'Review bounded connection recovery checkpoints.',
    distinguishes: 'Recovery evidence review rather than query tuning.',
  }),
  'typescript-json': meta({
    aliases: ['payload decoding', 'record shape checks'],
    languages: ['typescript'],
    purpose: 'Check JSON records using TypeScript.',
  }),
  'nextjs-requests': meta({
    aliases: ['route payload checks'],
    frameworks: ['nextjs'],
    languages: ['typescript'],
    preconditions: ['Use a Next.js route handler.'],
    not_for: ['express middleware'],
    distinguishes: 'Next.js route schemas, not Express middleware.',
  }),
  'express-requests': meta({
    frameworks: ['express'],
    languages: ['javascript'],
    preconditions: ['Use Express middleware.'],
    not_for: ['nextjs route'],
    distinguishes: 'Express middleware schemas rather than Next.js routes.',
  }),
  'data-export': meta({
    aliases: ['tabular extraction'],
    preconditions: ['Export authorized scoped records.'],
    not_for: ['unapproved records'],
  }),
};
export const hybridLabels: RoutingQuery[] = [
  ...routingLabels,
  {
    label: 'explicit-alias',
    context: { summary: 'database contention' },
    relevant: ['sqlite-retry'],
  },
  {
    label: 'alias-paraphrase',
    context: { summary: 'embedded persistence access' },
    relevant: ['sqlite-retry'],
  },
  {
    label: 'error-category',
    context: { summary: 'database connection', diagnostic: 'SQLITE_BUSY' },
    relevant: ['sqlite-retry', 'sqlite-retry-overlap'],
  },
  {
    label: 'framework-alias',
    context: { summary: 'route payload checks', frameworks: ['nextjs'], languages: ['typescript'] },
    relevant: ['nextjs-requests'],
  },
  {
    label: 'negative-applicability',
    context: { summary: 'tabular extraction unapproved records' },
    relevant: [],
  },
  {
    label: 'wrong-framework',
    context: { summary: 'route payload checks', frameworks: ['express'] },
    relevant: ['express-requests'],
  },
  {
    label: 'complementary-skills',
    context: { summary: 'sqlite startup retry and query plan indexes' },
    relevant: ['sqlite-retry', 'sqlite-retry-overlap', 'sqlite-query-plan'],
  },
];
export function seedHybridQuality(f: ReturnType<typeof retrievalFixture>) {
  const enhanced = {
    ...f,
    add: (d: Parameters<typeof f.add>[0]) => f.add({ ...d, metadata: hybridMetadata[d.name] }),
  };
  seedRoutingQuality(enhanced);
}

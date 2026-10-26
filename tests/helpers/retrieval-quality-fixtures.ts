export const retrievalCatalog = [
  { name: 'sqlite-retry', description: 'Retry SQLite startup busy errors with bounded backoff.' },
  {
    name: 'sqlite-query-plan',
    description: 'Inspect SQLite query plans and indexes for slow statements.',
  },
  {
    name: 'typescript-bounds',
    description: 'Repair TypeScript numeric clamp boundaries while preserving zero.',
  },
  {
    name: 'typescript-json',
    description: 'Validate TypeScript JSON fields and reject malformed records.',
  },
  {
    name: 'release-rollback',
    description: 'Revert an approved release with explicit version rollback evidence.',
  },
  {
    name: 'transaction-rollback',
    description: 'Rollback a SQLite database transaction atomically after write failure.',
  },
  {
    name: 'inspect-logs',
    description: 'Inspect bounded service log fields and redact sensitive metadata.',
  },
  { name: 'data-export', description: 'Export approved scoped tabular datasets as CSV records.' },
  { name: 'numeric-limits', description: 'Check numeric limits.' },
  {
    name: 'sqlite-retry-overlap',
    description: 'Retry SQLite connections with bounded backoff and recovery checkpoints.',
  },
  {
    name: 'template-review',
    description: 'Review Markdown templates and packaged supporting references.',
    resources: [
      {
        path: 'references/template.md',
        content: 'Review the intended placeholders before task-specific use.',
      },
    ],
  },
];
export const retrievalLabels = [
  { label: 'exact-name', query: 'sqlite-retry', relevant: ['sqlite-retry'] },
  { label: 'abbreviation', query: 'ts numeric clamp', relevant: ['typescript-bounds'] },
  {
    label: 'alternate-spelling',
    query: 'db transaction rollback',
    relevant: ['transaction-rollback'],
  },
  {
    label: 'same-topic-different-objective',
    query: 'sqlite query plan indexes',
    relevant: ['sqlite-query-plan'],
  },
  {
    label: 'overlap',
    query: 'sqlite bounded backoff',
    relevant: ['sqlite-retry', 'sqlite-retry-overlap'],
  },
  {
    label: 'little-metadata',
    query: 'numeric limits',
    relevant: ['numeric-limits', 'typescript-bounds'],
  },
  {
    label: 'multiple-plausible',
    query: 'rollback',
    relevant: ['release-rollback', 'transaction-rollback'],
  },
  { label: 'supporting-resource', query: 'template review', relevant: ['template-review'] },
  { label: 'log-inspection', query: 'inspect service logs', relevant: ['inspect-logs'] },
  { label: 'no-suitable-skill', query: 'astronomy optics telescope', relevant: [] },
  { label: 'cross-project-lookalike', query: 'quasar geometry adjacency', relevant: [] },
  { label: 'deprecated-history', query: 'retiredhelium', relevant: [] },
  { label: 'blocked-injected-description', query: 'clipboard routing', relevant: [] },
  {
    label: 'unsupported-semantic-paraphrase',
    query: 'obtain resilient embedded persistence access',
    relevant: ['sqlite-retry'],
  },
];

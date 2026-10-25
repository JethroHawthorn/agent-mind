import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AgentMindError } from '../errors.js';

export const BEHAVIORAL_POLICY = 'behavioral-contract-v1/disabled-execution-v1';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export function behavioralDigest(value: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, value]) => [k, canonical(value)]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
export const suiteSelectorSchema = z.strictObject({
  suite_id: z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/),
  suite_version: z.number().int().positive(),
  suite_digest: digest.optional(),
});
export const behavioralSuiteSchema = z.strictObject({
  schema_version: z.literal(1),
  id: z.string().min(1).max(100),
  version: z.number().int().positive(),
  purpose: z.literal('example-code-contract-only'),
  coverage: z.literal('not-native-cli-behavior'),
  tasks: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(80),
        required: z.boolean(),
        input: z.strictObject({
          value: z.number().finite(),
          min: z.number().finite(),
          max: z.number().finite(),
        }),
        assertion: z.literal('finite-number-equals'),
        expected: z.number().finite(),
      }),
    )
    .min(1)
    .max(32),
  required_limits: z.strictObject({
    wall_time_ms: z.number().int().positive().max(30000),
    memory_mb: z.number().int().positive().max(512),
    processes: z.number().int().positive().max(32),
    output_bytes: z.number().int().positive().max(65536),
    network: z.literal('denied'),
    filesystem: z.literal('disposable-readonly-root'),
  }),
});
export type BehavioralSuite = z.infer<typeof behavioralSuiteSchema>;
// Not exported: release-owned acceptance criteria. Callers receive parsed copies, never this object.
const clampSuite = behavioralSuiteSchema.parse({
  schema_version: 1,
  id: 'agentmind.clamp-contract',
  version: 1,
  purpose: 'example-code-contract-only',
  coverage: 'not-native-cli-behavior',
  tasks: [
    {
      id: 'lower',
      required: true,
      input: { value: -4, min: 0, max: 10 },
      assertion: 'finite-number-equals',
      expected: 0,
    },
    {
      id: 'upper',
      required: true,
      input: { value: 14, min: 0, max: 10 },
      assertion: 'finite-number-equals',
      expected: 10,
    },
    {
      id: 'in-range',
      required: true,
      input: { value: 6, min: 0, max: 10 },
      assertion: 'finite-number-equals',
      expected: 6,
    },
    {
      id: 'zero',
      required: false,
      input: { value: 0, min: 0, max: 10 },
      assertion: 'finite-number-equals',
      expected: 0,
    },
  ],
  required_limits: {
    wall_time_ms: 3000,
    memory_mb: 128,
    processes: 16,
    output_bytes: 8192,
    network: 'denied',
    filesystem: 'disposable-readonly-root',
  },
});
export const DEFAULT_BEHAVIORAL_SUITE = 'agentmind.clamp-contract';
export function listBehavioralSuites() {
  return [
    {
      definition: behavioralSuiteSchema.parse(clampSuite),
      digest: behavioralDigest(clampSuite),
      execution_accepted: false as const,
    },
  ];
}
export function resolveBehavioralSuite(input: unknown) {
  const p = suiteSelectorSchema.parse(input);
  if (p.suite_id !== clampSuite.id || p.suite_version !== clampSuite.version) return null;
  const hash = behavioralDigest(clampSuite);
  if (p.suite_digest !== undefined && p.suite_digest !== hash)
    throw new AgentMindError('BEHAVIORAL_SUITE_INTEGRITY', 'Trusted suite digest does not match.');
  return { definition: behavioralSuiteSchema.parse(clampSuite), digest: hash };
}
const observation = z.strictObject({
  status: z.enum(['complete', 'timeout', 'interrupted']),
  outputs: z
    .array(z.strictObject({ task_id: z.string().min(1).max(80), value: z.number().finite() }))
    .max(32),
});
/** Pure unit-testable comparison, NOT an execution receipt or approval authority. */
export function compareBehavioralContract(input: unknown) {
  const p = suiteSelectorSchema
    .extend({ baseline: observation.nullable(), candidate: observation.nullable() })
    .parse(input);
  const suite = resolveBehavioralSuite({
    suite_id: p.suite_id,
    suite_version: p.suite_version,
    ...(p.suite_digest ? { suite_digest: p.suite_digest } : {}),
  });
  if (!suite)
    return {
      comparison_result: 'NOT_VERIFIED' as const,
      authorization_result: 'NOT_VERIFIED' as const,
      cases: [],
      reason: 'UNSUPPORTED_SUITE',
    };
  const result = (data: z.infer<typeof observation> | null, id: string, expected: number) => {
    const values = data?.outputs.filter((o) => o.task_id === id) ?? [];
    if (data?.status !== 'complete' || values.length !== 1) return 'NOT_VERIFIED' as const;
    return values[0]?.value === expected ? ('PASS' as const) : ('FAIL' as const);
  };
  const allowed = new Set(suite.definition.tasks.map((t) => t.id));
  if ([p.baseline, p.candidate].some((o) => o?.outputs.some((v) => !allowed.has(v.task_id))))
    throw new AgentMindError('INVALID_BEHAVIORAL_OBSERVATION', 'Unexpected fixture output.');
  const cases = suite.definition.tasks.map((t) => ({
    id: t.id,
    required: t.required,
    baseline: result(p.baseline, t.id, t.expected),
    candidate: result(p.candidate, t.id, t.expected),
  }));
  const mandatory = cases.filter((t) => t.required);
  const comparison = mandatory.some((t) => t.candidate === 'FAIL')
    ? 'FAIL'
    : mandatory.some((t) => t.candidate === 'NOT_VERIFIED' || t.baseline === 'NOT_VERIFIED')
      ? 'NOT_VERIFIED'
      : 'PASS';
  return {
    comparison_result: comparison,
    authorization_result: 'NOT_VERIFIED' as const,
    cases,
    reason:
      'Caller-supplied observations are contract data, never authenticated execution evidence.',
  };
}
export const behavioralEvidenceSchema = z.strictObject({
  schema_version: z.literal(1),
  policy_version: z.literal(BEHAVIORAL_POLICY),
  project_id: digest,
  evaluation_id: z.uuid(),
  candidate: z.strictObject({ version_id: z.uuid(), digest }),
  baseline: z
    .strictObject({
      version_id: z.uuid(),
      digest,
      identity_revision: z.number().int().nonnegative(),
    })
    .nullable(),
  selector: suiteSelectorSchema,
  suite: z
    .strictObject({ id: z.string(), version: z.number().int().positive(), digest })
    .nullable(),
  execution: z.strictObject({
    backend: z.literal('disabled'),
    accepted_environment: z.null(),
    candidate_observation: z.null(),
    baseline_observation: z.null(),
    result: z.literal('NOT_VERIFIED'),
    candidate_result: z.literal('NOT_VERIFIED'),
    baseline_result: z.literal('NOT_VERIFIED'),
    reason: z.literal('NO_ACCEPTED_ISOLATION_BACKEND'),
  }),
  comparison_result: z.literal('NOT_VERIFIED'),
  evaluation_digest: digest,
});
/** No injectable callbacks, scripts, commands, subprocesses, network or environment override. */
export function disabledBehavioralExecution() {
  return {
    backend: 'disabled' as const,
    accepted_environment: null,
    candidate_observation: null,
    baseline_observation: null,
    result: 'NOT_VERIFIED' as const,
    candidate_result: 'NOT_VERIFIED' as const,
    baseline_result: 'NOT_VERIFIED' as const,
    reason: 'NO_ACCEPTED_ISOLATION_BACKEND' as const,
  };
}

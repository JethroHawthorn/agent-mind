import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AgentMindError } from '../errors.js';
export const CURATOR_POLICY = 'advisory-rules-v1';
export const ADVISORY_WARNING =
  'Recommendations are untrusted advisory data, never authorization. Associations do not establish causation, effectiveness or task success.';
export const curatorPolicySchema = z.strictObject({
  schema_version: z.literal(1).default(1),
  min_failures: z.number().int().min(2).max(10).default(2),
  stale_days: z.number().int().min(30).max(3650).default(90),
  maintenance_days: z.number().int().min(1).max(90).default(30),
  min_observed_sessions: z.number().int().min(2).max(10).default(2),
  max_skills: z.number().int().min(1).max(100).default(40),
  max_events: z.number().int().min(1).max(2000).default(1000),
  max_recommendations: z.number().int().min(1).max(60).default(60),
  budget_ms: z.number().int().min(250).max(5000).default(2000),
  rules: z
    .strictObject({
      failures: z.boolean().default(true),
      experiences: z.boolean().default(true),
      stale: z.boolean().default(true),
      overlap: z.boolean().default(true),
      opportunity: z.boolean().default(true),
    })
    .default({ failures: true, experiences: true, stale: true, overlap: true, opportunity: true }),
});
export type CuratorPolicy = z.infer<typeof curatorPolicySchema>;
export const curatorAnalyzeSchema = z.strictObject({});
export const curatorListSchema = z.strictObject({
  state: z.enum(['open', 'dismissed', 'superseded', 'all']).default('open'),
  skill_id: z.uuid().optional(),
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).max(10000).default(0),
});
export const curatorGetSchema = z.strictObject({ recommendation_id: z.uuid() });
export const curatorDismissSchema = curatorGetSchema.extend({
  expected_revision: z.number().int().nonnegative(),
});
export const evidenceReferenceSchema = z.strictObject({
  kind: z.enum(['usage', 'experience', 'evaluation', 'skill_version']),
  id: z.uuid(),
});
export const draftRecommendationSchema = z
  .strictObject({
    schema_version: z.literal(1).default(1),
    skill_id: z.uuid(),
    version_id: z.uuid(),
    rule_id: z.string().min(1).max(64),
    related_version_id: z.uuid().optional(),
    type: z.enum([
      'IMPROVE',
      'INVESTIGATE',
      'POSSIBLE_DUPLICATE',
      'POSSIBLE_STALE',
      'CONSOLIDATE',
      'REVIEW',
    ]),
    priority: z.enum(['HIGH', 'MEDIUM', 'LOW']),
    priority_reason: z.string().max(512),
    confidence: z.enum(['MEDIUM', 'LOW']),
    confidence_reason: z.string().max(512),
    evidence: z.array(evidenceReferenceSchema).min(1).max(32),
    limitations: z.array(z.string().max(512)).max(16),
    explanation: z.string().min(1).max(1500),
    suggested_action: z.string().min(1).max(512),
  })
  .refine(
    (v) => Buffer.byteLength(JSON.stringify(v)) <= 8192,
    'Recommendation payload exceeds bound.',
  );
export type RecommendationDraft = z.infer<typeof draftRecommendationSchema>;
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;
export function curatorDigest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function curatorId(fingerprint: string) {
  return `${fingerprint.slice(0, 8)}-${fingerprint.slice(8, 12)}-4${fingerprint.slice(13, 16)}-a${fingerprint.slice(17, 20)}-${fingerprint.slice(20, 32)}`;
}
export type Coverage = {
  skills_truncated: boolean;
  events_truncated: boolean;
  experiences_truncated: boolean;
  recommendations_truncated: boolean;
};
export const workerResultSchema = z.strictObject({
  drafts: z.array(draftRecommendationSchema).max(60),
  source_digest: z.string().regex(/^[a-f0-9]{64}$/),
  coverage: z.strictObject({
    skills_truncated: z.boolean(),
    events_truncated: z.boolean(),
    experiences_truncated: z.boolean(),
    recommendations_truncated: z.boolean(),
  }),
});

export function parseCurator<T>(schema: z.ZodType<T>, input: unknown): T {
  try {
    if (Buffer.byteLength(JSON.stringify(input)) > 8192) throw new Error('bound');
    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data;
  } catch {}
  throw new AgentMindError('CURATOR_INVALID_INPUT', 'Invalid or oversized advisory request.');
}

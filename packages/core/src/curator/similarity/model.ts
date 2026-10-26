import { z } from 'zod';
export const FEATURE_POLICY = 'instruction-features-v2';
export const DETECTION_POLICY = 'duplicate-signals-v2';
export const duplicateOptionsSchema = z.strictObject({
  include_candidates: z.boolean().default(false),
  include_inactive: z.boolean().default(false),
});
export const compareRequestSchema = duplicateOptionsSchema.extend({
  left_version_id: z.uuid(),
  right_version_id: z.uuid(),
});
export const duplicatePolicySchema = z.strictObject({
  max_skills: z.number().int().min(2).max(5000).default(1000),
  max_pairs: z.number().int().min(1).max(10000).default(5000),
  bucket_limit: z.number().int().min(2).max(32).default(16),
  near_threshold: z.number().min(0.7).max(1).default(0.8),
  overlap_threshold: z.number().min(0.2).max(0.7).default(0.35),
});
export type DuplicatePolicy = z.infer<typeof duplicatePolicySchema>;
export const classificationSchema = z.enum([
  'EXACT_DUPLICATE',
  'NEAR_DUPLICATE',
  'POSSIBLE_OVERLAP',
  'POSSIBLE_CONFLICT',
  'INSUFFICIENT_EVIDENCE',
  'NOT_RELATED',
]);
export const pairResultSchema = z.strictObject({
  classification: classificationSchema,
  evidence_strength: z.enum(['PACKAGE_IDENTITY', 'LEXICAL', 'INSUFFICIENT']),
  metrics: z.strictObject({
    token_jaccard: z.number().min(0).max(1),
    shingle_jaccard: z.number().min(0).max(1),
    matched_workflow_sections: z.number().int().min(0).max(5),
  }),
  matched_signals: z.array(z.string().max(128)).max(12),
});
export const triageSchema = z.strictObject({
  suggestion: z.enum([
    'REVIEW_EXISTING_SKILL',
    'CONSIDER_UPDATE_EXISTING_SKILL',
    'CONSIDER_NEW_SKILL',
    'NEEDS_HUMAN_REVIEW',
    'NEEDS_MORE_EVIDENCE',
  ]),
  authorization: z.literal('NONE'),
});
export function suggestTriage(
  classification: z.infer<typeof classificationSchema>,
): z.infer<typeof triageSchema> {
  const mapping = {
    EXACT_DUPLICATE: 'REVIEW_EXISTING_SKILL',
    NEAR_DUPLICATE: 'CONSIDER_UPDATE_EXISTING_SKILL',
    POSSIBLE_OVERLAP: 'CONSIDER_UPDATE_EXISTING_SKILL',
    POSSIBLE_CONFLICT: 'NEEDS_HUMAN_REVIEW',
    INSUFFICIENT_EVIDENCE: 'NEEDS_MORE_EVIDENCE',
    NOT_RELATED: 'CONSIDER_NEW_SKILL',
  } as const;
  return { suggestion: mapping[classification], authorization: 'NONE' };
}
export const comparisonSchema = pairResultSchema.extend({
  left_skill_id: z.uuid(),
  right_skill_id: z.uuid(),
  left_version_id: z.uuid(),
  right_version_id: z.uuid(),
  left_digest: z.string().regex(/^[a-f0-9]{64}$/),
  right_digest: z.string().regex(/^[a-f0-9]{64}$/),
  policy_version: z.enum(['duplicate-signals-v1', DETECTION_POLICY]),
  triage: triageSchema.optional(),
});
export const featureSchema = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  instructions: z.string(),
  resources: z.string(),
  tokens: z.array(z.string()).max(96),
  shingles: z.array(z.string()).max(128),
  sections: z.array(z.array(z.string()).max(32)).length(5),
  positive: z.array(z.string()).max(32),
  negative: z.array(z.string()).max(32),
  truncated: z.boolean(),
});
export type Features = z.infer<typeof featureSchema>;
export type PairResult = z.infer<typeof pairResultSchema>;
export type Comparison = z.infer<typeof comparisonSchema>;

/** Future caller-controlled review contract only: no provider, invocation, authority or trusted evidence upgrade. */
export type AdvisoryPairReview = Readonly<{
  comparison: Comparison;
  evidence_version_ids: readonly [string, string];
  authorization: 'separate-reviewed-budget-required';
  output_kind: 'untrusted-advisory-proposal';
}>;
export const SIMILARITY_LIMITATIONS = [
  'Lexical similarity is not semantic or behavioral equivalence or safe interchangeability.',
  'Mandatory polarity checks do not detect general natural-language contradictions.',
  'No code or model was executed. SEC-01 protected deployment and BE-001 behavioral execution remain unverified.',
];

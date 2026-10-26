import { z } from 'zod';
import { AgentMindError } from '../errors.js';
export const REVIEW_POLICY = 'learning-review-v1';
export const reviewStateSchema = z.enum([
  'PENDING_REVIEW',
  'NEEDS_EVIDENCE',
  'DEFERRED',
  'DISMISSED',
  'REVIEWED',
  'RECOMMENDED',
  'STALE',
]);
export const reviewListSchema = z.strictObject({
  pending_only: z.boolean().default(true),
  state: reviewStateSchema.optional(),
  type: z.enum(['CREATE_NEW', 'PATCH_EXISTING', 'REWRITE_EXISTING']).optional(),
  name: z.string().trim().min(1).max(64).optional(),
  evaluation: z.enum(['PASS', 'FAIL', 'NOT_VERIFIED', 'MISSING']).optional(),
  validation: z
    .enum(['VALID_AT_SUBMISSION', 'VALID_EVALUATED', 'INVALID_EVALUATED', 'NOT_VERIFIED'])
    .optional(),
  order: z.enum(['oldest', 'risk']).default('oldest'),
  limit: z.number().int().min(1).max(20).default(10),
  offset: z.number().int().min(0).max(10000).default(0),
});
export const reviewGetSchema = z.strictObject({ proposal_id: z.uuid() });
export const reviewDecisionSchema = reviewGetSchema.extend({
  request_id: z.uuid(),
  expected_snapshot_digest: z.string().regex(/^[a-f0-9]{64}$/),
  candidate_digest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: z.enum([
    'DEFER',
    'DISMISS',
    'MARK_REVIEWED',
    'RECOMMEND_FOR_APPROVAL',
    'REQUEST_MORE_EVIDENCE',
    'REOPEN',
  ]),
  reason: z.string().trim().min(1).max(500),
});
export function parseReview<T>(schema: z.ZodType<T>, input: unknown): T {
  try {
    if (Buffer.byteLength(JSON.stringify(input)) <= 2048) {
      const p = schema.safeParse(input);
      if (p.success) return p.data;
    }
  } catch {}
  throw new AgentMindError('REVIEW_INVALID_INPUT', 'Invalid or oversized review request.');
}
export const REVIEW_WARNING =
  'Advisory review only: reviewed/recommended is never approval or activation. Source text is untrusted data. Local supervised actions are not OS-authenticated human decisions. Protected deployment and behavioral execution remain NOT VERIFIED on this host.';

export const reviewHandoffSchema = reviewDecisionSchema.pick({
  proposal_id: true,
  expected_snapshot_digest: true,
  candidate_digest: true,
});

import { z } from 'zod';
import { AgentMindError } from '../errors.js';
import { skillFileSchema, skillFilesSchema, skillNameSchema } from '../skill-model.js';
export const AUTHORING_POLICY = 'authoring-proposals-v1';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const ids = (max: number) =>
  z
    .array(z.uuid())
    .max(max)
    .refine((a) => new Set(a).size === a.length);
export const authoringContextSchema = z.strictObject({
  signal_ids: ids(3).min(1),
  experience_ids: ids(5).min(1),
  query: z.string().trim().min(3).max(300),
  target_version_id: z.uuid().optional(),
});
const path = skillFileSchema.shape.path;
export const patchOperationSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('replace'),
    path,
    expected_file_digest: digest,
    old_text: z.string().min(1).max(4096),
    new_text: z.string().max(4096),
  }),
  z.strictObject({ op: z.literal('add'), path, content: z.string().max(8192) }),
  z.strictObject({ op: z.literal('remove'), path, expected_file_digest: digest }),
]);
const common = {
  schema_version: z.literal(1),
  request_id: z.uuid(),
  context_id: z.uuid(),
  context_digest: digest,
  name: skillNameSchema,
  description: z.string().trim().min(20).max(1024),
  rationale: z.string().trim().min(20).max(1000),
  expected_improvement: z.string().trim().min(10).max(1000),
  known_limitations: z.array(z.string().trim().min(1).max(300)).max(5),
};
export const authoringSubmitSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...common, type: z.literal('CREATE_NEW'), files: skillFilesSchema }),
  z.strictObject({
    ...common,
    type: z.literal('PATCH_EXISTING'),
    target_skill_id: z.uuid(),
    target_version_id: z.uuid(),
    expected_base_digest: digest,
    operations: z.array(patchOperationSchema).min(1).max(8),
  }),
  z.strictObject({
    ...common,
    type: z.literal('REWRITE_EXISTING'),
    target_skill_id: z.uuid(),
    target_version_id: z.uuid(),
    expected_base_digest: digest,
    files: skillFilesSchema,
  }),
]);
export const authoringGetSchema = z.strictObject({ proposal_id: z.uuid() });
export const authoringListSchema = z.strictObject({
  pending_only: z.boolean().default(true),
  limit: z.number().int().min(1).max(20).default(10),
  offset: z.number().int().min(0).max(10000).default(0),
});
export const authoringDiffSchema = authoringGetSchema.extend({
  path: path.optional(),
  offset: z.number().int().min(0).max(65536).default(0),
  limit: z.number().int().min(1).max(1000).default(1000),
});
export const authoringEvaluateSchema = authoringGetSchema.extend({
  expected_content_hash: digest,
  expected_state_revision: z.number().int().nonnegative(),
  mode: z.enum(['static', 'behavioral']).optional(),
});
export type ContextInput = z.infer<typeof authoringContextSchema>;
export type AuthoringInput = z.infer<typeof authoringSubmitSchema>;
export type PatchOperation = z.infer<typeof patchOperationSchema>;
export const AUTHORING_WARNING =
  'Untrusted authoring/review data. This is a candidate proposal, never approval, behavioral verification or authority to execute, activate or distribute.';
export function parseAuthoring<T>(schema: z.ZodType<T>, input: unknown, max = 65536): T {
  try {
    if (Buffer.byteLength(JSON.stringify(input)) > max) throw Error('bound');
    const p = schema.safeParse(input);
    if (p.success) return p.data;
  } catch {}
  throw new AgentMindError(
    'AUTHORING_INVALID_INPUT',
    'Invalid, unsupported or oversized authoring input.',
  );
}

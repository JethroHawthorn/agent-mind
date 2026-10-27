import { createHash } from 'node:crypto';
import { z } from 'zod';
import { sourceAgentSchema } from './source-agent.js';

const id = z.uuid();
const projectId = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime({ precision: 3 });
export const skillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const skillStatusSchema = z.enum(['candidate', 'approved', 'rejected']);
export const skillEvaluationResultSchema = z.enum(['PASS', 'FAIL', 'NOT_VERIFIED']);
export const skillFileSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(240)
    .refine(
      (path) => path.split('/').every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part)),
      'Expected a relative file path without dot segments.',
    ),
  content: z.string().max(65536),
});
export const skillFilesSchema = z
  .array(skillFileSchema)
  .min(1)
  .max(32)
  .refine(
    (files) =>
      files.some((file) => file.path === 'SKILL.md') &&
      new Set(files.map((file) => file.path.toLowerCase())).size === files.length &&
      Buffer.byteLength(JSON.stringify(files), 'utf8') <= 262144,
    'A bounded file snapshot must include SKILL.md and have unique paths.',
  );

/** Record schemas describe trusted persistence records, not LLM request authority. */
export const skillIdentitySchema = z
  .strictObject({
    id,
    project_id: projectId,
    name: skillNameSchema,
    description: z.string().trim().min(1).max(1024),
    active_version_id: id.nullable(),
    last_transition_id: id.nullable(),
    revision: z.number().int().nonnegative(),
    created_at: timestamp,
    updated_at: timestamp,
  })
  .refine((value) => value.active_version_id === null || value.last_transition_id !== null);
export const skillVersionSchema = z
  .strictObject({
    id,
    skill_id: id,
    project_id: projectId,
    version: z.number().int().positive(),
    description: z.string().trim().min(1).max(1024),
    files: skillFilesSchema,
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    source_agent: sourceAgentSchema,
    created_at: timestamp,
  })
  .refine(
    (value) => value.content_hash === hashSkillFiles(value.files),
    'Skill content hash does not match its immutable file snapshot.',
  );
export const skillVersionSourceSchema = z.strictObject({
  version_id: id,
  skill_id: id,
  project_id: projectId,
  experience_id: id,
  experience_review_id: id,
  experience_updated_at: timestamp,
});
export const skillVersionStateSchema = z.strictObject({
  version_id: id,
  skill_id: id,
  project_id: projectId,
  status: skillStatusSchema,
  latest_evaluation_id: id.nullable(),
  review_id: id.nullable(),
  revision: z.number().int().nonnegative(),
  updated_at: timestamp,
});
export const skillEvaluationCheckSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  result: skillEvaluationResultSchema,
  details: z.string().max(2000),
});
export const skillEvaluationSchema = z
  .strictObject({
    id,
    version_id: id,
    skill_id: id,
    project_id: projectId,
    evaluator: z.string().trim().min(1).max(100),
    evaluator_version: z.string().min(1).max(100),
    result: skillEvaluationResultSchema,
    checks: z.array(skillEvaluationCheckSchema).min(1).max(64),
    baseline_version_id: id.nullable(),
    regression_result: skillEvaluationResultSchema,
    content_hash: z.string().regex(/^[a-f0-9]{64}$/),
    created_at: timestamp,
  })
  .refine(
    (value) =>
      value.result !== 'PASS' ||
      (value.checks.every((check) => check.result === 'PASS') &&
        (value.baseline_version_id === null || value.regression_result === 'PASS')),
    'PASS requires passing checks and any required regression comparison.',
  );
export const skillReviewSchema = z.strictObject({
  id,
  version_id: id,
  skill_id: id,
  project_id: projectId,
  decision: z.enum(['approved', 'rejected']),
  evaluation_id: id.nullable(),
  reviewer: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(1).max(2000),
  created_at: timestamp,
});
export const skillPromotionSchema = z
  .strictObject({
    id,
    skill_id: id,
    project_id: projectId,
    from_version_id: id.nullable(),
    to_version_id: id.nullable(),
    approval_id: id.nullable(),
    action: z.enum(['promote', 'rollback', 'deactivate']),
    expected_revision: z.number().int().nonnegative(),
    actor: z.string().trim().min(1).max(100),
    reason: z.string().trim().min(1).max(2000),
    created_at: timestamp,
  })
  .refine(
    (value) =>
      value.from_version_id !== value.to_version_id &&
      (value.action === 'deactivate'
        ? value.to_version_id === null && value.approval_id === null
        : value.to_version_id !== null && value.approval_id !== null),
  );

export type SkillIdentity = z.infer<typeof skillIdentitySchema>;
export type SkillVersion = z.infer<typeof skillVersionSchema>;
export type SkillVersionSource = z.infer<typeof skillVersionSourceSchema>;
export type SkillVersionState = z.infer<typeof skillVersionStateSchema>;
export type SkillEvaluation = z.infer<typeof skillEvaluationSchema>;
export type SkillReview = z.infer<typeof skillReviewSchema>;
export type SkillPromotion = z.infer<typeof skillPromotionSchema>;

/** Stable file-order-independent hash. This does not validate YAML or certify safety. */
export function hashSkillFiles(input: unknown): string {
  const files = skillFilesSchema.parse(input);
  const canonical = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(({ path, content }) => ({ path, content }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export type SkillEvaluationCheck = z.infer<typeof skillEvaluationCheckSchema>;

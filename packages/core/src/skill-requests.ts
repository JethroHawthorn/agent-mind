import { z } from 'zod';
import { skillFilesSchema, skillNameSchema } from './skill-model.js';

export const skillProposeSchema = z.strictObject({
  name: skillNameSchema,
  description: z.string().trim().min(1).max(1024),
  files: skillFilesSchema,
  source_experience_ids: z
    .array(z.uuid())
    .min(1)
    .max(32)
    .refine((ids) => new Set(ids).size === ids.length),
  expected_latest_version: z.number().int().nonnegative().default(0),
});
export const skillListSchema = z.strictObject({
  status: z.enum(['visible', 'active', 'candidate', 'approved', 'rejected']).default('visible'),
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).max(10000).default(0),
});
export const skillSearchSchema = skillListSchema.extend({
  query: z.string().trim().min(1).max(500),
});
export const skillGetSchema = z.union([
  z.strictObject({ version_id: z.uuid() }),
  z.strictObject({ name: skillNameSchema, version: z.number().int().positive().optional() }),
]);
export type SkillProposalInput = z.infer<typeof skillProposeSchema>;

export const skillValidateSchema = z.strictObject({ version_id: z.uuid() });

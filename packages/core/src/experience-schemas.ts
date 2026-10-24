import { z } from 'zod';

export const evidenceSchema = z.strictObject({
  kind: z.enum(['test', 'file', 'commit', 'issue', 'url', 'note']),
  reference: z.string().trim().min(1).max(512),
  summary: z.string().trim().max(512).default(''),
});

export const experienceRecordSchema = z
  .strictObject({
    problem: z.string().trim().min(1).max(2000),
    solution: z.string().trim().min(1).max(4000),
    outcome: z.strictObject({
      status: z.enum(['succeeded', 'failed', 'partial', 'unknown']),
      summary: z.string().trim().min(1).max(1000),
    }),
    evidence: z.array(evidenceSchema).max(8).default([]),
    provenance: z
      .strictObject({
        task_ref: z.string().trim().min(1).max(200).optional(),
        commit: z
          .string()
          .regex(/^[a-fA-F0-9]{7,64}$/)
          .optional(),
      })
      .default({}),
  })
  .refine(
    (value) => JSON.stringify(value).length <= 16000,
    'Experience exceeds the total size limit.',
  );

export const experienceSearchSchema = z.strictObject({
  query: z.string().trim().min(1).max(500),
  status: z.enum(['candidate', 'approved', 'visible']).default('visible'),
  limit: z.number().int().min(1).max(10).default(3),
  max_chars: z.number().int().min(1024).max(16000).default(8000),
});

// Used only by the trusted local review entrypoint, never registered as an MCP tool.
export const experienceReviewSchema = z.strictObject({
  id: z.uuid(),
  decision: z.enum(['approved', 'rejected']),
  expected_updated_at: z.iso.datetime(),
  reviewer: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(1).max(1000),
});

export type ExperienceInput = z.infer<typeof experienceRecordSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;

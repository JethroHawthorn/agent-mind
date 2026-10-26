import { isAbsolute } from 'node:path';
import { z } from 'zod';
export const enrollmentSchema = z.strictObject({
  schema_version: z.literal(1),
  integration: z.literal('agentmind-codex-v1'),
  installation_id: z.uuid(),
  project_root: z.string(),
  project_id: z.string().regex(/^[a-f0-9]{64}$/),
  database: z.string().refine(isAbsolute),
  mode: z.literal('supervised-local'),
});

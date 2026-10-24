import { z } from 'zod';

export const saveSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(4000),
  kind: z.enum(['fact', 'decision', 'preference']).default('fact'),
});
export const searchSchema = z.strictObject({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(20).default(5),
});
export type SaveInput = z.infer<typeof saveSchema>;

import { z } from 'zod';
export const ROUTING_POLICY = 'context-routing-v1';
const hints = z.array(z.string().trim().min(1).max(32)).max(3).default([]);
export const skillRouteSchema = z.strictObject({
  context: z.strictObject({
    summary: z.string().trim().min(1).max(500),
    languages: hints,
    frameworks: hints,
    file_types: hints,
    diagnostic: z.string().trim().min(1).max(80).optional(),
    intent: z.string().trim().min(1).max(80).optional(),
    phase: z.string().trim().min(1).max(32).optional(),
    exclude_terms: z.array(z.string().trim().min(1).max(32)).max(6).default([]),
  }),
  limit: z.number().int().min(1).max(10).optional(),
});
export const routingConfigSchema = z.strictObject({
  top_k: z.number().int().min(1).max(10).default(5),
  description_chars: z.number().int().min(40).max(240).default(160),
  response_bytes: z.number().int().min(1024).max(8192).default(4096),
  cache_entries: z.number().int().min(0).max(64).default(32),
  cache_bytes: z.number().int().min(0).max(1048576).default(131072),
  cache_ttl_ms: z.number().int().min(1).max(300000).default(30000),
  single_min_terms: z.number().int().min(2).max(12).default(2),
  single_min_gap: z.number().int().min(1).max(12).default(2),
});
export type RoutingConfig = z.infer<typeof routingConfigSchema>;
export type TaskContext = z.infer<typeof skillRouteSchema>['context'];

import { z } from 'zod';
import { type SourceAgent, sourceAgentSchema } from './source-agent.js';

export const usageEventTypeSchema = z.enum([
  'installed',
  'discovered',
  'invoked',
  'executed',
  'task_succeeded',
  'task_failed',
  'task_unknown',
]);
export const usageReportSchema = z.strictObject({
  event_id: z.uuid(),
  schema_version: z.literal(1),
  timestamp: z.iso.datetime({ offset: true }).optional(),
  version_id: z.uuid(),
  artifact_digest: z.string().regex(/^[a-f0-9]{64}$/),
  event_type: usageEventTypeSchema.exclude(['installed']),
  installation_id: z.uuid().optional(),
  session_id: z.string().min(1).max(200).optional(),
  task_id: z.string().min(1).max(200).optional(),
  evidence_reference: z.string().min(1).max(512).optional(),
  note: z.string().max(512).optional(),
});
export const usageQuerySchema = z.strictObject({
  skill_id: z.uuid().optional(),
  version_id: z.uuid().optional(),
  source_cli: sourceAgentSchema.optional(),
  event_type: usageEventTypeSchema.optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  until: z.iso.datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(10000).default(0),
});
export const usageSummarySchema = usageQuerySchema.omit({ limit: true, offset: true });
export const usageOutcomeSchema = z.strictObject({
  report: usageReportSchema,
  acceptance_criteria: z.array(z.string().min(1).max(256)).min(1).max(16),
  coverage: z.enum(['complete', 'partial', 'unknown']),
});
export const usageRetentionSchema = z.strictObject({
  days: z.number().int().min(1).max(36500),
  batch_size: z.number().int().min(1).max(1000).default(1000),
});
export type UsageReport = z.infer<typeof usageReportSchema>;
export type UsageSource = SourceAgent;
export type UsageEvidence = {
  category:
    | 'llm_reported'
    | 'registry_install'
    | 'mcp_observation'
    | 'native_hook'
    | 'test_runner'
    | 'operator_confirmed';
  method: string;
  verification: 'unverified' | 'observed' | 'verified_check' | 'operator_confirmed';
  details: Record<string, unknown>;
};
export type UsageEvent = {
  event_id: string;
  schema_version: 1;
  project_id: string;
  skill_id: string;
  version_id: string;
  artifact_digest: string;
  timestamp: string;
  received_at: string;
  source_cli: UsageSource;
  event_type: string;
  installation_id: string | null;
  session_id: string | null;
  task_id: string | null;
  evidence_reference: string | null;
  note: string | null;
  category: UsageEvidence['category'];
  method: string;
  verification: UsageEvidence['verification'];
  details: Record<string, unknown>;
};

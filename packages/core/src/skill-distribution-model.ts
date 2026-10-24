import { z } from 'zod';
import { skillNameSchema } from './skill-model.js';

export const distributionRequestSchema = z.strictObject({
  skill_id: z.uuid(),
  target: z.enum(['codex', 'claude', 'all']),
  scope: z.enum(['project', 'user']),
  operation: z.enum(['sync', 'remove']).default('sync'),
});
export type DistributionRequest = z.infer<typeof distributionRequestSchema>;
export const installationManifestSchema = z.strictObject({
  schema_version: z.literal(1),
  agentmind_managed: z.literal(true),
  registry_id: z.uuid(),
  installation_id: z.uuid(),
  skill_id: z.uuid(),
  skill_name: skillNameSchema,
  project_id: z.string().regex(/^[a-f0-9]{64}$/),
  version_id: z.uuid(),
  version: z.number().int().positive(),
  scope: z.enum(['project', 'user']),
  target: z.enum(['codex', 'claude']),
  destination: z.string().min(1).max(4096),
  registry_digest: z.string().regex(/^[a-f0-9]{64}$/),
  installed_digest: z.string().regex(/^[a-f0-9]{64}$/),
  installed_at: z.iso.datetime({ precision: 3 }),
});
export type InstallationManifest = z.infer<typeof installationManifestSchema>;
export type InstallationRecord = {
  id: string;
  project_id: string;
  skill_id: string;
  version_id: string;
  target: 'codex' | 'claude';
  scope: 'project' | 'user';
  destination: string;
  installed_digest: string;
  manifest_json: string;
  manifest_hash: string;
  root_identity: string;
  status: 'installed' | 'removed';
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
};
export type DistributionAction = 'INSTALL' | 'UPDATE' | 'REMOVE' | 'SKIP' | 'CONFLICT' | 'REPAIR';
export type DistributionPlanEntry = {
  skill_id: string;
  name: string;
  project_id: string;
  target: 'codex' | 'claude';
  scope: 'project' | 'user';
  destination: string;
  version_id: string | null;
  version: number | null;
  content_digest: string | null;
  action: DistributionAction;
  reason: string;
  current_status: string;
  record: InstallationRecord | null;
  filesystem: unknown;
  parents: unknown;
  pending: DistributionIntent | null;
  artifact_diff: ReturnType<typeof import('./skill-review.js').diffSkillFiles>;
};
export type DistributionIntent = {
  id: string;
  project_id: string;
  skill_id: string;
  target: 'codex' | 'claude';
  scope: 'project' | 'user';
  destination: string;
  action: string;
  manifest_json: string | null;
  manifest_hash: string | null;
  old_record_json: string | null;
  worker_id: string;
  stage_identity: string | null;
  status: 'pending' | 'completed' | 'aborted';
  operator_id: string;
  session_id: string;
  context_digest: string;
  created_at: string;
};

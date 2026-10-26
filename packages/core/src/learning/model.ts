import { z } from 'zod';
import { AgentMindError } from '../errors.js';
import { type Evidence, evidenceSchema } from '../experience-schemas.js';
export const LEARNING_POLICY = 'learning-triage-v1';
export const signalTypeSchema = z.enum([
  'PROBLEM_SOLVED',
  'USER_CORRECTION',
  'REUSABLE_WORKFLOW',
  'REPEATED_FAILURE',
  'SKILL_GAP',
  'SKILL_CONFLICT',
  'NEW_PATTERN',
]);
export const signalEvidenceSchema = z.strictObject({
  kind: z.enum(['experience', 'evaluation', 'usage', 'skill_version', 'recommendation']),
  id: z.uuid(),
});
export const learningRecordSchema = z.strictObject({
  schema_version: z.literal(1),
  type: signalTypeSchema,
  title: z.string().trim().min(4).max(120),
  summary: z.string().trim().min(4).max(1000),
  evidence: z.array(signalEvidenceSchema).max(8).default([]),
  supporting_evidence: z.array(evidenceSchema).max(3).default([]),
  experience_ids: z.array(z.uuid()).max(4).default([]),
  version_ids: z.array(z.uuid()).max(4).default([]),
  session_ref: z.string().min(1).max(160).optional(),
  task_ref: z.string().min(1).max(160).optional(),
  reusability: z.enum(['unknown', 'task_specific', 'potentially_reusable']).default('unknown'),
});
export const learningIdSchema = z.strictObject({ signal_id: z.uuid() });
export const learningRefreshSchema = learningIdSchema.extend({
  expected_revision: z.number().int().nonnegative(),
});
export const learningStateSchema = learningRefreshSchema.extend({
  state: z.enum(['dismissed', 'superseded']),
});
export const learningListSchema = z.strictObject({
  status: z.enum(['open', 'dismissed', 'superseded', 'all']).default('open'),
  limit: z.number().int().min(1).max(20).default(10),
  offset: z.number().int().min(0).max(10000).default(0),
});
export const learningDetectSchema = z.strictObject({
  limit: z.number().int().min(1).max(30).default(10),
});
export const learningActionSchema = z.enum([
  'IGNORE',
  'RECORD_EXPERIENCE',
  'INVESTIGATE',
  'POTENTIAL_SKILL_UPDATE',
  'POTENTIAL_NEW_SKILL',
]);
export type SignalInput = z.infer<typeof learningRecordSchema>;
export type SignalEvidence = z.infer<typeof signalEvidenceSchema>;
export type SignalOrigin = {
  source_agent: 'codex' | 'claude' | 'unknown';
  adapter: 'explicit-mcp-v1' | 'explicit-cli-v1' | 'deterministic-records-v1';
  detection_source: 'agent_reported' | 'deterministic' | 'verified_observation';
};
export type LearningTriage = {
  action: z.infer<typeof learningActionSchema>;
  novelty: 'unknown' | 'possibly_covered' | 'no_bounded_match';
  reusability: SignalInput['reusability'];
  evidence_trust:
    | 'AGENT_REPORTED'
    | 'OBSERVED_RECORD'
    | 'VERIFIED_STATIC_CHECK'
    | 'OPERATOR_ATTESTED';
  reason: string;
  limitations: string[];
  policy_version: typeof LEARNING_POLICY;
  related_experiences: string[];
  related_versions: string[];
  evidence_status: Array<{
    kind: string;
    id: string;
    status: 'AVAILABLE' | 'MISSING_OR_UNAVAILABLE';
    trust?: 'AGENT_REPORTED' | 'OBSERVED_RECORD' | 'VERIFIED_STATIC_CHECK' | 'OPERATOR_ATTESTED';
  }>;
};
export type LearningSignal = {
  schema_version: 1;
  id: string;
  project_id: string;
  type: SignalInput['type'];
  title: string;
  summary: string;
  evidence: SignalEvidence[];
  supporting_evidence: Evidence[];
  experience_ids: string[];
  version_ids: string[];
  reusability: SignalInput['reusability'];
  origin: SignalOrigin;
  session_ref: string | null;
  task_ref: string | null;
  fingerprint: string;
  status: 'open' | 'dismissed' | 'superseded';
  revision: number;
  created_at: string;
  updated_at: string;
  triage: LearningTriage;
  operator_correction?: {
    operator: string;
    session: string;
    digest: string;
    method: 'local-tty-learning-correction-v1';
  };
};
export function parseLearning<T>(schema: z.ZodType<T>, value: unknown): T {
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > 4096) throw Error('bound');
    const p = schema.safeParse(value);
    if (p.success) return p.data;
  } catch {}
  throw new AgentMindError('LEARNING_INVALID_INPUT', 'Invalid or oversized learning request.');
}
export const LEARNING_LIMITATIONS = [
  'A signal is an advisory observation, not verified task success or permission to change a skill.',
  'Agent claims, task labels and frequency are not independently verified or proven independent.',
  'Matching is bounded lexical evidence, not semantic equivalence or proof of novelty.',
  'SEC-01 protected deployment is unverified here; same-UID operator confirmation is not adversarial authentication.',
];

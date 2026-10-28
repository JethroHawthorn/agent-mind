import { createHash } from 'node:crypto';
import { z } from 'zod';

const fileDigest = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');

import { AgentMindError } from '../errors.js';
import { hashSkillFiles, type SkillEvaluation, type SkillVersion } from '../skill-model.js';
import { validateSkillBundle } from '../skill-validation.js';
import { behavioralDigest, resolveBehavioralSuite, suiteSelectorSchema } from './model.js';

/** Release policy, never candidate metadata. No accepted backend in this release. */
const policy = {
  version: 'sandbox-assurance-v1/refusal-only',
  collector: 'agentmind-refusal-collector-v1',
  accepted_backends: [] as string[],
  network: 'none',
  host_mounts: 'none',
  host_ipc: false,
  privileged: false,
  execution_uid: 'nonroot-guest',
  root_filesystem: 'readonly',
  environment: ['LANG=C.UTF-8', 'TZ=UTC'],
  limits: {
    wall_ms: 3000,
    cpu_ms: 3000,
    memory_mb: 128,
    processes: 16,
    disk_bytes: 16777216,
    output_bytes: 8192,
    artifacts: 8,
    artifact_bytes: 65536,
    cleanup_ms: 3000,
  },
} as const;
export function behavioralSandboxStatus() {
  return {
    schema_version: 1,
    policy: structuredClone(policy),
    policy_digest: behavioralDigest(policy),
    capability: {
      backend: 'disabled',
      backend_version: null,
      os: process.platform,
      arch: process.arch,
      status: 'UNAVAILABLE',
      isolation: 'NOT_VERIFIED',
      image_digest: null,
      effective_execution_identity: null,
      verified_limits: null,
      host_mounts_verified: false,
      network_verified: false,
      process_tree_cleanup_verified: false,
    },
    execution_supported: false,
    protected_persistence: 'NOT_VERIFIED',
    reason: 'NO_QUALIFIED_BACKEND',
    model_invocations: 0,
  } as const;
}
export type SandboxStatus = ReturnType<typeof behavioralSandboxStatus>;
/** Explicit transport contract for a future provisioner; none can be supplied by an agent. */
export interface BehavioralSandboxBackend {
  inspect(): SandboxStatus;
  execute(): { result: 'NOT_VERIFIED'; reason: 'NO_QUALIFIED_BACKEND'; execution_started: false };
}
export const refusedSandboxBackend: BehavioralSandboxBackend = Object.freeze({
  inspect: behavioralSandboxStatus,
  execute: (): ReturnType<BehavioralSandboxBackend['execute']> => ({
    result: 'NOT_VERIFIED',
    reason: 'NO_QUALIFIED_BACKEND',
    execution_started: false,
  }),
});
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z
  .array(
    z.strictObject({
      path: z.string().max(240),
      bytes: z.number().int().nonnegative(),
      digest: sha,
    }),
  )
  .min(1)
  .max(32);
export const sandboxPlanSchema = z.strictObject({
  schema_version: z.literal(1),
  project_id: sha,
  skill_id: z.uuid(),
  version_id: z.uuid(),
  candidate_digest: sha,
  state_revision: z.number().int().nonnegative(),
  identity_revision: z.number().int().nonnegative(),
  baseline_version_id: z.uuid().nullable(),
  selector: suiteSelectorSchema,
  suite_digest: sha.nullable(),
  policy_digest: sha,
  environment_digest: sha,
  environment: z.strictObject({
    backend: z.literal('disabled'),
    backend_version: z.null(),
    os: z.string().min(1).max(32),
    arch: z.string().min(1).max(32),
    status: z.literal('UNAVAILABLE'),
    isolation: z.literal('NOT_VERIFIED'),
    image_digest: z.null(),
    effective_execution_identity: z.null(),
    verified_limits: z.null(),
    host_mounts_verified: z.literal(false),
    network_verified: z.literal(false),
    process_tree_cleanup_verified: z.literal(false),
  }),
  manifest: manifestSchema,
  static_validation: z.enum(['VALID', 'INVALID']),
  semantics: z.enum(['INSTRUCTION_ONLY', 'SUPPORTING_CODE_OR_RESOURCES']),
  execution: z.literal('NOT_VERIFIED'),
  execution_started: z.literal(false),
  reason: z.literal('NO_QUALIFIED_BACKEND'),
});
export type SandboxPlan = z.infer<typeof sandboxPlanSchema>;
export function prepareSandboxPlan(input: {
  version: SkillVersion;
  name: string;
  state_revision: number;
  identity_revision: number;
  baseline_version_id: string | null;
  selector: unknown;
}): SandboxPlan {
  const { version } = input;
  if (hashSkillFiles(version.files) !== version.content_hash)
    throw new AgentMindError(
      'SKILL_INTEGRITY_ERROR',
      'Candidate snapshot failed integrity verification.',
    );
  const selector = suiteSelectorSchema.parse(input.selector);
  const suite = resolveBehavioralSuite(selector);
  const status = behavioralSandboxStatus();
  return sandboxPlanSchema.parse({
    schema_version: 1,
    project_id: version.project_id,
    skill_id: version.skill_id,
    version_id: version.id,
    candidate_digest: version.content_hash,
    state_revision: input.state_revision,
    identity_revision: input.identity_revision,
    baseline_version_id: input.baseline_version_id,
    selector,
    suite_digest: suite?.digest ?? null,
    policy_digest: status.policy_digest,
    environment_digest: behavioralDigest(status.capability),
    environment: status.capability,
    manifest: [...version.files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => ({
        path: f.path,
        bytes: Buffer.byteLength(f.content),
        digest: fileDigest(f.content),
      })),
    static_validation: validateSkillBundle({
      name: input.name,
      description: version.description,
      files: version.files,
    }).validation_result,
    semantics: version.files.length === 1 ? 'INSTRUCTION_ONLY' : 'SUPPORTING_CODE_OR_RESOURCES',
    execution: 'NOT_VERIFIED',
    execution_started: false,
    reason: 'NO_QUALIFIED_BACKEND',
  });
}
const assuranceSchema = z.strictObject({
  policy_version: z.literal(policy.version),
  collector_version: z.literal(policy.collector),
  run_id: z.uuid(),
  plan: sandboxPlanSchema,
  plan_digest: sha,
  evidence_kind: z.literal('REFUSAL'),
  host_execution: z.literal(false),
  observations: z.null(),
  artifacts: z.tuple([]),
});
export function collectSandboxRefusal(plan: SandboxPlan, runId: string) {
  // This collector has no process, filesystem, socket, output parser or caller receipt input.
  refusedSandboxBackend.execute();
  return assuranceSchema.parse({
    policy_version: policy.version,
    collector_version: policy.collector,
    run_id: runId,
    plan,
    plan_digest: behavioralDigest(plan),
    evidence_kind: 'REFUSAL',
    host_execution: false,
    observations: null,
    artifacts: [],
  });
}
export function verifySandboxRefusal(
  input: unknown,
  evaluation: SkillEvaluation,
  files: SkillVersion['files'],
) {
  const a = assuranceSchema.parse(input),
    p = a.plan;
  const marker = evaluation.checks.filter((c) => c.name === 'sandbox.plan');
  const suite = resolveBehavioralSuite(p.selector);
  const baseline = JSON.parse(
    evaluation.checks.find((c) => c.name === 'baseline.snapshot')?.details ?? 'null',
  ) as { identity_revision: number } | null;
  if (!baseline || baseline.identity_revision !== p.identity_revision)
    throw new AgentMindError('BEHAVIORAL_EVIDENCE_INTEGRITY', 'Baseline identity binding failed.');
  if (
    a.run_id !== evaluation.id ||
    p.version_id !== evaluation.version_id ||
    p.skill_id !== evaluation.skill_id ||
    p.project_id !== evaluation.project_id ||
    p.candidate_digest !== evaluation.content_hash ||
    p.baseline_version_id !== evaluation.baseline_version_id ||
    p.policy_digest !== behavioralSandboxStatus().policy_digest ||
    p.environment_digest !== behavioralDigest(p.environment) ||
    p.suite_digest !== (suite?.digest ?? null) ||
    a.plan_digest !== behavioralDigest(p) ||
    marker.length !== 1 ||
    marker[0]?.details !== a.plan_digest ||
    marker[0].result !== 'NOT_VERIFIED' ||
    hashSkillFiles(files) !== p.candidate_digest ||
    behavioralDigest(p.manifest) !==
      behavioralDigest(
        [...files]
          .sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))
          .map((f) => ({
            path: f.path,
            bytes: Buffer.byteLength(f.content),
            digest: fileDigest(f.content),
          })),
      )
  )
    throw new AgentMindError(
      'BEHAVIORAL_EVIDENCE_INTEGRITY',
      'Sandbox refusal binding failed verification.',
    );
  return a;
}

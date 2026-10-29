import { AgentMindError } from '@agentmind/core';
import { z } from 'zod';

const text = z.string();
const id = text.min(1);
const digest = text.regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
const next = count.nullable();
const obj = z.looseObject;
const data = { warning: text, untrusted_data: z.literal(true) };
const scoped = { project_id: id, scope: z.literal('project') };
const pin = { skill_id: id, version_id: id, content_digest: digest, ...scoped };
const skill = obj({ skill_id: id, name: text, active_version_id: id, content_digest: digest });
const memory = obj({
  id,
  project_id: id,
  title: text,
  content: text,
  kind: text,
  source_agent: text,
  status: z.literal('unverified'),
  created_at: text,
});
const experience = obj({
  id,
  project_id: id,
  source_agent: text,
  problem: text,
  solution: text,
  outcome: obj({ status: z.enum(['succeeded', 'failed', 'partial', 'unknown']), summary: text }),
  approval_status: z.enum(['candidate', 'approved', 'rejected']),
  verification_status: z.literal('unverified'),
  redacted: z.boolean(),
});
const evaluation = obj({
  id,
  result: z.enum(['PASS', 'FAIL', 'NOT_VERIFIED']),
  content_hash: digest,
  evaluator_version: text,
});
const validation = obj({ validation_result: z.enum(['VALID', 'INVALID']) });
const proposal = obj({
  proposal_id: id,
  project_id: id,
  type: z.enum(['CREATE_NEW', 'PATCH_EXISTING', 'REWRITE_EXISTING']),
  skill_id: id,
  candidate_version_id: id,
  base_version_id: id.nullable(),
  content_digest: digest,
  candidate_state: text,
  state_revision: count,
  provenance: obj({
    signal_ids: z.array(id),
    experience_ids: z.array(id),
    context_digest: digest,
    candidate_digest: digest,
    base_digest: digest.nullable(),
  }),
  validation,
  evaluation: evaluation.nullable(),
  diff: z.array(obj({ path: text, change: text })),
  ...data,
});
const signal = obj({
  id,
  project_id: id,
  schema_version: z.literal(1),
  type: text,
  status: text,
  revision: count,
  evidence: z.array(obj({ kind: text, id })),
  supporting_evidence: z.array(obj({ kind: text, reference: text, summary: text })),
  experience_ids: z.array(id),
  version_ids: z.array(id),
  origin: obj({ source_agent: text, detection_source: text, adapter: text }),
  triage: obj({ action: text, evidence_trust: text }),
  advisory_only: z.literal(true),
  untrusted_data: z.literal(true),
});
const context = obj({
  id,
  project_id: id,
  context_digest: digest,
  source_digest: digest,
  signals: z.array(obj({ id, revision: count, trust: text })).max(3),
  experiences: z.array(obj({ id, verification: z.literal('unverified') })).max(5),
  matching_skills: z.array(obj({ id, name: text, active_version_id: id.nullable() })).max(3),
  target: obj({ skill_id: id, version_id: id, content_hash: digest }).nullable(),
  cached: z.boolean(),
  ...data,
});
const compactSignal = obj({
  stored: z.boolean(),
  advisory_only: z.literal(true),
  id: id.optional(),
  revision: count.optional(),
  status: text.optional(),
  action: text.optional(),
  reason: text.optional(),
  disabled: z.literal(true).optional(),
  untrusted_data: z.literal(true).optional(),
})
  .superRefine((value, ctx) => {
    if (
      value.stored
        ? !value.id ||
          value.revision === undefined ||
          !value.status ||
          value.untrusted_data !== true
        : value.disabled !== true && (!value.action || !value.reason)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Stored signal requires identity, revision and status.',
      });
  })
  .meta({
    oneOf: [
      {
        properties: { stored: { const: true } },
        required: ['id', 'revision', 'status', 'untrusted_data'],
      },
      {
        properties: { stored: { const: false } },
        anyOf: [{ required: ['disabled'] }, { required: ['action', 'reason'] }],
      },
    ],
  });
const diff = obj({
  proposal_id: id,
  warning: text,
  files: z.array(obj({ path: text, change: text })).optional(),
  path: text.optional(),
  offset: count.optional(),
  before: obj({ content: text, digest, total_chars: count }).nullable().optional(),
  after: obj({ content: text, digest, total_chars: count }).nullable().optional(),
  next_offset: next.optional(),
})
  .superRefine((v, c) => {
    if (
      (v.files && v.path !== undefined) ||
      (!v.files &&
        (!v.path ||
          v.offset === undefined ||
          v.before === undefined ||
          v.after === undefined ||
          v.next_offset === undefined))
    )
      c.addIssue({
        code: 'custom',
        message: 'A diff requires a manifest or a complete selected page.',
      });
  })
  .meta({
    oneOf: [
      { required: ['files'] },
      { required: ['path', 'offset', 'before', 'after', 'next_offset'] },
    ],
  });
/** Forward-compatible projections: known identity/trust/digest/page fields are checked;
 * additive fields are preserved verbatim, never stripped or defaulted. */
export const outputSchemas: Readonly<Record<string, z.ZodObject>> = {
  memory_save: obj({ memory }),
  memory_search: obj({ memories: z.array(memory).max(20) }),
  experience_record: obj({
    experience,
    possible_duplicates: z.array(obj({ experience, match: text, score: z.number() })),
    untrusted_data: z.literal(true),
  }),
  experience_search: obj({
    experiences: z.array(experience).max(10),
    truncated: z.boolean(),
    untrusted_data: z.literal(true),
  }),
  skill_route: obj({
    outcome: z.enum(['RECOMMEND_ONE', 'SHORTLIST', 'NO_MATCH', 'INSUFFICIENT_CONTEXT']),
    skills: z.array(skill).max(10),
    selection_required: z.boolean(),
    truncated: z.boolean(),
    ...scoped,
    ...data,
  }),
  skill_discover: obj({
    skills: z.array(skill).max(20),
    selection_required: z.boolean(),
    truncated: z.boolean(),
    ...data,
  }),
  skill_load: obj({
    ...pin,
    path: z.literal('SKILL.md'),
    file_digest: digest,
    content: text,
    offset: count,
    total_chars: count,
    total_bytes: count,
    next_offset: next,
    complete: z.boolean(),
    truncated: z.boolean(),
    ...data,
  }),
  skill_resources: obj({
    ...pin,
    resources: z
      .array(obj({ path: text, bytes: count, chars: count, file_digest: digest }))
      .max(20),
    next_offset: next,
    truncated: z.boolean(),
    ...data,
  }),
  skill_resource_get: obj({
    ...pin,
    path: text,
    file_digest: digest,
    content: text,
    offset: count,
    total_chars: count,
    total_bytes: count,
    next_offset: next,
    complete: z.boolean(),
    truncated: z.boolean(),
    ...data,
  }),
  learning_signal_record: compactSignal,
  learning_signal_get: signal,
  skill_authoring_context: context,
  skill_authoring_submit: obj({
    ...proposal.partial().shape,
    stored: z.literal(false).optional(),
    status: z.literal('VALIDATION_FAILED').optional(),
    validation,
    warning: text,
    untrusted_data: z.literal(true),
  })
    .superRefine((v, c) => {
      if (
        v.stored === false
          ? v.status !== 'VALIDATION_FAILED' || v.proposal_id !== undefined
          : !proposal.safeParse(v).success
      )
        c.addIssue({
          code: 'custom',
          message:
            'Expected complete candidate provenance or explicit unstored validation failure.',
        });
    })
    .meta({
      oneOf: [
        { required: Object.keys(proposal.shape), not: { required: ['stored'] } },
        {
          properties: { stored: { const: false }, status: { const: 'VALIDATION_FAILED' } },
          required: ['stored', 'status'],
          not: { required: ['proposal_id'] },
        },
      ],
    }),
  skill_authoring_get: proposal,
  skill_authoring_diff: diff,
  skill_authoring_evaluate: obj({
    proposal_id: id,
    evaluation,
    capabilities: obj({ execution_supported: z.literal(false) }),
    ...data,
  }),
  review_queue: obj({
    items: z.array(obj({ proposal_id: id, snapshot_digest: digest })).max(20),
    next_offset: next,
    exhausted: z.boolean(),
    page_status: text,
    warning: text,
  }),
  review_get: obj({
    proposal_id: id,
    project_id: id,
    snapshot_digest: digest,
    authoring: obj({
      proposal_id: id,
      candidate_version_id: id,
      content_digest: digest,
      validation,
    }),
    evidence: obj({}),
    lifecycle: obj({
      candidate_state: text,
      active_version_id: id.nullable(),
      is_active: z.boolean(),
    }),
    ...data,
  }),
  agentmind_status: obj({
    ok: z.literal(true),
    schema_version: count,
    project_id: id,
    source_agent: text,
    learning: z.boolean(),
    authoring: z.boolean(),
    retrieval: z.boolean(),
    mode: z.literal('supervised-local'),
    protected_deployment: z.literal('NOT VERIFIED'),
    autonomous_activation: z.literal('NO-GO'),
    release_boundaries: obj({ release_approved: z.literal(false) }),
  }),
};
export const toolErrorSchema = z.strictObject({
  error: z.strictObject({ code: text.min(1), message: text.min(1) }),
});
export function successResult(name: string, value: unknown) {
  const parsed = JSON.parse(JSON.stringify(value));
  const schema = outputSchemas[name];
  if (schema && !schema.safeParse(parsed).success)
    throw new AgentMindError(
      'MCP_OUTPUT_INVALID',
      'Tool result did not match its declared contract. No authority is granted.',
    );
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(parsed) }],
    ...(schema ? { structuredContent: parsed as Record<string, unknown> } : {}),
  };
}

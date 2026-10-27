import { z } from 'zod';
import { AgentMindError } from '../errors.js';
import { reviewListSchema, reviewStateSchema } from '../learning-review/model.js';
import { sourceAgentSchema } from '../source-agent.js';
export const DAILY_WARNING =
  'Untrusted reference data. Advisory review is not approval, promotion or distribution. Suggested/retrieved is not applied or verified success. Same-UID supervised mode is not OS-isolated operator authority.';
export const dailyRequestSchema = z.strictObject({
  domain: z.enum(['memory', 'experience', 'skills', 'learning', 'proposals', 'review', 'activity']),
  action: z.enum([
    'list',
    'search',
    'show',
    'inbox',
    'evidence',
    'evaluation',
    'versions',
    'diff',
    'resources',
    'resource',
    'handoff',
  ]),
  id: z.uuid().optional(),
  query: z.string().trim().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(20).default(10),
  offset: z.number().int().min(0).max(65536).default(0),
  agent: sourceAgentSchema.optional(),
  state: z.string().min(1).max(40).optional(),
  type: z.string().min(1).max(40).optional(),
  validation: reviewListSchema.shape.validation,
  evaluation: reviewListSchema.shape.evaluation,
  trust: z.string().min(1).max(40).optional(),
  since: z.iso.datetime({ offset: true }).optional(),
  associated: z.boolean().optional(),
  review_state: reviewStateSchema.optional(),
  order: z.enum(['oldest', 'risk']).optional(),
  all: z.boolean().default(false),
  from: z.uuid().optional(),
  to: z.uuid().optional(),
  version: z.uuid().optional(),
  digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  path: z.string().min(1).max(240).optional(),
  chars: z.number().int().min(16).max(1000).default(1000),
  expand: z.boolean().default(false),
  snapshot: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  candidate_digest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type DailyRequest = z.infer<typeof dailyRequestSchema>;
export function dailyInput(input: unknown): DailyRequest {
  try {
    if (Buffer.byteLength(JSON.stringify(input)) > 4096) throw Error();
    const p = dailyRequestSchema.parse(input);
    if (!dailyCommands[p.domain].includes(p.action)) throw Error();
    const list = ['list', 'inbox', 'search'].includes(p.action);
    const allowed = new Set(['domain', 'action']);
    const allow = (...fields: string[]) =>
      fields.forEach((f) => {
        allowed.add(f);
      });
    if (list) allow('limit', 'offset');
    else allow('id');
    if (p.action === 'search') allow('query');
    if (['memory', 'experience', 'activity'].includes(p.domain) && list) allow('agent', 'since');
    if (['memory', 'experience'].includes(p.domain) && list) allow('state');
    if (p.domain === 'learning' && list)
      allow('agent', 'since', 'state', 'type', 'trust', 'associated', 'review_state', 'all');
    if (['proposals', 'review'].includes(p.domain) && list)
      allow('agent', 'state', 'type', 'query', 'all', 'order', 'validation', 'evaluation');
    if (p.domain === 'skills' && p.action === 'search') allow('expand');
    if (p.action === 'versions' || p.action === 'resources' || p.action === 'evaluation')
      allow('offset', 'limit');
    if (p.action === 'show' && ['memory', 'experience', 'skills'].includes(p.domain))
      allow('offset', 'chars');
    if (p.action === 'diff' || p.action === 'resource') allow('path', 'offset', 'chars');
    if (p.domain === 'skills' && p.action === 'diff') allow('from', 'to');
    if (p.domain === 'skills' && ['show', 'resources', 'resource'].includes(p.action))
      allow('version', 'digest');
    if (p.action === 'handoff') allow('snapshot', 'candidate_digest');
    if (Object.keys(input as object).some((k) => !allowed.has(k))) throw Error();
    if (!list && !p.id) throw Error();
    if (list && p.offset > 10000) throw Error();
    if (p.action === 'search' && !p.query) throw Error();
    if (p.domain === 'skills' && p.action === 'search') {
      if (!(input as Record<string, unknown>).limit) p.limit = 5;
      if (p.limit > 10 || p.offset) throw Error();
    }
    if (p.action === 'resource' && !p.path) throw Error();
    if (p.domain === 'skills' && p.action === 'diff' && (!p.from || !p.to)) throw Error();
    if (['proposals', 'review'].includes(p.domain)) {
      if (p.state && !reviewStateSchema.safeParse(p.state).success) throw Error();
      if (p.type && !['CREATE_NEW', 'PATCH_EXISTING', 'REWRITE_EXISTING'].includes(p.type))
        throw Error();
      if (p.query && p.query.length > 64) throw Error();
    }
    if (p.domain === 'learning') {
      if (p.state && !['open', 'dismissed', 'superseded'].includes(p.state)) throw Error();
      if (
        p.type &&
        ![
          'PROBLEM_SOLVED',
          'USER_CORRECTION',
          'REUSABLE_WORKFLOW',
          'REPEATED_FAILURE',
          'SKILL_GAP',
          'SKILL_CONFLICT',
          'NEW_PATTERN',
        ].includes(p.type)
      )
        throw Error();
      if (
        p.trust &&
        ![
          'AGENT_REPORTED',
          'OBSERVED_RECORD',
          'VERIFIED_STATIC_CHECK',
          'OPERATOR_ATTESTED',
        ].includes(p.trust)
      )
        throw Error();
    }
    return p;
  } catch {
    throw new AgentMindError(
      'DAILY_INVALID_INPUT',
      'Invalid or oversized daily request. Use full IDs and trusted project context; scope/identity fields are not accepted.',
    );
  }
}
export function unavailable(): never {
  throw new AgentMindError('DAILY_NOT_FOUND', 'Object is unavailable in the selected project.');
}
export const dailyCommands: Record<DailyRequest['domain'], readonly DailyRequest['action'][]> = {
  memory: ['list', 'search', 'show'],
  experience: ['list', 'search', 'show'],
  skills: ['list', 'search', 'show', 'versions', 'diff', 'resources', 'resource'],
  learning: ['inbox', 'show', 'evidence'],
  proposals: ['list', 'show', 'diff', 'evidence', 'evaluation'],
  review: ['list', 'show', 'diff', 'evidence', 'evaluation', 'handoff'],
  activity: ['list'],
};

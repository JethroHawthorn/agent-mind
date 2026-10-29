import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  AgentMindError,
  DailyWorkflowService,
  dailyInput,
  dailySafe,
  LearningReviewDecisions,
  LearningReviewService,
  localReviewCaller,
  openDatabaseReadOnly,
  openUsageDatabase,
  parseReview,
  reviewDecisionSchema,
} from '@agentmind/core';
import { assertCallerProject } from '../codex/project.js';
import { integrationRegistry } from '../installer/context.js';
import { diagnosticText } from '../installer/files.js';
import { renderDaily } from './presentation.js';
export const DAILY_DOMAINS = [
  'memory',
  'experience',
  'skills',
  'learning',
  'proposals',
  'review',
  'activity',
];
export const dailyHelp = `AgentMind daily workflow — local project scope, no model calls
Usage: agentmind <group> <action> [full UUID/query] [options]
 memory     list | search QUERY | show ID
 experience list | search QUERY | show ID
 skills     list | search QUERY | show ID | versions ID | diff ID --from UUID --to UUID
            resources ID | resource ID --path PACKAGE_MEMBER
 learning   inbox | show ID | evidence ID
 proposals  list | show ID | diff ID | evidence ID | evaluation ID
 review     ID | list | show ID | diff ID | evidence ID | evaluation ID | handoff ID
 review     defer|dismiss|reviewed|recommend|needs-evidence|reopen ID [decision options]
 activity   [--agent codex|claude|gemini|unknown]

 --project-root PATH  Exact authorized root; launch from inside that project/worktree
 --db PATH            Existing registry (same selection as installer); no read-time migrations
 --scope project      Global visibility is not supported by current core policy
 --limit 1..20        Page size (default 10); skill search default 5, maximum 10
 --offset N           Row offset, or redacted character offset for content/diff pages
 --agent NAME         Origin filter for listings; never identity/authorization
 --state STATE --review-state STATE --order oldest|risk --type TYPE --trust CLASS --since ISO --associated true|false --all
 --validation STATE --evaluation PASS|FAIL|NOT_VERIFIED|MISSING  Proposal filters
 --query TEXT         Proposal skill-name filter (or positional search query)
 --version UUID --digest SHA256   Exact active content pins
 --path MEMBER --chars 16..1000   Selected diff/resource or content page
 --expand             One bounded hybrid skill shortlist expansion
 --json --no-color    Stable JSON or safe plain text (no ANSI colors are emitted)
 --full               Full bounded metadata view; never disables content/diff paging
 --snapshot SHA256 --candidate-digest SHA256  Required review decision/handoff pins
 --reason TEXT --request-id UUID --apply      Advisory decision; without --apply preview only
 -h, --help           Help without a registry/CLI installation

Copy snapshot/candidate digests from review show. A decision is never approval.
No approval/promote/distribution command is provided. Handoff returns existing workflow
GUIDANCE ONLY; protected OS deployment and behavioral sandbox remain NOT VERIFIED.
Use existing status/doctor for installation/runtime diagnostics; native models never run here.
`;
const decisions: Record<string, string> = {
  defer: 'DEFER',
  dismiss: 'DISMISS',
  reviewed: 'MARK_REVIEWED',
  recommend: 'RECOMMEND_FOR_APPROVAL',
  'needs-evidence': 'REQUEST_MORE_EVIDENCE',
  reopen: 'REOPEN',
};
export async function runDailyCLI(args: string[]) {
  const { values: v, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      'project-root': { type: 'string' },
      db: { type: 'string' },
      scope: { type: 'string', default: 'project' },
      limit: { type: 'string' },
      offset: { type: 'string' },
      agent: { type: 'string' },
      state: { type: 'string' },
      'review-state': { type: 'string' },
      order: { type: 'string' },
      type: { type: 'string' },
      trust: { type: 'string' },
      validation: { type: 'string' },
      evaluation: { type: 'string' },
      since: { type: 'string' },
      associated: { type: 'string' },
      all: { type: 'boolean' },
      query: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      version: { type: 'string' },
      digest: { type: 'string' },
      path: { type: 'string' },
      chars: { type: 'string' },
      expand: { type: 'boolean' },
      json: { type: 'boolean' },
      'no-color': { type: 'boolean' },
      full: { type: 'boolean' },
      snapshot: { type: 'string' },
      'candidate-digest': { type: 'string' },
      reason: { type: 'string' },
      'request-id': { type: 'string' },
      apply: { type: 'boolean' },
    },
  });
  if (v.help) {
    process.stdout.write(dailyHelp);
    return;
  }
  if (v.scope !== 'project')
    throw new AgentMindError(
      'DAILY_SCOPE_UNSUPPORTED',
      'Only existing project visibility is supported; no implicit global access.',
    );
  const domain = positionals[0];
  let action = positionals[1];
  let selector = positionals[2];
  if (domain === 'activity' && positionals.length === 1) action = 'list';
  if (domain === 'review' && action && /^[a-f0-9-]{36}$/i.test(action)) {
    if (positionals.length !== 2)
      throw new AgentMindError('DAILY_INVALID_INPUT', 'Use one complete proposal ID.');
    selector = action;
    action = 'show';
  }
  if (action === 'search' && selector && v.query)
    throw new AgentMindError(
      'DAILY_INVALID_INPUT',
      'Provide one search query, not competing selectors.',
    );
  const decision = domain === 'review' && action ? decisions[action] : undefined;
  if (positionals.length > 3 || !domain || !action)
    throw new AgentMindError(
      'DAILY_INVALID_INPUT',
      'Choose a documented daily group/action and one complete ID/query.',
    );
  if ((v.apply || v.reason || v['request-id']) && !decision)
    throw new AgentMindError(
      'DAILY_INVALID_INPUT',
      'Advisory decision selectors do not apply to read-only views.',
    );
  if (v.associated !== undefined && !['true', 'false'].includes(v.associated))
    throw new AgentMindError('DAILY_INVALID_INPUT', 'Associated must be true or false.');
  const n = (s: string | undefined) =>
    s === undefined ? undefined : Number(/^\d+$/.test(s) ? s : 'NaN');
  let root = v['project-root'];
  if (!root) {
    const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 8192,
      env: {
        PATH: process.env.PATH ?? '',
        LANG: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    });
    root = r.status === 0 ? r.stdout.trim() : process.cwd();
  }
  const scope = assertCallerProject(root),
    path = integrationRegistry(scope.root, v.db);
  const common = {
    domain,
    action: decision ? 'show' : action,
    ...(action === 'search'
      ? { query: selector ?? v.query }
      : { ...(selector ? { id: selector } : {}), ...(v.query ? { query: v.query } : {}) }),
    ...Object.fromEntries(
      [
        'agent',
        'state',
        'type',
        'trust',
        'validation',
        'evaluation',
        'since',
        'from',
        'to',
        'version',
        'digest',
        'path',
        'snapshot',
      ].flatMap((k) => (v[k as keyof typeof v] === undefined ? [] : [[k, v[k as keyof typeof v]]])),
    ),
    ...(v['review-state'] ? { review_state: v['review-state'] } : {}),
    ...(v.order ? { order: v.order } : {}),
    ...(v['candidate-digest'] ? { candidate_digest: v['candidate-digest'] } : {}),
    ...(v.limit ? { limit: n(v.limit) } : {}),
    ...(v.offset ? { offset: n(v.offset) } : {}),
    ...(v.chars ? { chars: n(v.chars) } : {}),
    ...(v.all ? { all: true } : {}),
    ...(v.expand ? { expand: true } : {}),
    ...(v.associated ? { associated: v.associated === 'true' } : {}),
  };
  if (!decision) dailyInput(common);
  let request: unknown;
  if (decision) {
    request = parseReview(reviewDecisionSchema, {
      proposal_id: selector,
      request_id: v['request-id'] ?? randomUUID(),
      expected_snapshot_digest: v.snapshot,
      candidate_digest: v['candidate-digest'],
      decision,
      reason: v.reason,
    });
    const extra = Object.keys(v).filter(
      (k) =>
        ![
          'scope',
          'project-root',
          'db',
          'json',
          'full',
          'no-color',
          'help',
          'snapshot',
          'candidate-digest',
          'reason',
          'request-id',
          'apply',
        ].includes(k),
    );
    if (extra.length)
      throw new AgentMindError('DAILY_INVALID_INPUT', 'Unsupported advisory decision option.');
  }
  let result: unknown;
  if (!existsSync(path)) {
    if (['list', 'inbox', 'search'].includes(action) && !decision) {
      result = {
        schema_version: 1,
        domain,
        action,
        project_id: scope.id,
        configured: false,
        data: {
          items: [],
          registry_status: 'MISSING',
          empty_reason: 'REGISTRY_NOT_CONFIGURED',
          next_steps: [
            'Use agentmind status/doctor and explicitly initialize the intended registry. No database was created.',
          ],
        },
      };
    } else
      throw new AgentMindError(
        'DAILY_REGISTRY_UNAVAILABLE',
        'The selected registry is missing. Use status/doctor; reads never initialize it.',
      );
  } else {
    const db = decision && v.apply ? openUsageDatabase(path) : openDatabaseReadOnly(path);
    try {
      if (decision) {
        if (!selector || !v.snapshot || !v['candidate-digest'] || !v.reason)
          throw new AgentMindError(
            'DAILY_INVALID_INPUT',
            'Review decisions need exact ID, --snapshot, --candidate-digest and --reason.',
          );
        const read = new DailyWorkflowService(db, scope);
        read.execute({ domain: 'review', action: 'show', id: selector });
        if (!v.apply) {
          const snapshot = new LearningReviewService(db, scope).get({ proposal_id: selector });
          if (
            snapshot.snapshot_digest !== v.snapshot ||
            snapshot.candidate_digest !== v['candidate-digest']
          )
            throw new AgentMindError(
              'REVIEW_STALE_SNAPSHOT',
              'Review changed; refresh its exact snapshot before previewing a decision.',
            );
        }
        result = v.apply
          ? {
              schema_version: 1,
              domain: 'review',
              action,
              project_id: scope.id,
              data: new LearningReviewDecisions(db, scope, localReviewCaller()).decide(request),
            }
          : {
              schema_version: 1,
              domain: 'review',
              action,
              project_id: scope.id,
              data: {
                advisory_only: true,
                applied: false,
                request,
                requires: 'Explicit --apply; no approval or activation authority is transferred.',
              },
            };
      } else result = new DailyWorkflowService(db, scope).execute(common);
    } finally {
      db.close();
    }
  }
  process.stdout.write(
    `${v.json ? diagnosticText(dailySafe(result), false) : renderDaily(result, process.stdout.columns ?? 100, v.full ?? false)}\n`,
  );
}

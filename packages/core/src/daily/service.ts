import type Database from 'better-sqlite3';
import { fileDigest } from '../authoring/patch.js';
import { AgentMindError } from '../errors.js';
import { ExperienceService } from '../experience.js';
import { referenceExists } from '../learning/evidence.js';
import { LearningSignalService } from '../learning/service.js';
import { LearningReviewService } from '../learning-review/service.js';
import { redactSecrets } from '../privacy.js';
import type { ProjectScope } from '../project.js';
import { discoveryFeatures } from '../retrieval/features.js';
import { SkillRetrievalService } from '../retrieval/service.js';
import { resolveActiveArtifact } from '../skill-active-artifact.js';
import { SkillEvaluationService } from '../skill-evaluation.js';
import { skillFileSchema } from '../skill-model.js';
import { diffSkillFiles } from '../skill-review.js';
import { SkillStore } from '../skill-store.js';
import { type DailyRequest, dailyCommands, dailyInput, unavailable } from './model.js';
import { envelope, textPage } from './projection.js';
import { DailyQueries } from './queries.js';
/** Unified read model, not an approval engine. Caller scope is trusted construction context. */
export class DailyWorkflowService {
  readonly #scope: ProjectScope;
  readonly #q: DailyQueries;
  constructor(
    private readonly db: Database.Database,
    scope: ProjectScope,
  ) {
    this.#scope = Object.freeze({ ...scope });
    this.#q = new DailyQueries(db, this.#scope);
  }
  execute(input: unknown) {
    const p = dailyInput(input);
    if (!dailyCommands[p.domain].includes(p.action))
      throw new AgentMindError(
        'DAILY_INVALID_INPUT',
        'Unsupported daily action; approval/promotion/distribution are separate workflows.',
      );
    if (
      [
        'show',
        'diff',
        'versions',
        'evidence',
        'evaluation',
        'resources',
        'resource',
        'handoff',
      ].includes(p.action) &&
      !p.id
    )
      throw new AgentMindError(
        'DAILY_INVALID_INPUT',
        'This view requires a complete canonical UUID.',
      );
    if (p.action === 'search' && !p.query)
      throw new AgentMindError('DAILY_INVALID_INPUT', 'Search requires a bounded query.');
    if (p.action !== 'diff' && p.action !== 'show' && p.action !== 'resource' && p.offset > 10000)
      throw new AgentMindError(
        'DAILY_INVALID_INPUT',
        'Listing offset limit reached; narrow filters.',
      );
    return this.db.transaction(() => {
      let data: unknown;
      if (p.domain === 'memory' || p.domain === 'experience') data = this.records(p);
      else if (p.domain === 'skills') data = this.skills(p);
      else if (p.domain === 'learning') data = this.learning(p);
      else if (p.domain === 'activity') data = this.#q.activity(p);
      else data = this.proposals(p);
      return envelope(p.domain, p.action, this.#scope.id, data);
    })();
  }
  private records(p: DailyRequest) {
    if (p.action !== 'show') return this.#q.records(p, p.domain as 'memory' | 'experience');
    if (p.domain === 'memory') {
      const row = this.db
        .prepare('SELECT * FROM memories WHERE project_id=? AND id=?')
        .get(this.#scope.id, p.id) as Record<string, unknown> | undefined;
      if (!row) unavailable();
      const { content, ...meta } = row;
      return {
        ...meta,
        body: textPage(String(content), p.offset, p.chars),
        verification: 'STORED_UNVERIFIED',
        experience_links: 'NOT_RECORDED_BY_PHASE_0_MODEL',
        updated_at: null,
        deletion_state: 'No deletion/redaction history is defined for Phase 0 memories.',
      };
    }
    const e = new ExperienceService(this.db, this.#scope, 'unknown', false, false).inspect(
      p.id as string,
    );
    const { problem, solution, ...rest } = e;
    return {
      ...rest,
      problem: textPage(problem, p.offset, p.chars),
      solution: textPage(solution, p.offset, p.chars),
      task_success: 'NOT_VERIFIED',
      links: {
        signals: this.#q.has('learning_signals')
          ? this.db
              .prepare(
                "SELECT s.id FROM learning_signals s,json_each(s.payload_json,'$.experience_ids') e WHERE s.project_id=? AND e.value=? ORDER BY s.id LIMIT 21",
              )
              .all(this.#scope.id, e.id)
          : [],
        versions: this.db
          .prepare(
            'SELECT version_id FROM skill_version_sources WHERE project_id=? AND experience_id=? ORDER BY version_id LIMIT 21',
          )
          .all(this.#scope.id, e.id),
      },
      links_bounded_at: 21,
    };
  }
  private skills(p: DailyRequest) {
    const retrieval = new SkillRetrievalService(this.db, this.#scope),
      store = new SkillStore(this.db, this.#scope);
    if (p.action === 'search') {
      if (p.offset)
        throw new AgentMindError(
          'DAILY_INVALID_INPUT',
          'Skill search is a bounded shortlist, not offset pagination. Expand once or narrow the task.',
        );
      return retrieval.selectionCards({
        selection_cards: true,
        context: { summary: p.query },
        limit: Math.min(10, p.limit),
        expand: p.expand,
      });
    }
    if (p.action === 'list') {
      const rows = this.#q.page(
        "SELECT k.id FROM skills k JOIN skill_version_states s ON s.version_id=k.active_version_id AND s.project_id=k.project_id AND s.status='approved' WHERE k.project_id=? ORDER BY k.name,k.id",
        [this.#scope.id],
        p,
      );
      const items: unknown[] = [];
      let unavailableCount = 0;
      for (const r of rows.items as { id: string }[]) {
        try {
          const { review } = resolveActiveArtifact(this.db, this.#scope, r.id);
          items.push({
            id: r.id,
            name: review.identity.name,
            description: review.version.description,
            active_version_id: review.version.id,
            version: review.version.version,
            content_digest: review.version.content_hash,
            integrity: 'VERIFIED_PACKAGE',
            lifecycle: 'APPROVED_ACTIVE',
          });
        } catch {
          unavailableCount++;
        }
      }
      return { ...rows, items, unavailable_in_scoped_page: unavailableCount };
    }
    const identity = store.getIdentity(p.id);
    if (p.action === 'versions')
      return {
        ...this.#q.page(
          'SELECT v.id,v.skill_id,v.version,v.content_hash,v.created_at,s.status,s.latest_evaluation_id FROM skill_versions v JOIN skill_version_states s ON s.version_id=v.id AND s.project_id=v.project_id WHERE v.project_id=? AND v.skill_id=? ORDER BY v.version DESC,v.id',
          [this.#scope.id, identity.id],
          p,
        ),
        active_version_id: identity.active_version_id,
        integrity:
          'NOT_CHECKED_IN_HISTORY_LIST; exact diff/content inspection verifies package hashes',
        inspection: 'Explicit scoped local operator history, not approved-active discovery.',
      };
    if (p.action === 'diff') {
      if (!p.from || !p.to)
        throw new AgentMindError(
          'DAILY_INVALID_INPUT',
          'Version comparison needs exact --from and --to version UUIDs.',
        );
      const a = store.getVersion(p.from),
        b = store.getVersion(p.to);
      if (a.version.skill_id !== identity.id || b.version.skill_id !== identity.id) unavailable();
      const diff = diffSkillFiles(a.version.files, b.version.files);
      const base = {
        skill_id: identity.id,
        from: { id: a.version.id, digest: a.version.content_hash },
        to: { id: b.version.id, digest: b.version.content_hash },
        integrity: 'VERIFIED_PACKAGES',
        renames: 'Removal plus addition; no inferred semantic rename.',
      };
      if (!p.path)
        return {
          ...base,
          files: diff.map((f) => ({
            path: f.path,
            change: f.change,
            before_digest: f.before === null ? null : fileDigest(f.before),
            after_digest: f.after === null ? null : fileDigest(f.after),
          })),
          complete: false,
          next_action:
            'Select --path to inspect every changed resource; this manifest is not the complete diff.',
        };
      const file = diff.find((f) => f.path === p.path);
      if (!file) unavailable();
      return {
        ...base,
        path: file.path,
        change: file.change,
        before:
          file.before === null
            ? null
            : textPage(file.before, Math.min(p.offset, redactSecrets(file.before).length), p.chars),
        after:
          file.after === null
            ? null
            : textPage(file.after, Math.min(p.offset, redactSecrets(file.after).length), p.chars),
        complete:
          p.offset === 0 &&
          Math.max(
            redactSecrets(file.before ?? '').length,
            redactSecrets(file.after ?? '').length,
          ) <= p.chars,
        next_offset:
          p.offset + p.chars <
          Math.max(redactSecrets(file.before ?? '').length, redactSecrets(file.after ?? '').length)
            ? p.offset + p.chars
            : null,
        resource_format: 'Verified stored text only; binary resources unsupported, no execution.',
      };
    }
    const { review } = resolveActiveArtifact(this.db, this.#scope, identity.id);
    if (
      (p.version && p.version !== review.version.id) ||
      (p.digest && p.digest !== review.version.content_hash)
    )
      throw new AgentMindError(
        'RETRIEVAL_STALE_SELECTION',
        'Active version changed; refresh skill discovery.',
      );
    const pin = {
      skill_id: identity.id,
      expected_version_id: review.version.id,
      expected_digest: review.version.content_hash,
    };
    if (p.action === 'resources')
      return retrieval.resources({ ...pin, offset: p.offset, limit: p.limit });
    const safePath = skillFileSchema.shape.path.safeParse(p.path);
    if (p.action === 'resource' && !safePath.success)
      throw new AgentMindError(
        'DAILY_INVALID_INPUT',
        'Select a canonical package member, not a host path.',
      );
    const path = p.action === 'resource' && safePath.success ? safePath.data : 'SKILL.md';
    const file = review.version.files.find((f) => f.path === path);
    if (!file) unavailable();
    if (p.action === 'resource') retrieval.resource({ ...pin, path });
    const main = review.version.files.find((f) => f.path === 'SKILL.md');
    const features = discoveryFeatures(main?.content ?? '', review.version.description);
    const { prefix: _, ...applicability } = features;
    return {
      skill_id: identity.id,
      name: identity.name,
      active_version_id: review.version.id,
      version: review.version.version,
      content_digest: review.version.content_hash,
      file_digest: fileDigest(file.content),
      path,
      integrity: 'VERIFIED_PACKAGE',
      applicability,
      content: textPage(file.content, p.offset, p.chars),
      approval_event: review.approval_event,
      installations: this.db
        .prepare(
          'SELECT id,target,scope,version_id,status,last_verified_at FROM skill_installations WHERE project_id=? AND skill_id=? ORDER BY target,scope,id LIMIT 21',
        )
        .all(this.#scope.id, identity.id),
      installation_integrity: 'RECORDS_ONLY_NOT_CURRENT_FILESYSTEM_VERIFICATION',
      application_status: 'NOT_VERIFIED',
    };
  }
  private learning(p: DailyRequest) {
    if (p.action === 'inbox') {
      const page = this.#q.signals(p);
      const review = new LearningReviewService(this.db, this.#scope);
      const items = page.items.map((value) => {
        const row = value as Record<string, unknown>;
        const links = this.#q.has('authoring_proposals')
          ? this.db
              .prepare(
                "SELECT p.id FROM authoring_proposals p,json_each(p.payload_json,'$.signal_ids') j WHERE p.project_id=? AND j.value=? ORDER BY p.created_at DESC,p.id LIMIT 4",
              )
              .all(this.#scope.id, row.id)
          : [];
        const reviews = links.slice(0, 3).map((x) => {
          const s = review.summary(review.snapshot(review.row((x as { id: string }).id)));
          return {
            proposal_id: s.proposal_id,
            candidate_digest: s.candidate_digest,
            review_state: s.review_state,
            stale: s.stale,
          };
        });
        return { ...row, proposal_reviews: reviews, proposal_reviews_truncated: links.length > 3 };
      });
      return {
        ...page,
        items: items.filter(
          (i) =>
            !p.review_state || i.proposal_reviews.some((r) => r.review_state === p.review_state),
        ),
        filter_scope:
          'Review-state filtering covers bounded linked proposal snapshots; continuation may contain further matches.',
      };
    }
    const signal = new LearningSignalService(this.db, this.#scope).get({ signal_id: p.id });
    const references = signal.evidence.map((r) => ({
      ...r,
      available: referenceExists(this.db, this.#scope, r),
      retrieval: 'Scoped record reference only; external paths/commands are not followed.',
    }));
    const links = this.#q.has('authoring_proposals')
      ? this.db
          .prepare(
            "SELECT p.id,p.type,p.candidate_id,p.source_agent FROM authoring_proposals p,json_each(p.payload_json,'$.signal_ids') j WHERE p.project_id=? AND j.value=? ORDER BY p.created_at DESC,p.id LIMIT 21",
          )
          .all(this.#scope.id, signal.id)
      : [];
    return p.action === 'evidence'
      ? {
          signal_id: signal.id,
          origin: signal.origin,
          evidence_trust: signal.triage.evidence_trust,
          references,
          supporting_evidence: signal.supporting_evidence,
          limitations: signal.triage.limitations,
          verification:
            'External evidence is not fetched/executed; agent claims are not verified outcomes.',
        }
      : {
          ...signal,
          proposals: links,
          proposal_links_bounded_at: 21,
          related_experiences: signal.triage.related_experiences,
          related_versions: signal.triage.related_versions,
        };
  }
  private proposals(p: DailyRequest) {
    const review = new LearningReviewService(this.db, this.#scope);
    if (p.action === 'list') {
      const r = review.list({
        pending_only: !p.all,
        state: p.state,
        type: p.type,
        validation: p.validation,
        evaluation: p.evaluation,
        name: p.query,
        limit: p.limit,
        offset: p.offset,
        order: p.order,
      });
      const ids = p.agent
        ? new Set(
            (this.#q.has('authoring_proposals')
              ? this.db
                  .prepare(
                    'SELECT id FROM authoring_proposals WHERE project_id=? AND source_agent=? AND id IN (SELECT value FROM json_each(?))',
                  )
                  .all(this.#scope.id, p.agent, JSON.stringify(r.items.map((i) => i.proposal_id)))
              : []
            ).map((x) => (x as { id: string }).id),
          )
        : null;
      const origins = new Map(
        (this.#q.has('authoring_proposals')
          ? this.db
              .prepare(
                'SELECT id,source_agent FROM authoring_proposals WHERE project_id=? AND id IN (SELECT value FROM json_each(?))',
              )
              .all(this.#scope.id, JSON.stringify(r.items.map((i) => i.proposal_id)))
          : []
        ).map((x) => {
          const row = x as { id: string; source_agent: string };
          return [row.id, row.source_agent];
        }),
      );
      return {
        ...r,
        items: r.items
          .filter((i) => !ids || ids.has(i.proposal_id))
          .map((i) => ({
            ...i,
            source_agent: origins.get(i.proposal_id) ?? 'unknown',
            stored_evaluation_result: i.evaluation,
            behavioral_status: 'NOT_VERIFIED',
          })),
        pagination_note:
          'Continue next_offset even if an agent filter yields an empty page. No foreign/global counts are returned.',
      };
    }
    const selector = { proposal_id: p.id };
    if (p.action === 'diff') {
      const row = review.row(p.id as string);
      const value = review.diff({ ...selector, path: p.path, offset: p.offset, limit: p.chars });
      const store = new SkillStore(this.db, this.#scope);
      const candidate = store.getVersion(row.candidate_id);
      const base = row.base_id ? store.getVersion(row.base_id) : null;
      const lines = (files: { path: string; content: string }[] | undefined) => {
        const text = redactSecrets(files?.find((f) => f.path === p.path)?.content ?? '');
        return text.slice(0, p.offset).split('\n').length;
      };
      return {
        ...value,
        from: { version_id: base?.version.id ?? null, digest: base?.version.content_hash ?? null },
        to: { version_id: candidate.version.id, digest: candidate.version.content_hash },
        ...('before' in value
          ? {
              before: value.before
                ? { ...value.before, start_line: lines(base?.version.files) }
                : null,
              after: value.after
                ? { ...value.after, start_line: lines(candidate.version.files) }
                : null,
            }
          : {}),
      };
    }
    if (p.action === 'evidence') return review.evidence(selector);
    if (p.action === 'handoff') {
      if (!p.snapshot || !p.candidate_digest)
        throw new AgentMindError(
          'DAILY_INVALID_INPUT',
          'Handoff inspection requires the reviewed snapshot and candidate digest.',
        );
      return review.handoff({
        ...selector,
        expected_snapshot_digest: p.snapshot,
        candidate_digest: p.candidate_digest,
      });
    }
    const r = review.get(selector);
    const candidate = new SkillStore(this.db, this.#scope).getVersion(r.candidate_version_id);
    const id = candidate.state.latest_evaluation_id;
    const report = id
      ? new SkillEvaluationService(this.db, this.#scope).getReport({ evaluation_id: id })
      : null;
    const evaluation = {
      static_status: report?.evaluation.evaluator_version.startsWith('static-contract-')
        ? `STATIC_${report.evaluation.result}`
        : 'NOT_RUN',
      stored_result: report?.evaluation.result ?? 'NOT_RUN',
      behavioral_status: 'NOT_VERIFIED',
      execution_observed: false,
      sandbox_isolation: 'NOT_VERIFIED',
      digest_bound: report
        ? report.evaluation.content_hash === candidate.version.content_hash
        : null,
      evaluation_id: id,
      evaluator_policy: report?.evaluation.evaluator_version ?? null,
      behavioral: report && 'behavioral' in report ? report.behavioral : null,
      checks: report?.evaluation.checks.slice(p.offset, p.offset + p.limit) ?? [],
      checks_next_offset:
        report && report.evaluation.checks.length > p.offset + p.limit ? p.offset + p.limit : null,
    };
    if (p.action === 'evaluation')
      return {
        proposal_id: p.id,
        candidate_version_id: candidate.version.id,
        candidate_digest: candidate.version.content_hash,
        evaluation,
      };
    return {
      ...r,
      evaluation_view: {
        ...evaluation,
        checks: undefined,
        checks_next_offset: undefined,
        full_checks: 'Use proposals evaluation with bounded pagination.',
      },
      approval_boundary: {
        review_is_approval: false,
        protected_operator: 'NOT_VERIFIED',
        autonomous_activation: 'DISABLED',
        handoff_requires:
          'Existing separately authorized P2-005/SEC-01 workflow. This view issues no grants or promotion.',
      },
    };
  }
}

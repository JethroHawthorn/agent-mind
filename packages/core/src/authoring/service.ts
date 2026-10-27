import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { curatorDigest, curatorId } from '../curator/model.js';
import { AgentMindError } from '../errors.js';
import { sanitizeExperienceText } from '../experience-privacy.js';
import type { ProjectScope } from '../project.js';
import { SkillEvaluationService } from '../skill-evaluation.js';
import { hashSkillFiles, type SkillVersion } from '../skill-model.js';
import { SkillProposalService } from '../skill-proposal.js';
import { diffSkillFiles } from '../skill-review.js';
import { SkillStore } from '../skill-store.js';
import { validateSkillBundle } from '../skill-validation.js';
import { agentWrite } from '../write-transaction.js';
import { authoringWarnings } from './analysis.js';
import { buildAuthoringContext } from './context.js';
import {
  AUTHORING_POLICY,
  AUTHORING_WARNING,
  authoringContextSchema,
  authoringDiffSchema,
  authoringEvaluateSchema,
  authoringGetSchema,
  authoringListSchema,
  authoringSubmitSchema,
  type ContextInput,
  parseAuthoring,
} from './model.js';
import { applySkillPatch, fileDigest } from './patch.js';
import { authoringStorageExists, migrateAuthoring } from './storage.js';

type ContextRow = {
  id: string;
  project_id: string;
  source_digest: string;
  digest: string;
  request_json: string;
  payload_json: string;
};
type ProposalRow = {
  id: string;
  project_id: string;
  request_id: string;
  request_digest: string;
  context_id: string;
  candidate_id: string;
  skill_id: string;
  base_id: string | null;
  type: 'CREATE_NEW' | 'PATCH_EXISTING' | 'REWRITE_EXISTING';
  source_agent: string;
  payload_json: string;
  created_at: string;
};
export class SkillAuthoringService {
  readonly #scope: ProjectScope;
  readonly #session: string;
  constructor(
    private readonly db: Database.Database,
    scope: ProjectScope,
    private readonly source: 'codex' | 'claude' | 'unknown' = 'unknown',
    private readonly enabled = true,
    session: string = randomUUID(),
  ) {
    this.#scope = Object.freeze({ ...scope });
    this.#session = curatorDigest([scope.id, source, session]);
  }
  context(input: unknown) {
    this.allowed();
    const p = parseAuthoring(authoringContextSchema, input, 2048);
    return this.write(() => {
      const built = buildAuthoringContext(this.db, this.#scope, p);
      migrateAuthoring(this.db);
      const prior = this.db
        .prepare('SELECT * FROM authoring_contexts WHERE id=? AND project_id=?')
        .get(built.bundle.id, this.#scope.id) as ContextRow | undefined;
      if (prior) {
        if (
          prior.digest !== built.bundle.context_digest ||
          curatorDigest(JSON.parse(prior.payload_json)) !== prior.digest
        )
          throw new AgentMindError(
            'AUTHORING_CONTEXT_INTEGRITY',
            'Cached context integrity failed.',
          );
        return { ...built.bundle, cached: true };
      }
      const count = (
        this.db
          .prepare('SELECT COUNT(*) AS n FROM authoring_contexts WHERE project_id=?')
          .get(this.#scope.id) as { n: number }
      ).n;
      if (count >= 1000)
        throw new AgentMindError(
          'AUTHORING_CAPACITY',
          'Context cache capacity reached; no history deleted.',
        );
      const { context_digest, ...payload } = built.bundle;
      this.db
        .prepare('INSERT INTO authoring_contexts VALUES(?,?,?,?,?,?,?)')
        .run(
          built.bundle.id,
          this.#scope.id,
          built.source_digest,
          context_digest,
          JSON.stringify(p),
          JSON.stringify(payload),
          new Date().toISOString(),
        );
      return { ...built.bundle, cached: false };
    });
  }
  submit(input: unknown) {
    this.allowed();
    const p = parseAuthoring(authoringSubmitSchema, input);
    for (const text of [p.rationale, p.expected_improvement, ...p.known_limitations])
      if (sanitizeExperienceText(text).redacted)
        throw new AgentMindError(
          'AUTHORING_SECRET_REJECTED',
          'Do not include secrets in authoring metadata.',
        );
    return this.write(() => {
      if (!authoringStorageExists(this.db))
        throw new AgentMindError(
          'AUTHORING_CONTEXT_UNAVAILABLE',
          'Prepare a scoped authoring context first.',
        );
      const requestDigest = curatorDigest(p);
      const prior = this.db
        .prepare('SELECT * FROM authoring_proposals WHERE project_id=? AND request_id=?')
        .get(this.#scope.id, p.request_id) as ProposalRow | undefined;
      if (prior) {
        if (prior.request_digest !== requestDigest)
          throw new AgentMindError(
            'AUTHORING_REPLAY_CONFLICT',
            'Request ID was already used for different content.',
          );
        return { ...this.get({ proposal_id: prior.id }), duplicate: true };
      }
      const context = this.db
        .prepare('SELECT * FROM authoring_contexts WHERE id=? AND project_id=?')
        .get(p.context_id, this.#scope.id) as ContextRow | undefined;
      if (
        !context ||
        context.digest !== p.context_digest ||
        curatorDigest(JSON.parse(context.payload_json)) !== context.digest
      )
        throw new AgentMindError(
          'AUTHORING_CONTEXT_UNAVAILABLE',
          'Context is missing, foreign, stale or has an invalid digest.',
        );
      const fresh = buildAuthoringContext(
        this.db,
        this.#scope,
        JSON.parse(context.request_json) as ContextInput,
      );
      if (
        fresh.source_digest !== context.source_digest ||
        fresh.bundle.context_digest !== p.context_digest
      )
        throw new AgentMindError(
          'AUTHORING_STALE_CONTEXT',
          'Signals, sources, matches, active pointer or latest version changed; prepare a fresh context. No rebase was performed.',
        );
      const count = (
        this.db
          .prepare(
            'SELECT COUNT(*) AS n FROM authoring_proposals WHERE project_id=? AND session_digest=?',
          )
          .get(this.#scope.id, this.#session) as { n: number }
      ).n;
      if (count >= 3)
        throw new AgentMindError(
          'AUTHORING_SESSION_BUDGET',
          'Three proposals already submitted in this runtime session.',
        );
      const base = fresh.base;
      if (p.type === 'CREATE_NEW') {
        if (base || fresh.bundle.matching_skills.length || fresh.bundle.matching_truncated)
          throw new AgentMindError(
            'AUTHORING_TARGET_CHOICE_REQUIRED',
            'Existing plausible skills require explicit target review; CREATE_NEW cannot override this warning.',
          );
        if (
          this.db
            .prepare('SELECT 1 FROM skills WHERE name=? AND project_id=?')
            .get(p.name, this.#scope.id)
        )
          throw new AgentMindError(
            'AUTHORING_DUPLICATE_IDENTITY',
            'Name already belongs to an existing skill.',
          );
      } else {
        if (
          !base ||
          base.identity.id !== p.target_skill_id ||
          base.version.id !== p.target_version_id ||
          base.version.content_hash !== p.expected_base_digest ||
          base.identity.name !== p.name
        )
          throw new AgentMindError(
            'AUTHORING_BASE_MISMATCH',
            'Patch/rewrite must match the exact scoped base, identity and recomputed package digest.',
          );
      }
      let files: SkillVersion['files'];
      if (p.type === 'PATCH_EXISTING') {
        if (!base) throw new AgentMindError('AUTHORING_BASE_MISMATCH', 'Exact base is required.');
        files = applySkillPatch(base.version.files, p.operations);
      } else files = p.files;
      const validation = validateSkillBundle({ name: p.name, description: p.description, files });
      if (validation.validation_result !== 'VALID')
        return {
          stored: false,
          status: 'VALIDATION_FAILED',
          validation,
          warning: AUTHORING_WARNING,
          untrusted_data: true,
        };
      if (p.type !== 'CREATE_NEW' && hashSkillFiles(files) === base?.version.content_hash)
        throw new AgentMindError('AUTHORING_NO_CHANGE', 'No package change was proposed.');
      const candidate = new SkillProposalService(
        this.db,
        this.#scope,
        this.source,
        this.enabled,
      ).propose({
        name: p.name,
        description: p.description,
        files,
        source_experience_ids: fresh.experiences.map((e) => e.id),
        expected_latest_version: p.type === 'CREATE_NEW' ? 0 : fresh.latest,
      });
      const id = curatorId(curatorDigest([this.#scope.id, p.request_id]));
      const store = new SkillStore(this.db, this.#scope);
      const comparisonSources = base
        ? [base]
        : fresh.bundle.matching_skills
            .slice(0, 3)
            .flatMap((k) => (k.active_version_id ? [store.getVersion(k.active_version_id)] : []));
      const similarity = authoringWarnings(files, comparisonSources);
      const metadata = {
        similarity,
        policy_version: AUTHORING_POLICY,
        signal_ids: fresh.signals.map((s) => s.id),
        signal_revisions: fresh.signals.map((s) => ({ id: s.id, revision: s.revision })),
        experience_ids: fresh.experiences.map((e) => e.id),
        context_digest: context.digest,
        rationale: p.rationale,
        expected_improvement: p.expected_improvement,
        known_limitations: p.known_limitations,
        base_digest: base?.version.content_hash ?? null,
        candidate_digest: candidate.version.content_hash,
        risks:
          p.type === 'REWRITE_EXISTING'
            ? [
                'HIGH_REVIEW_RISK',
                'Full replacement needs complete diff review and behavioral evidence; execution currently unavailable.',
              ]
            : ['Agent-authored untrusted candidate.'],
        operations:
          p.type === 'PATCH_EXISTING'
            ? p.operations.map((o) => ({ op: o.op, path: o.path }))
            : null,
      };
      if (Buffer.byteLength(JSON.stringify(metadata)) > 8192)
        throw new AgentMindError(
          'AUTHORING_METADATA_LIMIT',
          'Proposal provenance exceeds its 8192-byte budget.',
        );
      this.db
        .prepare('INSERT INTO authoring_proposals VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(
          id,
          this.#scope.id,
          p.request_id,
          requestDigest,
          p.context_id,
          candidate.version.id,
          candidate.identity.id,
          base?.version.id ?? null,
          p.type,
          this.source,
          this.#session,
          JSON.stringify(metadata),
          new Date().toISOString(),
        );
      return { ...this.get({ proposal_id: id }), duplicate: false };
    });
  }
  get(input: unknown) {
    const p = parseAuthoring(authoringGetSchema, input);
    return this.db.transaction(() => {
      const row = this.row(p.proposal_id),
        meta = JSON.parse(row.payload_json);
      const store = new SkillStore(this.db, this.#scope);
      const snapshot = store.get({ version_id: row.candidate_id });
      const base = row.base_id ? store.getVersion(row.base_id) : null;
      const validation = validateSkillBundle({
        name: snapshot.identity.name,
        description: snapshot.version.description,
        files: snapshot.version.files,
      });
      const report = snapshot.state.latest_evaluation_id
        ? new SkillEvaluationService(this.db, this.#scope).getReport({
            evaluation_id: snapshot.state.latest_evaluation_id,
          })
        : null;
      const evaluation = report
        ? {
            id: report.evaluation.id,
            result: report.evaluation.result,
            evaluator_version: report.evaluation.evaluator_version,
            content_hash: report.evaluation.content_hash,
            task_success: 'NOT_VERIFIED',
            execution_supported: report.capabilities.execution_supported,
          }
        : null;
      const review = {
        proposal_id: row.id,
        project_id: this.#scope.id,
        type: row.type,
        source_agent: row.source_agent,
        created_at: row.created_at,
        name: snapshot.identity.name,
        skill_id: row.skill_id,
        base_version_id: row.base_id,
        candidate_version_id: row.candidate_id,
        content_digest: snapshot.version.content_hash,
        candidate_state: snapshot.state.status,
        state_revision: snapshot.state.revision,
        stage:
          snapshot.state.status !== 'candidate'
            ? snapshot.state.status.toUpperCase()
            : !evaluation
              ? 'EVALUATION_PENDING'
              : row.type === 'REWRITE_EXISTING'
                ? 'NEEDS_REVIEW'
                : evaluation.result === 'PASS'
                  ? 'EVALUATED'
                  : 'NEEDS_REVIEW',
        provenance: meta,
        validation,
        evaluation,
        diff: diffSkillFiles(base?.version.files ?? [], snapshot.version.files).map((f) => ({
          path: f.path,
          change: f.change,
          before_digest: f.before === null ? null : fileDigest(f.before),
          after_digest: f.after === null ? null : fileDigest(f.after),
          before_chars: f.before?.length ?? 0,
          after_chars: f.after?.length ?? 0,
        })),
        evaluation_requirements:
          row.type === 'REWRITE_EXISTING'
            ? 'Behavioral request required by this authoring helper; NOT_VERIFIED until a qualified backend exists.'
            : 'Existing static checks are not behavioral verification.',
        operator_action:
          'Inspect exact candidate/base content and sources. Use the existing separate human review/evaluation/approval workflow; no authority is granted.',
        warning: AUTHORING_WARNING,
        untrusted_data: true,
      };
      if (Buffer.byteLength(JSON.stringify(review)) > 32768)
        throw new AgentMindError(
          'AUTHORING_REVIEW_LIMIT',
          'Review metadata exceeds its response budget; inspect exact versions through existing scoped tools.',
        );
      return review;
    })();
  }
  list(input: unknown = {}) {
    const p = parseAuthoring(authoringListSchema, input);
    if (!authoringStorageExists(this.db)) return { proposals: [], truncated: false };
    const rows = this.db
      .prepare(
        `SELECT p.id,p.candidate_id,p.type,p.created_at FROM authoring_proposals p JOIN skill_version_states s ON s.version_id=p.candidate_id AND s.project_id=p.project_id WHERE p.project_id=? ${p.pending_only ? "AND s.status='candidate'" : ''} ORDER BY p.created_at,p.id LIMIT ? OFFSET ?`,
      )
      .all(this.#scope.id, p.limit + 1, p.offset) as {
      id: string;
      candidate_id: string;
      type: string;
      created_at: string;
    }[];
    return {
      proposals: rows.slice(0, p.limit).map((r) => ({
        ...r,
        state: new SkillStore(this.db, this.#scope).getVersion(r.candidate_id).state.status,
      })),
      truncated: rows.length > p.limit,
      warning: AUTHORING_WARNING,
      untrusted_data: true,
    };
  }
  diff(input: unknown) {
    const p = parseAuthoring(authoringDiffSchema, input);
    return this.db.transaction(() => {
      const row = this.row(p.proposal_id);
      const store = new SkillStore(this.db, this.#scope);
      const after = store.getVersion(row.candidate_id);
      const before = row.base_id ? store.getVersion(row.base_id) : null;
      const diff = diffSkillFiles(before?.version.files ?? [], after.version.files);
      if (!p.path)
        return {
          proposal_id: row.id,
          files: diff.map((f) => ({ path: f.path, change: f.change })),
          warning: AUTHORING_WARNING,
        };
      const file = diff.find((f) => f.path === p.path);
      if (!file)
        throw new AgentMindError(
          'AUTHORING_DIFF_UNAVAILABLE',
          'No changed package file matches this selector.',
        );
      const chunk = (s: string | null) =>
        s === null
          ? null
          : {
              content: s.slice(p.offset, p.offset + p.limit),
              digest: fileDigest(s),
              total_chars: s.length,
            };
      return {
        proposal_id: row.id,
        path: file.path,
        offset: p.offset,
        before: chunk(file.before),
        after: chunk(file.after),
        next_offset:
          Math.max(file.before?.length ?? 0, file.after?.length ?? 0) > p.offset + p.limit
            ? p.offset + p.limit
            : null,
        warning: AUTHORING_WARNING,
        untrusted_data: true,
      };
    })();
  }
  evaluate(input: unknown) {
    this.allowed();
    const p = parseAuthoring(authoringEvaluateSchema, input);
    return this.write(() => {
      const row = this.row(p.proposal_id);
      const mode = p.mode ?? (row.type === 'REWRITE_EXISTING' ? 'behavioral' : 'static');
      if (row.type === 'REWRITE_EXISTING' && mode !== 'behavioral')
        throw new AgentMindError(
          'AUTHORING_BEHAVIORAL_REQUIRED',
          'Rewrite evaluation through this helper requires behavioral mode; no static result is behavioral proof.',
        );
      const result = new SkillEvaluationService(this.db, this.#scope).evaluate({
        version_id: row.candidate_id,
        expected_content_hash: p.expected_content_hash,
        expected_state_revision: p.expected_state_revision,
        mode,
      });
      return {
        proposal_id: row.id,
        evaluation: {
          id: result.evaluation.id,
          result: result.evaluation.result,
          content_hash: result.evaluation.content_hash,
          evaluator_version: result.evaluation.evaluator_version,
        },
        capabilities: result.capabilities,
        warning: AUTHORING_WARNING,
        untrusted_data: true,
      };
    });
  }
  private row(id: string): ProposalRow {
    const row = authoringStorageExists(this.db)
      ? (this.db
          .prepare('SELECT * FROM authoring_proposals WHERE id=? AND project_id=?')
          .get(id, this.#scope.id) as ProposalRow | undefined)
      : undefined;
    if (!row)
      throw new AgentMindError('AUTHORING_NOT_FOUND', 'Proposal unavailable in this project.');
    return row;
  }
  private allowed() {
    if (!this.enabled)
      throw new AgentMindError(
        'SKILL_PROPOSALS_DISABLED',
        'Authoring is disabled by trusted runtime configuration.',
      );
  }
  private write<T>(f: () => T): T {
    try {
      return agentWrite(this.db, f);
    } catch (e) {
      if (e instanceof AgentMindError) throw e;
      throw new AgentMindError(
        'AUTHORING_STORAGE_FAILED',
        'Authoring transaction failed; no partial candidate or metadata was committed.',
      );
    }
  }
}

import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { AgentMindError } from '../errors.js';
import { assessLearning } from '../learning/evidence.js';
import { LEARNING_POLICY, type LearningSignal } from '../learning/model.js';
import { learningStorageExists } from '../learning/storage.js';
import type { ProjectScope } from '../project.js';
import { evidenceExists } from './data.js';
import {
  ADVISORY_WARNING,
  CURATOR_POLICY,
  curatorAnalyzeSchema,
  curatorDigest,
  curatorDismissSchema,
  curatorGetSchema,
  curatorId,
  curatorListSchema,
  curatorPolicySchema,
  draftRecommendationSchema,
  parseCurator,
  type RecommendationDraft,
  workerResultSchema,
} from './model.js';
import {
  compareRequestSchema,
  comparisonSchema,
  DETECTION_POLICY,
  duplicateOptionsSchema,
  duplicatePolicySchema,
  FEATURE_POLICY,
  SIMILARITY_LIMITATIONS,
} from './similarity/model.js';
import { migrateSimilarity } from './similarity/storage.js';
import { curatorStorageExists, migrateCurator } from './storage.js';

type Row = {
  id: string;
  project_id: string;
  skill_id: string;
  version_id: string;
  fingerprint: string;
  policy_version: string;
  config_digest: string;
  state: 'open' | 'dismissed' | 'superseded';
  priority: number;
  payload_json: string;
  revision: number;
  created_at: string;
  last_evaluated_at: string;
};
export class RecommendationService {
  readonly #scope: ProjectScope;
  readonly #policy;
  readonly #configDigest;
  readonly #duplicatePolicy;
  constructor(
    private readonly db: Database.Database,
    scope: ProjectScope,
    policy: unknown = {},
    duplicatePolicy: unknown = {},
  ) {
    this.#scope = Object.freeze({ ...scope });
    this.#policy = curatorPolicySchema.parse(policy);
    this.#configDigest = curatorDigest(this.#policy);
    this.#duplicatePolicy = duplicatePolicySchema.parse(duplicatePolicy);
  }
  analyze(input: unknown = {}) {
    parseCurator(curatorAnalyzeSchema, input);
    if (this.db.inTransaction || !isAbsolute(this.db.name))
      throw new AgentMindError(
        'CURATOR_ANALYSIS_UNAVAILABLE',
        'Analysis needs a persisted registry outside an enclosing transaction.',
      );
    if (!this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(this.#scope.id))
      throw new AgentMindError(
        'CURATOR_PROJECT_UNAVAILABLE',
        'Initialize the authorized project through the existing memory server before analysis.',
      );
    const asOf = new Date().toISOString();
    const version = this.db.pragma('data_version', { simple: true });
    const child = spawnSync(
      process.execPath,
      [
        '--max-old-space-size=96',
        fileURLToPath(new URL('../../dist/curator/worker.js', import.meta.url)),
      ],
      {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: {},
        encoding: 'utf8',
        timeout: this.#policy.budget_ms,
        killSignal: 'SIGKILL',
        maxBuffer: 524288,
        input: JSON.stringify({
          database: this.db.name,
          scope: this.#scope,
          policy: this.#policy,
          as_of: asOf,
        }),
      },
    );
    if (child.error || child.signal)
      throw new AgentMindError(
        'CURATOR_ANALYSIS_LIMIT',
        'Analysis exceeded its time, memory or output limit; no recommendations were stored.',
      );
    if (child.status !== 0)
      throw new AgentMindError(
        'CURATOR_ANALYSIS_FAILED',
        'Read-only analysis failed; no recommendation changes were stored.',
      );
    const result = workerResultSchema.parse(JSON.parse(child.stdout));
    return this.persistAnalysis(result, asOf, version);
  }
  private persistAnalysis(
    result: z.infer<typeof workerResultSchema>,
    asOf: string,
    version: unknown,
    extension?: {
      configDigest: string;
      cache: () => void;
      eligible: string[];
      completeSkills: boolean;
      policyVersion?: string;
      preserveOthers?: boolean;
    },
  ) {
    const policyVersion =
      extension?.policyVersion ?? (extension ? DETECTION_POLICY : CURATOR_POLICY);
    const configDigest = extension?.configDigest ?? this.#configDigest;
    const runFingerprint = curatorDigest([
      this.#scope.id,
      policyVersion,
      configDigest,
      asOf.slice(0, 10),
      result.source_digest,
      result.coverage,
    ]);
    return this.write(() => {
      if (this.db.pragma('data_version', { simple: true }) !== version)
        throw new AgentMindError(
          'CURATOR_ANALYSIS_STALE',
          'Registry changed during analysis; retry against a fresh snapshot.',
        );
      migrateCurator(this.db);
      extension?.cache();
      const old = this.db
        .prepare('SELECT summary_json FROM curator_runs WHERE project_id=? AND fingerprint=?')
        .get(this.#scope.id, runFingerprint) as { summary_json: string } | undefined;

      const ids: string[] = [];
      for (const draft of result.drafts) {
        for (const e of draft.evidence)
          if (!evidenceExists(this.db, this.#scope, e.kind, e.id))
            throw new AgentMindError(
              'CURATOR_EVIDENCE_UNAVAILABLE',
              'A recommendation source is missing or outside the authorized scope.',
            );
        if (
          !this.db
            .prepare('SELECT 1 FROM skill_versions WHERE id=? AND skill_id=? AND project_id=?')
            .get(draft.version_id, draft.skill_id, this.#scope.id)
        )
          throw new AgentMindError(
            'CURATOR_SCOPE_DENIED',
            'Target version is unavailable in this project.',
          );
        const fingerprint = curatorDigest([
          this.#scope.id,
          policyVersion,
          configDigest,
          draft.rule_id,
          draft.version_id,
          draft.related_version_id ?? null,
        ]);
        const id = curatorId(fingerprint);
        ids.push(id);
        const payload = JSON.stringify(draft);
        const current = this.db
          .prepare('SELECT * FROM curator_recommendations WHERE id=? AND project_id=?')
          .get(id, this.#scope.id) as Row | undefined;
        if (!current) {
          this.db
            .prepare('INSERT INTO curator_recommendations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(
              id,
              this.#scope.id,
              draft.skill_id,
              draft.version_id,
              fingerprint,
              policyVersion,
              configDigest,
              'open',
              { HIGH: 0, MEDIUM: 1, LOW: 2 }[draft.priority],
              payload,
              0,
              asOf,
              asOf,
            );
          this.history(id, 0, 'open', payload, asOf);
        } else {
          const state = current.state === 'superseded' ? 'open' : current.state;
          const changed = current.payload_json !== payload || state !== current.state;
          this.db
            .prepare(
              'UPDATE curator_recommendations SET state=?,priority=?,payload_json=?,revision=?,last_evaluated_at=? WHERE id=? AND project_id=?',
            )
            .run(
              state,
              { HIGH: 0, MEDIUM: 1, LOW: 2 }[draft.priority],
              payload,
              current.revision + (changed ? 1 : 0),
              asOf,
              id,
              this.#scope.id,
            );
          if (changed) this.history(id, current.revision + 1, state, payload, asOf);
        }
      }
      const complete = !extension?.preserveOthers && !Object.values(result.coverage).some(Boolean);
      if (complete || extension?.completeSkills) {
        const open = this.db
          .prepare(
            `SELECT * FROM curator_recommendations WHERE project_id=? AND state='open' AND ${extension ? "json_extract(payload_json,'$.rule_id') LIKE 'duplicates:%'" : "json_extract(payload_json,'$.rule_id') NOT LIKE 'duplicates:%' AND json_extract(payload_json,'$.rule_id') NOT LIKE 'learning:%'"} LIMIT 1001`,
          )
          .all(this.#scope.id) as Row[];
        if (open.length <= 1000)
          for (const row of open)
            if (
              !ids.includes(row.id) &&
              (complete ||
                (extension?.completeSkills &&
                  (!extension.eligible.includes(row.version_id) ||
                    !extension.eligible.includes(JSON.parse(row.payload_json).related_version_id))))
            ) {
              this.db
                .prepare(
                  "UPDATE curator_recommendations SET state='superseded',revision=revision+1,last_evaluated_at=? WHERE id=? AND project_id=?",
                )
                .run(asOf, row.id, this.#scope.id);
              this.history(row.id, row.revision + 1, 'superseded', row.payload_json, asOf);
            }
      }
      const summary = {
        run_id: curatorId(runFingerprint),
        project_id: this.#scope.id,
        policy_version: policyVersion,
        config_digest: configDigest,
        created_at: asOf,
        recommendation_count: ids.length,
        recommendation_ids: ids,
        coverage: result.coverage,
        advisory_only: true,
      };
      if (!old)
        this.db
          .prepare('INSERT INTO curator_runs VALUES(?,?,?,?,?,?)')
          .run(
            summary.run_id,
            this.#scope.id,
            runFingerprint,
            result.source_digest,
            asOf,
            JSON.stringify(summary),
          );
      return { ...summary, cached: !!old, warning: ADVISORY_WARNING };
    });
  }
  reconcileLearning(input: unknown) {
    return this.write(() => this.reconcileLearningLocked(input));
  }
  private reconcileLearningLocked(input: unknown) {
    const id = parseCurator(z.uuid(), input);
    const row = learningStorageExists(this.db)
      ? (this.db
          .prepare('SELECT payload_json FROM learning_signals WHERE id=? AND project_id=?')
          .get(id, this.#scope.id) as { payload_json: string } | undefined)
      : undefined;
    if (!row) throw new AgentMindError('LEARNING_NOT_FOUND', 'Signal unavailable in this scope.');
    if (!curatorStorageExists(this.db)) return;
    const signal = JSON.parse(row.payload_json) as LearningSignal;
    const triage = assessLearning(this.db, this.#scope, signal);
    const keep =
      signal.status === 'open' && !['IGNORE', 'RECORD_EXPERIENCE'].includes(triage.action)
        ? triage.related_versions[0]
        : null;
    return this.write(() => {
      const rows = this.db
        .prepare(
          "SELECT * FROM curator_recommendations WHERE project_id=? AND json_extract(payload_json,'$.rule_id')=? AND state='open' LIMIT 101",
        )
        .all(this.#scope.id, `learning:${id}`) as Row[];
      if (rows.length > 100)
        throw new AgentMindError(
          'LEARNING_RECONCILE_LIMIT',
          'Too many historical recommendation targets; inspect locally.',
        );
      for (const r of rows)
        if (r.version_id !== keep) {
          const at = new Date().toISOString();
          this.db
            .prepare(
              "UPDATE curator_recommendations SET state='superseded',revision=revision+1,last_evaluated_at=? WHERE id=? AND project_id=?",
            )
            .run(at, r.id, this.#scope.id);
          this.history(r.id, r.revision + 1, 'superseded', r.payload_json, at);
        }
    });
  }
  recommendLearning(input: unknown) {
    return this.write(() => this.recommendLearningLocked(input));
  }
  private recommendLearningLocked(input: unknown) {
    const id = parseCurator(z.uuid(), input);
    const row = learningStorageExists(this.db)
      ? (this.db
          .prepare('SELECT payload_json FROM learning_signals WHERE id=? AND project_id=?')
          .get(id, this.#scope.id) as { payload_json: string } | undefined)
      : undefined;
    if (!row)
      throw new AgentMindError('LEARNING_NOT_FOUND', 'Signal is unavailable in this scope.');
    const signal = JSON.parse(row.payload_json) as LearningSignal;
    if (signal.status !== 'open')
      throw new AgentMindError('LEARNING_CLOSED', 'Closed signals cannot escalate.');
    const triage = assessLearning(this.db, this.#scope, signal);
    this.reconcileLearning(id);
    if (!triage.related_versions.length || ['IGNORE', 'RECORD_EXPERIENCE'].includes(triage.action))
      return {
        stored: false,
        reason: 'No eligible existing skill target or escalation is warranted.',
        advisory_only: true,
      };
    const version = triage.related_versions[0];
    const target = this.db
      .prepare('SELECT skill_id FROM skill_versions WHERE id=? AND project_id=?')
      .get(version, this.#scope.id) as { skill_id: string } | undefined;
    if (!target)
      throw new AgentMindError('LEARNING_EVIDENCE_DENIED', 'Target version is unavailable.');
    const draft = draftRecommendationSchema.parse({
      skill_id: target.skill_id,
      version_id: version,
      rule_id: `learning:${id}`,
      type: 'INVESTIGATE',
      priority: 'LOW',
      priority_reason:
        'An advisory signal warrants scoped investigation; no impact or causation is established.',
      confidence: 'LOW',
      confidence_reason: 'Learning observations are not independently verified task success.',
      evidence: [
        { kind: 'learning_signal', id },
        { kind: 'skill_version', id: version },
      ],
      limitations: triage.limitations,
      explanation: triage.reason,
      suggested_action:
        'Inspect the signal and exact source records. Use separate existing experience, candidate, evaluation and human approval workflows if justified.',
    });
    return this.persistAnalysis(
      {
        drafts: [draft],
        source_digest: curatorDigest([signal, triage]),
        coverage: {
          skills_truncated: false,
          events_truncated: false,
          experiences_truncated: false,
          recommendations_truncated: false,
        },
      },
      new Date().toISOString(),
      this.db.pragma('data_version', { simple: true }),
      {
        configDigest: curatorDigest(LEARNING_POLICY),
        policyVersion: LEARNING_POLICY,
        preserveOthers: true,
        cache: () => {},
        eligible: [],
        completeSkills: false,
      },
    );
  }
  analyzeDuplicates(input: unknown = {}) {
    const p = parseCurator(duplicateOptionsSchema, input);
    const { result, version, asOf } = this.similarity(p, false);
    const summary = this.persistAnalysis(result, asOf, version, {
      configDigest: curatorDigest([FEATURE_POLICY, this.#duplicatePolicy, p]),
      eligible: result.eligible_version_ids,
      completeSkills: !result.coverage.skills_truncated,
      cache: () => {
        migrateSimilarity(this.db);
        for (const f of result.feature_writes)
          this.db
            .prepare(
              'INSERT INTO curator_feature_cache VALUES(?,?,?,?,?) ON CONFLICT(project_id,digest,policy) DO UPDATE SET payload=excluded.payload,checksum=excluded.checksum',
            )
            .run(this.#scope.id, f.digest, FEATURE_POLICY, f.payload, f.checksum);
        for (const pair of result.pair_writes)
          this.db
            .prepare(
              'INSERT INTO curator_pair_cache VALUES(?,?,?,?) ON CONFLICT(project_id,fingerprint) DO UPDATE SET payload=excluded.payload,checksum=excluded.checksum',
            )
            .run(this.#scope.id, pair.fingerprint, pair.payload, pair.checksum);
      },
    });
    return { ...summary, statistics: result.statistics };
  }
  compare(input: unknown) {
    const p = parseCurator(compareRequestSchema, input);
    const { result, version } = this.similarity(p, true);
    if (this.db.pragma('data_version', { simple: true }) !== version)
      throw new AgentMindError('CURATOR_ANALYSIS_STALE', 'Registry changed; repeat comparison.');
    return {
      comparisons: result.comparisons,
      project_id: this.#scope.id,
      limitations: SIMILARITY_LIMITATIONS,
      untrusted_data: true,
      advisory_only: true,
      warning: ADVISORY_WARNING,
    };
  }
  private similarity(input: unknown, compare: boolean) {
    if (this.db.inTransaction || !isAbsolute(this.db.name))
      throw new AgentMindError(
        'CURATOR_ANALYSIS_UNAVAILABLE',
        'Comparison needs a persisted registry outside a transaction.',
      );
    if (!this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(this.#scope.id))
      throw new AgentMindError(
        'CURATOR_PROJECT_UNAVAILABLE',
        'Initialize the authorized project first.',
      );
    const version = this.db.pragma('data_version', { simple: true });
    const asOf = new Date().toISOString();
    const child = spawnSync(
      process.execPath,
      [
        '--max-old-space-size=192',
        fileURLToPath(new URL('../../dist/curator/worker.js', import.meta.url)),
      ],
      {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: {},
        encoding: 'utf8',
        timeout: 5000,
        killSignal: 'SIGKILL',
        maxBuffer: 33554432,
        input: JSON.stringify({
          database: this.db.name,
          scope: this.#scope,
          policy: this.#policy,
          as_of: asOf,
          similarity: { policy: this.#duplicatePolicy, input, compare },
        }),
      },
    );
    if (child.error || child.signal)
      throw new AgentMindError(
        'CURATOR_ANALYSIS_LIMIT',
        'Duplicate analysis exceeded its resource limit; nothing was stored.',
      );
    if (child.status !== 0)
      throw new AgentMindError(
        'CURATOR_ANALYSIS_FAILED',
        'Artifact, eligibility or comparison validation failed; no advisory changes stored.',
      );
    const cacheRow = z.strictObject({
      payload: z.string().max(8192),
      checksum: z.string().regex(/^[a-f0-9]{64}$/),
    });
    const result = workerResultSchema
      .extend({
        comparisons: z.array(comparisonSchema).max(1),
        feature_writes: z
          .array(cacheRow.extend({ digest: z.string().regex(/^[a-f0-9]{64}$/) }))
          .max(5000),
        pair_writes: z
          .array(cacheRow.extend({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }))
          .max(10000),
        eligible_version_ids: z.array(z.uuid()).max(5000),
        statistics: z.strictObject({
          skills: z.number(),
          pair_count: z.number(),
          feature_cache_hits: z.number(),
          pair_cache_hits: z.number(),
          feature_ms: z.number(),
          retrieval_ms: z.number(),
          scoring_ms: z.number(),
          peak_rss_bytes: z.number(),
        }),
      })
      .parse(JSON.parse(child.stdout));
    return { result, version, asOf };
  }
  list(input: unknown = {}) {
    const p = parseCurator(curatorListSchema, input);
    if (!curatorStorageExists(this.db))
      return {
        recommendations: [],
        truncated: false,
        untrusted_data: true,
        warning: ADVISORY_WARNING,
      };
    const args: Array<string | number> = [this.#scope.id];
    const conditions = ['project_id=?'];
    if (p.state !== 'all') {
      conditions.push('state=?');
      args.push(p.state);
    }
    if (p.skill_id) {
      conditions.push("(skill_id=? OR json_extract(payload_json,'$.comparison.right_skill_id')=?)");
      args.push(p.skill_id, p.skill_id);
    }
    if (p.classification) {
      conditions.push("json_extract(payload_json,'$.comparison.classification')=?");
      args.push(p.classification);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM curator_recommendations WHERE ${conditions.join(' AND ')} ORDER BY priority,id LIMIT ? OFFSET ?`,
      )
      .all(...args, p.limit + 1, p.offset) as Row[];
    return {
      recommendations: rows.slice(0, p.limit).map((r) => this.present(r)),
      truncated: rows.length > p.limit,
      next_offset: rows.length > p.limit && p.offset + p.limit <= 10000 ? p.offset + p.limit : null,
      untrusted_data: true,
      warning: ADVISORY_WARNING,
    };
  }
  get(input: unknown) {
    const p = parseCurator(curatorGetSchema, input);
    return {
      ...this.present(this.row(p.recommendation_id)),
      untrusted_data: true,
      warning: ADVISORY_WARNING,
    };
  }
  dismiss(input: unknown) {
    const p = parseCurator(curatorDismissSchema, input);
    return this.write(() => {
      const r = this.row(p.recommendation_id);
      if (r.revision !== p.expected_revision)
        throw new AgentMindError(
          'CURATOR_RECOMMENDATION_STALE',
          'Recommendation changed; inspect it before dismissing.',
        );
      if (r.state === 'dismissed') return this.get({ recommendation_id: r.id });
      const at = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE curator_recommendations SET state='dismissed',revision=revision+1 WHERE id=? AND project_id=?",
        )
        .run(r.id, this.#scope.id);
      this.history(r.id, r.revision + 1, 'dismissed', r.payload_json, at);
      return this.get({ recommendation_id: r.id });
    });
  }
  private row(id: string): Row {
    const r = curatorStorageExists(this.db)
      ? (this.db
          .prepare('SELECT * FROM curator_recommendations WHERE id=? AND project_id=?')
          .get(id, this.#scope.id) as Row | undefined)
      : undefined;
    if (!r)
      throw new AgentMindError(
        'CURATOR_RECOMMENDATION_NOT_FOUND',
        'Recommendation is unavailable in this scope.',
      );
    return r;
  }
  private present(r: Row) {
    const payload: RecommendationDraft = draftRecommendationSchema.parse(
      JSON.parse(r.payload_json),
    );
    return {
      id: r.id,
      project_id: r.project_id,
      fingerprint: r.fingerprint,
      policy_version: r.policy_version,
      configuration_digest: r.config_digest,
      state: r.state,
      revision: r.revision,
      created_at: r.created_at,
      last_evaluated_at: r.last_evaluated_at,
      ...payload,
      evidence_status: payload.evidence.map((e) => ({
        ...e,
        status: evidenceExists(this.db, this.#scope, e.kind, e.id)
          ? 'AVAILABLE'
          : 'MISSING_OR_UNAVAILABLE',
      })),
      advisory_only: true,
    };
  }
  private history(id: string, revision: number, state: string, payload: string, at: string) {
    this.db
      .prepare(
        'INSERT INTO curator_history(project_id,recommendation_id,revision,state,payload_json,created_at) VALUES(?,?,?,?,?,?)',
      )
      .run(this.#scope.id, id, revision, state, payload, at);
  }
  private write<T>(fn: () => T): T {
    const previous = this.db.pragma('busy_timeout', { simple: true });
    this.db.pragma('busy_timeout=150');
    try {
      return this.db.transaction(fn).immediate();
    } catch (error) {
      if (error instanceof AgentMindError) throw error;
      throw new AgentMindError(
        'CURATOR_STORAGE_FAILED',
        'Recommendation metadata transaction failed; no lifecycle action was authorized.',
      );
    } finally {
      this.db.pragma(`busy_timeout=${Number(previous)}`);
    }
  }
}

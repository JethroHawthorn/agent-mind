import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { AgentMindError } from '../errors.js';
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
  constructor(
    private readonly db: Database.Database,
    scope: ProjectScope,
    policy: unknown = {},
  ) {
    this.#scope = Object.freeze({ ...scope });
    this.#policy = curatorPolicySchema.parse(policy);
    this.#configDigest = curatorDigest(this.#policy);
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
    const runFingerprint = curatorDigest([
      this.#scope.id,
      CURATOR_POLICY,
      this.#configDigest,
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
          CURATOR_POLICY,
          this.#configDigest,
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
              CURATOR_POLICY,
              this.#configDigest,
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
      const complete = !Object.values(result.coverage).some(Boolean);
      if (complete) {
        const open = this.db
          .prepare(
            "SELECT * FROM curator_recommendations WHERE project_id=? AND state='open' LIMIT 1001",
          )
          .all(this.#scope.id) as Row[];
        if (open.length <= 1000)
          for (const row of open)
            if (!ids.includes(row.id)) {
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
        policy_version: CURATOR_POLICY,
        config_digest: this.#configDigest,
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
      conditions.push('skill_id=?');
      args.push(p.skill_id);
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

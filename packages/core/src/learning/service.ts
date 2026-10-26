import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { curatorDigest, curatorId } from '../curator/model.js';
import { RecommendationService } from '../curator/service.js';
import { curatorStorageExists } from '../curator/storage.js';
import { AgentMindError } from '../errors.js';
import { normalizeExperienceText } from '../experience.js';
import { sanitizeExperienceText } from '../experience-privacy.js';
import { consumeOperatorGrant, reviewDigest } from '../operator-confirmation.js';
import type { ProjectScope } from '../project.js';
import type { UsageSource } from '../skill-usage-model.js';
import { nextTimestamp } from '../timestamp.js';
import { assessLearning, evaluationFact, referenceExists } from './evidence.js';
import {
  type LearningSignal,
  learningDetectSchema,
  learningIdSchema,
  learningListSchema,
  learningRecordSchema,
  learningRefreshSchema,
  learningStateSchema,
  parseLearning,
  type SignalInput,
  type SignalOrigin,
} from './model.js';
import { learningStorageExists, migrateLearning } from './storage.js';
export class LearningSignalService {
  readonly #scope: ProjectScope;
  constructor(
    private readonly db: Database.Database,
    scope: ProjectScope,
    private readonly source: UsageSource = 'unknown',
    private readonly adapter: 'explicit-mcp-v1' | 'explicit-cli-v1' = 'explicit-mcp-v1',
    private readonly enabled = true,
  ) {
    this.#scope = Object.freeze({ ...scope });
  }
  record(input: unknown) {
    const p = parseLearning(learningRecordSchema, input);
    if (!this.enabled) return { stored: false, disabled: true, advisory_only: true };
    const title = sanitizeExperienceText(p.title).text,
      summary = sanitizeExperienceText(p.summary).text;
    const clean = parseLearning(learningRecordSchema, {
      ...p,
      title,
      summary,
      supporting_evidence: p.supporting_evidence.map((e) => ({
        ...e,
        reference: sanitizeExperienceText(e.reference).text,
        summary: sanitizeExperienceText(e.summary).text,
      })),
    });
    if (normalizeExperienceText(summary).split(' ').length < 6)
      return {
        stored: false,
        action: 'IGNORE',
        reason: 'Generic or too short to capture a reusable lesson.',
        advisory_only: true,
      };
    return this.write(() =>
      this.capture(clean, {
        source_agent: this.source,
        adapter: this.adapter,
        detection_source: 'agent_reported',
      }),
    );
  }
  private capture(p: SignalInput, origin: SignalOrigin, anchor?: string) {
    migrateLearning(this.db);
    const fingerprint = curatorDigest([
      this.#scope.id,
      p.type,
      anchor ?? [normalizeExperienceText(p.title), normalizeExperienceText(p.summary)],
    ]);
    const id = curatorId(fingerprint);
    const old = this.find(id);
    const originalEvidence = old ? this.evidenceFingerprint(old) : null;
    const refs = [
      ...p.evidence,
      ...p.experience_ids.map((id) => ({ kind: 'experience' as const, id })),
      ...p.version_ids.map((id) => ({ kind: 'skill_version' as const, id })),
    ];
    for (const e of refs)
      if (!referenceExists(this.db, this.#scope, e))
        throw new AgentMindError(
          'LEARNING_EVIDENCE_DENIED',
          'Evidence is missing or outside the permitted project.',
        );
    const at = old ? nextTimestamp(old.updated_at) : new Date().toISOString();
    const hash = (s: string | undefined) =>
      s ? createHash('sha256').update(`${this.#scope.id}\0${s}`).digest('hex') : null;
    const signal: LearningSignal = old ?? {
      schema_version: 1,
      id,
      project_id: this.#scope.id,
      type: p.type,
      title: p.title,
      summary: p.summary,
      evidence: [...new Map(p.evidence.map((e) => [`${e.kind}:${e.id}`, e])).values()].sort(
        (a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`),
      ),
      supporting_evidence: [
        ...new Map(p.supporting_evidence.map((e) => [`${e.kind}:${e.reference}`, e])).values(),
      ].sort((a, b) => `${a.kind}:${a.reference}`.localeCompare(`${b.kind}:${b.reference}`)),
      experience_ids: [...new Set(p.experience_ids)].sort(),
      version_ids: [...new Set(p.version_ids)].sort(),
      reusability: p.reusability,
      origin,
      session_ref: hash(p.session_ref),
      task_ref: hash(p.task_ref),
      fingerprint,
      status: 'open',
      revision: 0,
      created_at: at,
      updated_at: at,
      triage: null as unknown as LearningSignal['triage'],
    };
    if (old) {
      signal.evidence = [
        ...new Map([...old.evidence, ...p.evidence].map((e) => [`${e.kind}:${e.id}`, e])).values(),
      ].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
      signal.supporting_evidence = [
        ...new Map(
          [...old.supporting_evidence, ...p.supporting_evidence].map((e) => [
            `${e.kind}:${e.reference}`,
            e,
          ]),
        ).values(),
      ];
      signal.supporting_evidence.sort((a, b) =>
        `${a.kind}:${a.reference}`.localeCompare(`${b.kind}:${b.reference}`),
      );
      signal.experience_ids = [...new Set([...old.experience_ids, ...p.experience_ids])].sort();
      signal.version_ids = [...new Set([...old.version_ids, ...p.version_ids])].sort();
      if (
        signal.supporting_evidence.length > 3 ||
        signal.evidence.length > 8 ||
        signal.experience_ids.length > 4 ||
        signal.version_ids.length > 4
      )
        throw new AgentMindError(
          'LEARNING_REFERENCE_LIMIT',
          'Reference union exceeds the bounded signal contract.',
        );
    }
    if (signal.operator_correction && originalEvidence !== this.evidenceFingerprint(signal))
      delete signal.operator_correction;
    const before = old ? JSON.stringify(this.find(id)) : '';
    signal.triage = assessLearning(this.db, this.#scope, signal);
    if (!old || JSON.stringify(signal) !== before) {
      if (old) {
        signal.revision++;
        signal.updated_at = at;
      } else if (
        (
          this.db
            .prepare('SELECT COUNT(*) AS n FROM learning_signals WHERE project_id=?')
            .get(this.#scope.id) as { n: number }
        ).n >= 10000
      )
        throw new AgentMindError(
          'LEARNING_CAPACITY',
          'Project signal capacity reached; no historical records were deleted.',
        );
      this.persist(signal);
    }
    return { stored: true, duplicate: !!old, ...this.compact(signal) };
  }
  get(input: unknown) {
    const p = parseLearning(learningIdSchema, input);
    const s = this.required(p.signal_id);
    return {
      ...s,
      triage: assessLearning(this.db, this.#scope, s),
      advisory_only: true,
      untrusted_data: true,
    };
  }
  list(input: unknown = {}) {
    const p = parseLearning(learningListSchema, input);
    if (!learningStorageExists(this.db))
      return { signals: [], truncated: false, advisory_only: true };
    const rows = this.db
      .prepare(
        `SELECT id FROM learning_signals WHERE project_id=? ${p.status === 'all' ? '' : 'AND status=?'} ORDER BY id LIMIT ? OFFSET ?`,
      )
      .all(this.#scope.id, ...(p.status === 'all' ? [] : [p.status]), p.limit + 1, p.offset) as {
      id: string;
    }[];
    return {
      signals: rows.slice(0, p.limit).map((row) =>
        this.compact({
          ...this.required(row.id),
          triage: assessLearning(this.db, this.#scope, this.required(row.id)),
        }),
      ),
      truncated: rows.length > p.limit,
      advisory_only: true,
      untrusted_data: true,
    };
  }
  refresh(input: unknown) {
    const p = parseLearning(learningRefreshSchema, input);
    return this.write(() => {
      const s = this.expected(p.signal_id, p.expected_revision);
      const triage = assessLearning(this.db, this.#scope, s);
      if (JSON.stringify(triage) !== JSON.stringify(s.triage)) {
        s.triage = triage;
        s.revision++;
        s.updated_at = nextTimestamp(s.updated_at);
        this.persist(s);
        new RecommendationService(this.db, this.#scope).reconcileLearning(s.id);
      }
      return this.compact(s);
    });
  }
  state(input: unknown) {
    const p = parseLearning(learningStateSchema, input);
    return this.write(() => {
      const s = this.expected(p.signal_id, p.expected_revision);
      if (s.status !== p.state) {
        s.status = p.state;
        s.revision++;
        s.updated_at = nextTimestamp(s.updated_at);
        this.persist(s);
        new RecommendationService(this.db, this.#scope).reconcileLearning(s.id);
      }
      return this.compact(s);
    });
  }
  prepareCorrection(input: unknown) {
    const p = parseLearning(learningRefreshSchema, input);
    const s = this.expected(p.signal_id, p.expected_revision);
    if (s.type !== 'USER_CORRECTION' || s.status !== 'open')
      throw new AgentMindError(
        'LEARNING_CORRECTION_INELIGIBLE',
        'Only an open explicit user-correction claim can be attested.',
      );
    return {
      action: 'attest-learning-correction',
      signal: s,
      warning: 'Local operator attestation is not adversarial authentication or task verification.',
    };
  }
  confirmCorrection(input: unknown, grant: unknown) {
    return this.write(() => {
      const preview = this.prepareCorrection(input);
      const auth = consumeOperatorGrant(grant, reviewDigest(preview));
      const s = preview.signal;
      s.operator_correction = {
        operator: auth.operator,
        session: auth.session,
        digest: auth.digest,
        method: 'local-tty-learning-correction-v1',
      };
      s.triage = assessLearning(this.db, this.#scope, s);
      s.revision++;
      s.updated_at = nextTimestamp(s.updated_at);
      this.persist(s);
      return this.compact(s);
    });
  }
  recommend(input: unknown) {
    const p = parseLearning(learningIdSchema, input);
    this.get(p);
    return new RecommendationService(this.db, this.#scope).recommendLearning(p.signal_id);
  }
  detect(input: unknown = {}) {
    const p = parseLearning(learningDetectSchema, input);
    if (!this.enabled) return { stored: 0, disabled: true, advisory_only: true };
    return this.write(() => {
      migrateLearning(this.db);
      const ids = new Set<string>();
      const cursors: Record<string, number> = {};
      let more = false;
      const process = (
        source: string,
        sql: string,
        convert: (r: Record<string, unknown>) => SignalInput | null,
      ) => {
        const last =
          (
            this.db
              .prepare('SELECT last_row FROM learning_cursors WHERE project_id=? AND source=?')
              .get(this.#scope.id, source) as { last_row: number } | undefined
          )?.last_row ?? 0;
        const rows = this.db.prepare(sql).all(this.#scope.id, last, p.limit + 1) as Array<
          Record<string, unknown> & { cursor: number; id: string }
        >;
        more ||= rows.length > p.limit;
        let cursor = last;
        for (const row of rows.slice(0, p.limit)) {
          const record = convert(row);
          if (record) {
            const origin: SignalOrigin = {
              source_agent: 'unknown',
              adapter: 'deterministic-records-v1',
              detection_source: source === 'evaluation' ? 'verified_observation' : 'deterministic',
            };
            const saved = this.capture(record, origin, `${source}:${row.id}`);
            ids.add(saved.id);
          }
          cursor = row.cursor;
        }
        this.db
          .prepare(
            'INSERT INTO learning_cursors VALUES(?,?,?) ON CONFLICT(project_id,source) DO UPDATE SET last_row=excluded.last_row',
          )
          .run(this.#scope.id, source, cursor);
        cursors[source] = cursor;
      };
      const record = (
        type: SignalInput['type'],
        title: string,
        summary: string,
        evidence: SignalInput['evidence'],
        version_ids: string[] = [],
        experience_ids: string[] = [],
      ): SignalInput => ({
        schema_version: 1,
        supporting_evidence: [],
        type,
        title,
        summary,
        evidence,
        version_ids,
        experience_ids,
        reusability: 'unknown',
      });
      process(
        'evaluation',
        'SELECT rowid AS cursor,id,version_id FROM skill_evaluations WHERE project_id=? AND rowid>? ORDER BY rowid LIMIT ?',
        (r) =>
          evaluationFact(this.db, this.#scope, String(r.id))
            ? record(
                'SKILL_GAP',
                'Static skill evaluation failed',
                'A persisted deterministic static check failed. Investigate the exact artifact; this does not prove a task or behavioral failure.',
                [{ kind: 'evaluation', id: String(r.id) }],
                [String(r.version_id)],
              )
            : null,
      );
      process(
        'experience',
        'SELECT rowid AS cursor,id,outcome_status FROM experiences WHERE project_id=? AND rowid>? ORDER BY rowid LIMIT ?',
        (r) =>
          record(
            r.outcome_status === 'failed'
              ? 'REPEATED_FAILURE'
              : r.outcome_status === 'succeeded'
                ? 'PROBLEM_SOLVED'
                : 'NEW_PATTERN',
            'Structured experience may contain a lesson',
            'An existing structured experience contains an explicitly reported outcome. Its approval and outcome are not independent verification.',
            [{ kind: 'experience', id: String(r.id) }],
            [],
            [String(r.id)],
          ),
      );
      process(
        'usage',
        'SELECT d.rowid AS cursor,u.event_id AS id,u.version_id,u.event_type FROM skill_usage_dedup d LEFT JOIN skill_usage_events u ON u.event_id=d.event_id AND u.project_id=d.project_id WHERE d.project_id=? AND d.rowid>? ORDER BY d.rowid LIMIT ?',
        (r) =>
          r.event_type === 'task_failed'
            ? record(
                'REPEATED_FAILURE',
                'Referenced skill task failure report',
                'An existing task failure report may warrant investigation. Repeated reports and task labels do not establish causal or independent evidence.',
                [{ kind: 'usage', id: String(r.id) }],
                [String(r.version_id)],
              )
            : null,
      );
      if (curatorStorageExists(this.db))
        process(
          'recommendation',
          'SELECT h.id AS cursor,r.id,r.payload_json,r.state FROM curator_history h JOIN curator_recommendations r ON r.id=h.recommendation_id AND r.project_id=h.project_id WHERE h.project_id=? AND h.id>? ORDER BY h.id LIMIT ?',
          (r) => {
            const rec = JSON.parse(String(r.payload_json));
            if (r.state !== 'open' || rec.rule_id?.startsWith('learning:')) return null;
            const conflict = rec.comparison?.classification === 'POSSIBLE_CONFLICT';
            return record(
              conflict ? 'SKILL_CONFLICT' : 'SKILL_GAP',
              'Advisory skill finding may warrant investigation',
              'An existing advisory recommendation suggests investigation. Lexical overlap and possible conflict are not semantic or behavioral proof.',
              [{ kind: 'recommendation', id: String(r.id) }],
              [rec.version_id, ...(rec.related_version_id ? [rec.related_version_id] : [])],
            );
          },
        );
      return { stored: ids.size, signal_ids: [...ids], cursors, more, advisory_only: true };
    });
  }
  private evidenceFingerprint(s: LearningSignal) {
    return curatorDigest([
      [...s.evidence].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
      [...s.supporting_evidence].sort((a, b) =>
        `${a.kind}:${a.reference}`.localeCompare(`${b.kind}:${b.reference}`),
      ),
      [...s.experience_ids].sort(),
      [...s.version_ids].sort(),
    ]);
  }
  private compact(s: LearningSignal) {
    return {
      id: s.id,
      status: s.status,
      revision: s.revision,
      type: s.type,
      action: s.triage.action,
      evidence_trust: s.triage.evidence_trust,
      experience_ids: s.triage.related_experiences,
      version_ids: s.triage.related_versions,
      advisory_only: true,
      untrusted_data: true,
    };
  }
  private find(id: string): LearningSignal | undefined {
    return learningStorageExists(this.db)
      ? (JSON.parse(
          (
            this.db
              .prepare('SELECT payload_json FROM learning_signals WHERE id=? AND project_id=?')
              .get(id, this.#scope.id) as { payload_json: string } | undefined
          )?.payload_json ?? 'null',
        ) ?? undefined)
      : undefined;
  }
  private required(id: string) {
    const s = this.find(id);
    if (!s)
      throw new AgentMindError('LEARNING_NOT_FOUND', 'Signal is unavailable in this project.');
    return s;
  }
  private expected(id: string, revision: number) {
    const s = this.required(id);
    if (s.revision !== revision)
      throw new AgentMindError('LEARNING_STALE', 'Signal changed; inspect the current revision.');
    return s;
  }
  private persist(s: LearningSignal) {
    if (s.revision > 128)
      throw new AgentMindError(
        'LEARNING_REVISION_LIMIT',
        'Signal history limit reached; retained history was not deleted.',
      );
    const payload = JSON.stringify(s);
    if (Buffer.byteLength(payload) > 8192)
      throw new AgentMindError(
        'LEARNING_PAYLOAD_LIMIT',
        'Sanitized learning metadata exceeds its byte budget.',
      );
    if (this.find(s.id))
      this.db
        .prepare(
          'UPDATE learning_signals SET status=?,revision=?,payload_json=? WHERE id=? AND project_id=?',
        )
        .run(s.status, s.revision, payload, s.id, this.#scope.id);
    else
      this.db
        .prepare('INSERT INTO learning_signals VALUES(?,?,?,?,?,?)')
        .run(s.id, this.#scope.id, s.fingerprint, s.status, s.revision, payload);
    this.db
      .prepare(
        'INSERT INTO learning_history(signal_id,project_id,revision,payload_json) VALUES(?,?,?,?)',
      )
      .run(s.id, this.#scope.id, s.revision, payload);
  }
  private write<T>(operation: () => T): T {
    const previous = this.db.pragma('busy_timeout', { simple: true });
    this.db.pragma('busy_timeout=200');
    try {
      if (!this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(this.#scope.id))
        throw new AgentMindError(
          'LEARNING_PROJECT_UNAVAILABLE',
          'Initialize the permitted project through the existing memory server first.',
        );
      return this.db.transaction(operation).immediate();
    } catch (error) {
      if (error instanceof AgentMindError) throw error;
      throw new AgentMindError(
        'LEARNING_STORAGE_FAILED',
        'Learning metadata transaction failed; nothing was claimed stored.',
      );
    } finally {
      this.db.pragma(`busy_timeout=${Number(previous)}`);
    }
  }
}

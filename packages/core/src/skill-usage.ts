import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { AgentMindError } from './errors.js';
import { sanitizeExperienceText } from './experience-privacy.js';
import { consumeOperatorGrant, reviewDigest } from './operator-confirmation.js';
import type { ProjectScope } from './project.js';
import { hashSkillFiles } from './skill-model.js';
import { SkillStore } from './skill-store.js';
import {
  type UsageEvent,
  type UsageEvidence,
  type UsageReport,
  type UsageSource,
  usageOutcomeSchema,
  usageQuerySchema,
  usageReportSchema,
  usageRetentionSchema,
  usageSummarySchema,
} from './skill-usage-model.js';
import { validateSkillBundle } from './skill-validation.js';

const WARNING =
  'Telemetry describes associations, not causal improvement. Installation, metadata retrieval, skill expansion and passing checks do not prove task success. Same-UID callers can forge local instrumentation; agent reports remain unverified.';
export function usageObservationId(key: string) {
  const hex = createHash('sha256').update(`agentmind-usage-v1:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  try {
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > 8192) throw new Error('size');
    const p = schema.safeParse(input);
    if (p.success) return p.data;
  } catch {
    /* Never echo untrusted input. */
  }
  throw new AgentMindError('INVALID_USAGE_INPUT', 'Invalid or oversized telemetry input.');
}
function clean(value: string | undefined) {
  return value === undefined ? undefined : sanitizeExperienceText(value).text;
}

/** Scoped transport-independent collector. Public reporting never accepts trust/actor/project claims. */
export class SkillUsageService {
  readonly #scope: ProjectScope;
  constructor(
    private readonly db: Database.Database,
    scope: ProjectScope,
    readonly source: UsageSource,
    readonly enabled = true,
  ) {
    this.#scope = Object.freeze({ ...scope });
  }

  private reference(versionId: string, digest: string) {
    const r = new SkillStore(this.db, this.#scope).getVersion(versionId);
    if (
      hashSkillFiles(r.version.files) !== r.version.content_hash ||
      digest !== r.version.content_hash
    )
      throw new AgentMindError(
        'USAGE_ARTIFACT_MISMATCH',
        'Telemetry artifact does not match its immutable version.',
      );
    // Historical approval is provenance, not permission to execute a currently revoked skill.
    const approved = this.db
      .prepare(`SELECT id FROM skill_operator_events WHERE project_id=? AND version_id=?
      AND content_hash=? AND action='approve' AND authorization_method='local-tty-confirmation-v1' LIMIT 1`)
      .get(this.#scope.id, versionId, digest);
    if (!approved)
      throw new AgentMindError(
        'USAGE_APPROVAL_REQUIRED',
        'Usage requires an operator-approved artifact reference.',
      );
    return r;
  }
  record(input: unknown) {
    return this.#append(parse(usageReportSchema, input), this.source, {
      category: 'llm_reported',
      method: 'explicit-report-v1',
      verification: 'unverified',
      details: { claim_only: true },
    });
  }
  /** Called only after successful exact content retrieval by the actual MCP handler. */
  observeMcpDiscovery(versionId: string, digest: string) {
    if (!this.enabled) return { stored: false, disabled: true };
    return this.#append(
      {
        event_id: randomUUID(),
        schema_version: 1,
        version_id: versionId,
        artifact_digest: digest,
        event_type: 'discovered',
      },
      this.source,
      {
        category: 'mcp_observation',
        method: 'mcp-skill-get-v1',
        verification: 'observed',
        details: {
          observation:
            'approved registry content resolved by skill_get; client receipt, native discovery and invocation not attested',
        },
      },
    );
  }
  /** Local native instrumentation entrypoint; not exposed over MCP. Payload origin is not authenticated. */
  observeHook(report: unknown) {
    const p = parse(usageReportSchema, report);
    if (!['invoked', 'executed'].includes(p.event_type))
      throw new AgentMindError('INVALID_USAGE_INPUT', 'Hook events cannot assert task outcomes.');
    return this.#append(p, 'claude', {
      category: 'native_hook',
      method: 'claude-skill-tool-v1',
      verification: 'observed',
      details: {
        version_binding:
          'managed installation observed at collection time; native loaded bytes not attested',
        execution_semantics: 'Skill tool request/completion only, not workflow or task completion',
        origin_authenticated: false,
      },
    });
  }
  /** Direct slash presence is deduplicated per installation/version/session, not per invocation. */
  observeSlashPresence(report: unknown) {
    const p = parse(usageReportSchema, report);
    if (p.event_type !== 'discovered')
      throw new AgentMindError(
        'INVALID_USAGE_INPUT',
        'Slash presence cannot assert invocation or outcomes.',
      );
    return this.#append(p, 'claude', {
      category: 'native_hook',
      method: 'claude-slash-presence-v1',
      verification: 'observed',
      details: {
        observation: 'direct slash expansion observed at least once in this session',
        deduplication:
          'installation/version/session presence; repeat commands and retries collapse',
        version_binding:
          'managed installation at collection time; native loaded bytes not attested',
        invocation_count_known: false,
        completion_known: false,
        origin_authenticated: false,
      },
    });
  }
  #append(
    input: Omit<UsageReport, 'event_type'> & {
      event_type: UsageReport['event_type'] | 'installed';
    },
    source: UsageSource,
    evidence: UsageEvidence,
    authorization?: object,
  ) {
    if (!this.enabled) return { stored: false, disabled: true };
    const report = {
      ...input,
      timestamp: input.timestamp ? new Date(input.timestamp).toISOString() : undefined,
      session_id: input.session_id
        ? reviewDigest({ project: this.#scope.id, source, session: clean(input.session_id) })
        : undefined,
      task_id: input.task_id
        ? reviewDigest({ project: this.#scope.id, task: clean(input.task_id) })
        : undefined,
      evidence_reference: clean(input.evidence_reference),
      note: clean(input.note),
    };
    if (report.timestamp && Date.parse(report.timestamp) > Date.now() + 300000)
      throw new AgentMindError(
        'INVALID_USAGE_INPUT',
        'Telemetry timestamp is too far in the future.',
      );
    const hash = reviewDigest({ report, source, evidence });
    const busyTimeout = this.db.pragma('busy_timeout', { simple: true }) as number;
    this.db.pragma('busy_timeout=150');
    try {
      return this.db
        .transaction(() => {
          const previous = this.db
            .prepare('SELECT project_id,payload_hash FROM skill_usage_dedup WHERE event_id=?')
            .get(report.event_id) as { project_id: string; payload_hash: string } | undefined;
          if (previous) {
            if (previous.project_id !== this.#scope.id || previous.payload_hash !== hash)
              throw new AgentMindError(
                'USAGE_EVENT_CONFLICT',
                'Event ID is already bound to a different event.',
              );
            return { stored: false, duplicate: true, event_id: report.event_id };
          }
          const r = this.reference(report.version_id, report.artifact_digest);
          if (
            report.installation_id &&
            !this.db
              .prepare(
                `SELECT id FROM skill_installations WHERE id=? AND project_id=? AND skill_id=? ${input.event_type === 'installed' ? '' : 'AND version_id=? AND installed_digest=?'}`,
              )
              .get(
                report.installation_id,
                this.#scope.id,
                r.version.skill_id,
                ...(input.event_type === 'installed'
                  ? []
                  : [report.version_id, report.artifact_digest]),
              )
          )
            throw new AgentMindError(
              'USAGE_INSTALLATION_MISMATCH',
              'Installation does not match the scoped version.',
            );
          const received = new Date().toISOString();
          const event: UsageEvent = {
            event_id: report.event_id,
            schema_version: 1,
            project_id: this.#scope.id,
            skill_id: r.version.skill_id,
            version_id: report.version_id,
            artifact_digest: r.version.content_hash,
            timestamp: report.timestamp ?? received,
            received_at: received,
            source_cli: source,
            event_type: report.event_type,
            installation_id: report.installation_id ?? null,
            session_id: report.session_id ?? null,
            task_id: report.task_id ?? null,
            evidence_reference: report.evidence_reference ?? null,
            note: report.note ?? null,
            category: evidence.category,
            method: evidence.method,
            verification: evidence.verification,
            details: { ...evidence.details, ...(authorization ? { authorization } : {}) },
          };
          this.db
            .prepare('INSERT INTO skill_usage_dedup VALUES(?,?,?,?)')
            .run(event.event_id, event.project_id, hash, received);
          const { details, ...fields } = event;
          this.db
            .prepare(`INSERT INTO skill_usage_events (${Object.keys(fields).join(',')},details_json)
          VALUES (${Object.keys(fields)
            .map((k) => `@${k}`)
            .join(',')},@details_json)`)
            .run({ ...fields, details_json: JSON.stringify(details) });
          return { stored: true, duplicate: false, event };
        })
        .immediate();
    } catch (e) {
      if (e instanceof AgentMindError) throw e;
      throw new AgentMindError(
        'USAGE_STORAGE_FAILED',
        'Telemetry was not stored. Retry the identical event ID after resolving local storage contention.',
      );
    } finally {
      this.db.pragma(`busy_timeout=${busyTimeout}`);
    }
  }
  collectInstallations(input: unknown = {}) {
    const p = parse(
      z.strictObject({
        limit: z.number().int().min(1).max(100).default(100),
        after: z.string().max(64).default(''),
      }),
      input,
    );
    if (!this.enabled) return { stored: 0, disabled: true };
    const rows = this.db
      .prepare(`SELECT e.*,i.id AS installation_id FROM skill_distribution_events e
      JOIN skill_installations i ON i.destination=e.destination AND i.project_id=e.project_id
      JOIN skill_distribution_intents j ON j.id=e.intent_id AND j.project_id=e.project_id AND j.skill_id=e.skill_id
      WHERE e.project_id=? AND e.id>? AND e.version_id IS NOT NULL AND e.installed_digest IS NOT NULL
      AND j.status='completed' AND j.manifest_json IS NOT NULL
      AND json_extract(j.manifest_json,'$.version_id')=e.version_id
      AND json_extract(j.manifest_json,'$.installed_digest')=e.installed_digest
      AND e.action IN ('INSTALL','UPDATE','REPAIR') AND e.outcome IN ('COMPLETED','RECOVERED_INSTALL','RECOVERED_PUBLISHED')
      ORDER BY e.id LIMIT ?`)
      .all(this.#scope.id, p.after, p.limit + 1) as Array<Record<string, string>>;
    const events = rows.slice(0, p.limit).map((row) =>
      this.#append(
        {
          event_id: usageObservationId(`install:${row.id}`),
          schema_version: 1,
          timestamp: row.created_at,
          version_id: row.version_id ?? '',
          artifact_digest: row.installed_digest ?? '',
          event_type: 'installed',
          installation_id: row.installation_id,
          evidence_reference: `distribution-event:${row.id}`,
        },
        row.target === 'codex' ? 'codex' : 'claude',
        {
          category: 'registry_install',
          method: 'distribution-audit-v1',
          verification: 'observed',
          details: {
            installation_id: row.installation_id,
            audit_id: row.id,
            historical: true,
            current_files_not_verified: true,
          },
        },
      ),
    );
    return {
      events,
      next_after: rows.length > p.limit ? rows[p.limit - 1]?.id : null,
      warning: WARNING,
    };
  }
  prepareOutcome(input: unknown) {
    const p = parse(usageOutcomeSchema, input);
    if (!p.report.event_type.startsWith('task_') || !p.report.task_id)
      throw new AgentMindError(
        'INVALID_USAGE_INPUT',
        'An outcome requires task correlation and a task event type.',
      );
    if (p.report.event_type === 'task_succeeded' && p.coverage !== 'complete')
      throw new AgentMindError(
        'USAGE_COVERAGE_REQUIRED',
        'Overall success requires explicit complete acceptance coverage.',
      );
    const r = this.reference(p.report.version_id, p.report.artifact_digest);
    const sanitized = {
      report: {
        ...p.report,
        note: clean(p.report.note),
        evidence_reference: clean(p.report.evidence_reference),
        session_id: clean(p.report.session_id),
        task_id: clean(p.report.task_id),
      },
      acceptance_criteria: p.acceptance_criteria.map((c) => clean(c) ?? ''),
      coverage: p.coverage,
    };
    return {
      action: 'confirm-usage-outcome',
      project_id: this.#scope.id,
      source_cli: this.source,
      input: sanitized,
      artifact: {
        version_id: r.version.id,
        skill_id: r.version.skill_id,
        digest: r.version.content_hash,
      },
      warning: WARNING,
    };
  }
  confirmOutcome(input: unknown, grant: unknown) {
    return this.db
      .transaction(() => {
        const preview = this.prepareOutcome(input);
        const auth = consumeOperatorGrant(grant, reviewDigest(preview));
        return this.#append(
          preview.input.report,
          this.source,
          {
            category: 'operator_confirmed',
            method: 'local-tty-outcome-v1',
            verification: 'operator_confirmed',
            details: {
              acceptance_criteria: preview.input.acceptance_criteria,
              coverage: preview.input.coverage,
              same_uid_boundary: false,
            },
          },
          { operator: auth.operator, session: auth.session, context_digest: auth.digest },
        );
      })
      .immediate();
  }
  /** Fixed in-process check: no commands, scripts, referenced files or network execution. */
  runCheck(input: unknown) {
    const p = parse(usageReportSchema, input);
    if (p.event_type !== 'executed')
      throw new AgentMindError(
        'INVALID_USAGE_INPUT',
        'The fixed check records only an executed check, never task success.',
      );
    if (!this.enabled) return { stored: false, disabled: true };
    const r = this.reference(p.version_id, p.artifact_digest);
    const identity = new SkillStore(this.db, this.#scope).getIdentity(r.version.skill_id);
    const result = validateSkillBundle({
      name: identity.name,
      description: r.version.description,
      files: r.version.files,
    });
    return this.#append(p, this.source, {
      category: 'test_runner',
      method: 'markdown-contract-check-v1',
      verification: 'verified_check',
      details: {
        check_result: result.validation_result,
        policy_version: result.policy_version,
        coverage: 'approved Markdown package static contract only',
        task_success_verified: false,
      },
    });
  }
  query(input: unknown = {}) {
    const p = parse(usageQuerySchema, input);
    return this.read(p, p.limit, p.offset);
  }
  private read(p: z.infer<typeof usageSummarySchema>, limit: number, offset: number) {
    if (p.skill_id) new SkillStore(this.db, this.#scope).getIdentity(p.skill_id);
    if (p.version_id) new SkillStore(this.db, this.#scope).getVersion(p.version_id);
    const filters = ['project_id=?'];
    const args: Array<string | number> = [this.#scope.id];
    for (const key of ['skill_id', 'version_id', 'source_cli', 'event_type'] as const)
      if (p[key]) {
        filters.push(`${key}=?`);
        args.push(p[key]);
      }
    for (const [key, op] of [
      ['since', '>='],
      ['until', '<='],
    ] as const)
      if (p[key]) {
        filters.push(`timestamp${op}?`);
        args.push(new Date(p[key]).toISOString());
      }
    const rows = this.db
      .prepare(
        `SELECT * FROM skill_usage_events WHERE ${filters.join(' AND ')} ORDER BY timestamp DESC,event_id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit + 1, offset) as Array<
      Omit<UsageEvent, 'details'> & { details_json: string }
    >;
    return {
      events: rows.slice(0, limit).map(({ details_json, ...e }) => ({
        ...e,
        details: JSON.parse(details_json) as Record<string, unknown>,
      })),
      truncated: rows.length > limit,
      next_offset: rows.length > limit && offset + limit <= 10000 ? offset + limit : null,
      untrusted_data: true,
      warning: WARNING,
    };
  }
  summary(input: unknown = {}) {
    const p = parse(usageSummarySchema, input);
    const page = this.read(p, 10000, 0);
    const groups = new Map<
      string,
      {
        source_cli: string;
        version_id: string;
        events: number;
        observed_invocations: number;
        reported_invocations: number;
        verified_outcomes: number;
        unverified_outcomes: number;
        success: number;
        failure: number;
        unknown: number;
        sessions: Set<string>;
        slash_sessions: Set<string>;
      }
    >();
    for (const e of page.events) {
      const key = `${e.source_cli}:${e.version_id}`;
      const g = groups.get(key) ?? {
        source_cli: e.source_cli,
        version_id: e.version_id,
        events: 0,
        observed_invocations: 0,
        reported_invocations: 0,
        verified_outcomes: 0,
        unverified_outcomes: 0,
        success: 0,
        failure: 0,
        unknown: 0,
        sessions: new Set<string>(),
        slash_sessions: new Set<string>(),
      };
      g.events++;
      if (e.session_id) g.sessions.add(e.session_id);
      if (e.category === 'native_hook' && e.method === 'claude-slash-presence-v1' && e.session_id)
        g.slash_sessions.add(e.session_id);
      if (e.event_type === 'invoked') {
        if (e.category === 'native_hook') g.observed_invocations++;
        else g.reported_invocations++;
      }
      if (e.event_type.startsWith('task_')) {
        if (e.verification === 'operator_confirmed') g.verified_outcomes++;
        else g.unverified_outcomes++;
        if (e.event_type === 'task_succeeded') g.success++;
        else if (e.event_type === 'task_failed') g.failure++;
        else g.unknown++;
      }
      groups.set(key, g);
    }
    return {
      groups: [...groups.values()].slice(0, 100).map(({ sessions, slash_sessions, ...g }) => ({
        ...g,
        unique_sessions: sessions.size,
        direct_slash_sessions: slash_sessions.size,
        potential_regression_signal:
          g.failure > 0
            ? 'reported failures require review; no causal conclusion'
            : 'insufficient evidence',
      })),
      recent: page.events.slice(0, 10),
      sampled_events: page.events.length,
      truncated: page.truncated || groups.size > 100,
      outcome_semantics:
        'Append-only reports, not unique resolved tasks. Multiple outcomes can describe one task; missing reports are not successes.',
      warning: WARNING,
      untrusted_data: true,
    };
  }
  prepareRetention(input: unknown) {
    const p = parse(usageRetentionSchema, input);
    // Day boundary keeps a prepared review stable while preserving received-time retention for delayed events.
    const cutoff = new Date(
      Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`) - p.days * 86400000,
    ).toISOString();
    const rows = this.db
      .prepare(
        'SELECT event_id FROM skill_usage_events WHERE project_id=? AND received_at<? ORDER BY received_at,event_id LIMIT ?',
      )
      .all(this.#scope.id, cutoff, p.batch_size) as Array<{ event_id: string }>;
    return {
      action: 'prune-usage',
      project_id: this.#scope.id,
      policy: p,
      cutoff,
      event_ids: rows.map((r) => r.event_id),
      warning:
        'Explicit deletion of telemetry only. Deduplication tombstones remain to prevent replay resurrection. No automatic cleanup.',
    };
  }
  prune(input: unknown, grant: unknown) {
    return this.db
      .transaction(() => {
        const p = this.prepareRetention(input);
        const auth = consumeOperatorGrant(grant, reviewDigest(p));
        for (const id of p.event_ids)
          this.db
            .prepare('DELETE FROM skill_usage_events WHERE project_id=? AND event_id=?')
            .run(this.#scope.id, id);
        this.db
          .prepare('INSERT INTO skill_usage_cleanup VALUES(?,?,?,?,?,?)')
          .run(
            randomUUID(),
            this.#scope.id,
            p.cutoff,
            p.event_ids.length,
            auth.operator,
            new Date().toISOString(),
          );
        return { deleted: p.event_ids.length, dedup_tombstones_preserved: true };
      })
      .immediate();
  }
}

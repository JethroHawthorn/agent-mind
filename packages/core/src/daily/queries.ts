import type Database from 'better-sqlite3';
import { AgentMindError } from '../errors.js';
import type { ProjectScope } from '../project.js';
import type { DailyRequest } from './model.js';
import { preview } from './projection.js';
/** Scoped bounded projections for explorers absent from earlier command surfaces. No writes/migrations. */
export class DailyQueries {
  constructor(
    readonly db: Database.Database,
    readonly scope: ProjectScope,
  ) {}
  has(table: string) {
    return !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table);
  }
  page(sql: string, args: (string | number)[], p: DailyRequest) {
    if (p.offset > 10000)
      throw new AgentMindError(
        'DAILY_INVALID_INPUT',
        'List offset is capped at 10000; narrow filters.',
      );
    const rows = this.db.prepare(`${sql} LIMIT ? OFFSET ?`).all(...args, p.limit + 1, p.offset);
    const more = rows.length > p.limit;
    return {
      items: rows.slice(0, p.limit),
      offset: p.offset,
      limit: p.limit,
      next_offset: more && p.offset + p.limit <= 10000 ? p.offset + p.limit : null,
      has_more: more,
      exhausted: !more,
      page_status:
        more && p.offset + p.limit > 10000 ? 'OFFSET_LIMIT_REACHED' : more ? 'MORE' : 'EXHAUSTED',
      sorting:
        'Timestamp descending with canonical ID tie-break; concurrent inserts can shift offset pages.',
    };
  }
  records(p: DailyRequest, domain: 'memory' | 'experience') {
    const table = domain === 'memory' ? 'memories' : 'experiences',
      parts = ['m.project_id=?'],
      args: (string | number)[] = [this.scope.id];
    if (p.agent) {
      parts.push('m.source_agent=?');
      args.push(p.agent);
    }
    if (p.since) {
      parts.push('m.created_at>=?');
      args.push(new Date(p.since).toISOString());
    }
    if (p.state) {
      parts.push(domain === 'memory' ? 'm.status=?' : 'm.approval_status=?');
      args.push(p.state);
    }
    let join = '';
    if (p.action === 'search') {
      const words = p.query?.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) ?? [];
      if (!words.length) return { items: [], next_offset: null, exhausted: true };
      const fts = domain === 'memory' ? 'memories_fts' : 'experiences_fts';
      join = `JOIN ${fts} f ON f.rowid=m.rowid`;
      parts.push(`${fts} MATCH ?`);
      args.push(
        words
          .slice(0, 32)
          .map((w) => `"${w}"`)
          .join(' AND '),
      );
    }
    const projection =
      domain === 'memory'
        ? 'm.id,m.project_id,m.kind,m.source_agent,m.status,m.created_at,m.title,length(m.title) title_chars'
        : 'm.id,m.project_id,m.source_agent,m.approval_status,m.verification_status,m.created_at,m.updated_at,m.redacted,m.problem,length(m.problem) problem_chars,m.outcome_status';
    const r = this.page(
      `SELECT ${projection} FROM ${table} m ${join} WHERE ${parts.join(' AND ')} ORDER BY m.created_at DESC,m.id DESC`,
      args,
      p,
    );
    return {
      ...r,
      items: r.items.map((value) => {
        const x = value as Record<string, unknown>;
        const key = domain === 'memory' ? 'title' : 'problem';
        return {
          ...x,
          [key]: preview(String(x[key])).text,
          preview_truncated: Number(x[`${key}_chars`]) > 160,
          evidence_classification:
            'STORED_UNVERIFIED; local approval is not independent task verification',
        };
      }),
    };
  }
  signals(p: DailyRequest) {
    if (!this.has('learning_signals')) return { items: [], next_offset: null, exhausted: true };
    const parts = ['s.project_id=?'],
      args: (string | number)[] = [this.scope.id];
    if (p.state) {
      parts.push('s.status=?');
      args.push(p.state);
    } else if (!p.all) parts.push("s.status='open'");
    for (const [input, path] of [
      [p.agent, '$.origin.source_agent'],
      [p.type, '$.type'],
      [p.trust, '$.triage.evidence_trust'],
    ] as const)
      if (input) {
        parts.push('json_extract(s.payload_json,?)=?');
        args.push(path, input);
      }
    if (p.since) {
      parts.push("json_extract(s.payload_json,'$.created_at')>=?");
      args.push(new Date(p.since).toISOString());
    }
    const associated = this.has('authoring_proposals')
      ? "EXISTS(SELECT 1 FROM authoring_proposals p,json_each(p.payload_json,'$.signal_ids') j WHERE p.project_id=s.project_id AND j.value=s.id)"
      : '0';
    if (p.associated !== undefined) parts.push(`${associated}=${p.associated ? 1 : 0}`);
    return this.page(
      `SELECT s.id,s.status,s.revision,json_extract(s.payload_json,'$.title') title,json_extract(s.payload_json,'$.type') type,json_extract(s.payload_json,'$.origin.source_agent') source_agent,json_extract(s.payload_json,'$.triage.action') triage_action,json_extract(s.payload_json,'$.triage.evidence_trust') evidence_trust,json_extract(s.payload_json,'$.created_at') created_at,${associated} proposal_exists FROM learning_signals s WHERE ${parts.join(' AND ')} ORDER BY json_extract(s.payload_json,'$.created_at') DESC,s.id DESC`,
      args,
      p,
    );
  }
  activity(p: DailyRequest) {
    const channels: { table: string; sql: string }[] = [
      {
        table: 'memories',
        sql: "SELECT id,created_at timestamp,source_agent,'memory_recorded' kind,'STORED_UNVERIFIED' evidence_classification,id object_id,NULL version_id,NULL artifact_digest FROM memories WHERE project_id=?",
      },
      {
        table: 'experiences',
        sql: "SELECT id,created_at timestamp,source_agent,'experience_recorded' kind,verification_status evidence_classification,id object_id,NULL version_id,NULL artifact_digest FROM experiences WHERE project_id=?",
      },
      {
        table: 'learning_signals',
        sql: "SELECT id,json_extract(payload_json,'$.created_at') timestamp,json_extract(payload_json,'$.origin.source_agent') source_agent,'learning_signal' kind,json_extract(payload_json,'$.triage.evidence_trust') evidence_classification,id object_id,NULL version_id,NULL artifact_digest FROM learning_signals WHERE project_id=?",
      },
      {
        table: 'authoring_proposals',
        sql: "SELECT id,created_at timestamp,source_agent,'proposal_submitted' kind,'UNTRUSTED_PROPOSAL' evidence_classification,id object_id,candidate_id version_id,NULL artifact_digest FROM authoring_proposals WHERE project_id=?",
      },
      {
        table: 'learning_review_events',
        sql: "SELECT r.id,r.created_at timestamp,p.source_agent,'advisory_review' kind,'SUPERVISED_REVIEW_NOT_APPROVAL' evidence_classification,r.proposal_id object_id,p.candidate_id version_id,r.candidate_digest artifact_digest FROM learning_review_events r JOIN authoring_proposals p ON p.id=r.proposal_id AND p.project_id=r.project_id WHERE r.project_id=?",
      },
      {
        table: 'skill_usage_events',
        sql: "SELECT event_id id,timestamp,source_cli source_agent,event_type kind,category||'/'||verification evidence_classification,skill_id object_id,version_id,artifact_digest FROM skill_usage_events WHERE project_id=?",
      },
    ];
    const used = channels.filter((c) => this.has(c.table));
    if (!used.length) return { items: [], next_offset: null, exhausted: true };
    const args: (string | number)[] = used.map(() => this.scope.id);
    const parts = ['1=1'];
    if (p.agent) {
      parts.push('source_agent=?');
      args.push(p.agent);
    }
    if (p.since) {
      parts.push('timestamp>=?');
      args.push(new Date(p.since).toISOString());
    }
    return {
      ...this.page(
        `SELECT * FROM (${used.map((c) => c.sql).join(' UNION ALL ')}) WHERE ${parts.join(' AND ')} ORDER BY timestamp DESC,id DESC,kind`,
        args,
        p,
      ),
      limitations: [
        'Read/lookups/selections without persisted events are not fabricated. No transcript or new observation is stored.',
        'Installed/discovered/retrieved is not applied; a passing check is not automatically overall task success.',
      ],
    };
  }
}

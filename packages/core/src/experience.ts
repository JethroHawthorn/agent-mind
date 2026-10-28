import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { AgentMindError } from './errors.js';
import { fitTopExperience } from './experience-context.js';
import { sanitizeExperienceText } from './experience-privacy.js';
import {
  type Evidence,
  type ExperienceInput,
  experienceRecordSchema,
  experienceReviewSchema,
  experienceSearchSchema,
} from './experience-schemas.js';
import { redactSensitiveValue } from './privacy.js';
import type { ProjectScope } from './project.js';
import type { SourceAgent } from './source-agent.js';
import { agentWrite } from './write-transaction.js';

export type Experience = ExperienceInput & {
  id: string;
  project_id: string;
  source_agent: SourceAgent;
  capture_method: 'explicit';
  approval_status: 'candidate' | 'approved' | 'rejected';
  verification_status: 'unverified';
  created_at: string;
  updated_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  redacted: boolean;
};
type ExperienceRow = Omit<
  Experience,
  'outcome' | 'evidence' | 'provenance' | 'capture_method' | 'redacted'
> & {
  outcome_status: ExperienceInput['outcome']['status'];
  outcome_summary: string;
  evidence_json: string;
  provenance_json: string;
  fingerprint: string;
  redacted: number;
};

export function normalizeExperienceText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
function wordSet(text: string): Set<string> {
  return new Set(normalizeExperienceText(text).split(' ').filter(Boolean));
}
function fingerprint(problem: string, solution: string): string {
  return createHash('sha256')
    .update(`${normalizeExperienceText(problem)}\0${normalizeExperienceText(solution)}`)
    .digest('hex');
}
function decode(row: ExperienceRow): Experience {
  return {
    id: row.id,
    project_id: row.project_id,
    source_agent: row.source_agent,
    capture_method: 'explicit',
    problem: row.problem,
    solution: row.solution,
    outcome: { status: row.outcome_status, summary: row.outcome_summary },
    evidence: JSON.parse(row.evidence_json) as Evidence[],
    provenance: JSON.parse(row.provenance_json) as ExperienceInput['provenance'],
    approval_status: row.approval_status,
    verification_status: row.verification_status,
    redacted: Boolean(row.redacted),
    created_at: row.created_at,
    updated_at: row.updated_at,
    reviewed_by: row.reviewed_by,
    reviewed_at: row.reviewed_at,
  };
}
function preview(experience: Experience) {
  const original = experience;
  experience = redactSensitiveValue(experience) as Experience;
  const viewRedacted = JSON.stringify(original) !== JSON.stringify(experience);

  const clip = (value: string, max: number) =>
    value.length > max ? `${value.slice(0, max - 1)}…` : value;
  return {
    id: experience.id,
    project_id: experience.project_id,
    source_agent: experience.source_agent,
    capture_method: experience.capture_method,
    problem: clip(experience.problem, 240),
    solution: clip(experience.solution, 480),
    outcome: { status: experience.outcome.status, summary: clip(experience.outcome.summary, 160) },
    evidence: experience.evidence.slice(0, 2).map((item) => ({
      kind: item.kind,
      reference: clip(item.reference, 256),
      summary: clip(item.summary, 120),
    })),
    provenance: experience.provenance,
    approval_status: experience.approval_status,
    verification_status: experience.verification_status,
    created_at: experience.created_at,
    updated_at: experience.updated_at,
    redacted: experience.redacted || viewRedacted,
    content_truncated:
      experience.problem.length > 240 ||
      experience.solution.length > 480 ||
      experience.outcome.summary.length > 160 ||
      experience.evidence.length > 2 ||
      experience.evidence.some((item) => item.reference.length > 256 || item.summary.length > 120),
  };
}
export type ExperienceContext = ReturnType<typeof preview>;
type Duplicate = { experience: ExperienceContext; match: 'exact' | 'similar'; score: number };

export class ExperienceService {
  readonly #project: ProjectScope;
  constructor(
    private readonly db: Database.Database,
    project: ProjectScope,
    private readonly sourceAgent: Experience['source_agent'] = 'unknown',
    private readonly captureEnabled = true,
    registerProject = true,
  ) {
    this.#project = Object.freeze({ ...project });
    if (registerProject && !db.readonly)
      db.prepare('INSERT OR IGNORE INTO projects(id, canonical_path) VALUES (?, ?)').run(
        project.id,
        project.root,
      );
  }

  record(input: unknown): {
    experience: Experience;
    possible_duplicates: Duplicate[];
    untrusted_data: true;
  } {
    if (!this.captureEnabled)
      throw new AgentMindError(
        'CAPTURE_DISABLED',
        'Experience capture is disabled by local startup configuration.',
      );
    const parsed = experienceRecordSchema.safeParse(input);
    if (!parsed.success)
      throw new AgentMindError('INVALID_INPUT', 'Invalid experience fields or content size.');
    let redacted = false;
    const clean = (value: string) => {
      const result = sanitizeExperienceText(value);
      redacted ||= result.redacted;
      return result.text;
    };
    const data: ExperienceInput = {
      problem: clean(parsed.data.problem),
      solution: clean(parsed.data.solution),
      outcome: { status: parsed.data.outcome.status, summary: clean(parsed.data.outcome.summary) },
      evidence: parsed.data.evidence.map((item) => ({
        kind: item.kind,
        reference: clean(item.reference),
        summary: clean(item.summary),
      })),
      provenance: {
        ...(parsed.data.provenance.task_ref
          ? { task_ref: clean(parsed.data.provenance.task_ref) }
          : {}),
        ...(parsed.data.provenance.commit
          ? { commit: parsed.data.provenance.commit.toLowerCase() }
          : {}),
      },
    };
    // Replacement markers can be longer than short credential assignments.
    // Enforce the same field/aggregate bounds on what will actually be stored.
    if (!experienceRecordSchema.safeParse(data).success) {
      throw new AgentMindError(
        'INVALID_INPUT',
        'Sanitized experience exceeds the content size limits.',
      );
    }
    if (!normalizeExperienceText(data.problem) || !normalizeExperienceText(data.solution)) {
      throw new AgentMindError(
        'INVALID_INPUT',
        'Problem and solution must contain words or numbers.',
      );
    }
    // Serialize dedup lookup + append so concurrent writers see earlier candidates.
    return agentWrite(this.db, () => {
      const hash = fingerprint(data.problem, data.solution);
      const possible_duplicates = this.duplicates(data, hash);
      const timestamp = new Date().toISOString();
      const experience: Experience = {
        ...data,
        id: randomUUID(),
        project_id: this.#project.id,
        source_agent: this.sourceAgent,
        capture_method: 'explicit',
        approval_status: 'candidate',
        verification_status: 'unverified',
        created_at: timestamp,
        updated_at: timestamp,
        reviewed_by: null,
        reviewed_at: null,
        redacted,
      };
      this.db
        .prepare(`INSERT INTO experiences (
        id, project_id, source_agent, problem, solution, outcome_status, outcome_summary,
        evidence_json, provenance_json, fingerprint, redacted, created_at, updated_at
      ) VALUES (@id, @project_id, @source_agent, @problem, @solution, @outcome_status, @outcome_summary,
        @evidence_json, @provenance_json, @fingerprint, @redacted, @created_at, @updated_at)`)
        .run({
          id: experience.id,
          project_id: experience.project_id,
          source_agent: experience.source_agent,
          problem: data.problem,
          solution: data.solution,
          outcome_status: data.outcome.status,
          outcome_summary: data.outcome.summary,
          evidence_json: JSON.stringify(data.evidence),
          provenance_json: JSON.stringify(data.provenance),
          fingerprint: hash,
          redacted: Number(redacted),
          created_at: timestamp,
          updated_at: timestamp,
        });
      return { experience, possible_duplicates, untrusted_data: true as const };
    });
  }

  private duplicates(data: ExperienceInput, hash: string): Duplicate[] {
    const exact = this.db
      .prepare(`SELECT * FROM experiences
      WHERE project_id = ? AND fingerprint = ? AND approval_status != 'rejected'
      ORDER BY created_at DESC, id LIMIT 5`)
      .all(this.#project.id, hash) as ExperienceRow[];
    const results: Duplicate[] = exact.map((row) => ({
      experience: preview(decode(row)),
      match: 'exact',
      score: 1,
    }));
    if (results.length >= 5) return results;
    const words = wordSet(`${data.problem} ${data.solution}`);
    const query = [...words]
      .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, 24)
      .map((token) => `"${token}"`)
      .join(' OR ');
    if (!query) return results;
    const candidates = this.db
      .prepare(`SELECT e.* FROM experiences_fts
      JOIN experiences e ON e.rowid = experiences_fts.rowid
      WHERE experiences_fts MATCH ? AND e.project_id = ? AND e.approval_status != 'rejected'
      ORDER BY bm25(experiences_fts, 1, 1, 1, 0), e.id LIMIT 32`)
      .all(this.scopedQuery(query), this.#project.id) as ExperienceRow[];
    const similar: Duplicate[] = [];
    for (const row of candidates) {
      if (exact.some((item) => item.id === row.id)) continue;
      const other = wordSet(`${row.problem} ${row.solution}`);
      const intersection = [...words].filter((word) => other.has(word)).length;
      const score = intersection / new Set([...words, ...other]).size;
      if (score >= 0.6)
        similar.push({
          experience: preview(decode(row)),
          match: 'similar',
          score: Math.round(score * 1000) / 1000,
        });
    }
    similar.sort((a, b) => b.score - a.score || a.experience.id.localeCompare(b.experience.id));
    return [...results, ...similar].slice(0, 5);
  }

  search(input: unknown): {
    experiences: ExperienceContext[];
    truncated: boolean;
    untrusted_data: true;
  } {
    const parsed = experienceSearchSchema.safeParse(input);
    if (!parsed.success)
      throw new AgentMindError('INVALID_INPUT', 'Invalid experience search fields or limits.');
    const { query, status, limit, max_chars } = parsed.data;
    const words = [...wordSet(query)];
    const result: { experiences: ExperienceContext[]; truncated: boolean; untrusted_data: true } = {
      experiences: [],
      truncated: false,
      untrusted_data: true,
    };
    if (!words.length) return result;
    const rows = this.db
      .prepare(`SELECT e.* FROM experiences_fts
      JOIN experiences e ON e.rowid = experiences_fts.rowid
      WHERE experiences_fts MATCH ? AND e.project_id = ? AND e.approval_status != 'rejected'
      AND (? = 'visible' OR e.approval_status = ?)
      ORDER BY bm25(experiences_fts, 1, 1, 1, 0), e.created_at DESC, e.id LIMIT ?`)
      .all(
        this.scopedQuery(words.map((word) => `"${word}"`).join(' AND ')),
        this.#project.id,
        status,
        status,
        limit + 1,
      ) as ExperienceRow[];
    result.truncated = rows.length > limit;
    for (const row of rows.slice(0, limit)) {
      result.experiences.push(preview(decode(row)));
      if (JSON.stringify(result).length > max_chars) {
        result.truncated = true;
        if (result.experiences.length === 1) {
          result.experiences[0] = fitTopExperience(
            preview(decode(row)),
            (item) => JSON.stringify({ ...result, experiences: [item] }).length <= max_chars,
          );
        } else result.experiences.pop();
        break;
      }
    }
    return result;
  }

  private scopedQuery(contentQuery: string): string {
    // Column filters prevent user keywords from matching the project-index field.
    // The scope is runtime-derived and the SQL project guard remains independent.
    const project = this.#project.id.replaceAll('"', '""');
    return `project_id : "${project}" AND {problem solution outcome_summary} : (${contentQuery})`;
  }

  /** Trusted local inspection/review only; neither method is an MCP capability. */
  inspect(id: string): Experience {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new AgentMindError('INVALID_INPUT', 'Invalid experience ID.');
    const row = this.db
      .prepare('SELECT * FROM experiences WHERE id = ? AND project_id = ?')
      .get(id, this.#project.id) as ExperienceRow | undefined;
    if (!row)
      throw new AgentMindError(
        'EXPERIENCE_NOT_FOUND',
        'Experience is not available in this project.',
      );
    return decode(row);
  }

  review(input: unknown): Experience {
    const parsed = experienceReviewSchema.safeParse(input);
    if (!parsed.success)
      throw new AgentMindError(
        'INVALID_INPUT',
        'Review requires an ID, decision, expected timestamp, reviewer and reason.',
      );
    const reviewer = sanitizeExperienceText(parsed.data.reviewer).text;
    const reason = sanitizeExperienceText(parsed.data.reason).text;
    return this.db
      .transaction(() => {
        const current = this.inspect(parsed.data.id);
        if (current.updated_at !== parsed.data.expected_updated_at) {
          throw new AgentMindError(
            'STALE_REVIEW',
            'Experience changed; inspect it again before reviewing.',
          );
        }
        const timestamp = new Date(
          Math.max(Date.now(), Date.parse(current.updated_at) + 1),
        ).toISOString();
        this.db
          .prepare(`UPDATE experiences SET approval_status = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
        WHERE id = ? AND project_id = ?`)
          .run(parsed.data.decision, reviewer, timestamp, timestamp, current.id, this.#project.id);
        this.db
          .prepare(`INSERT INTO experience_reviews (id, experience_id, previous_status, decision, reviewer, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(
            randomUUID(),
            current.id,
            current.approval_status,
            parsed.data.decision,
            reviewer,
            reason,
            timestamp,
          );
        return this.inspect(current.id);
      })
      .immediate();
  }
}

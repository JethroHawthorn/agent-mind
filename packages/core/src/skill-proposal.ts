import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { AgentMindError } from './errors.js';
import type { ProjectScope } from './project.js';
import { hashSkillFiles } from './skill-model.js';
import { skillProposeSchema } from './skill-requests.js';
import { SkillStore } from './skill-store.js';
import { assertValidSkillBundle } from './skill-validation.js';
import { nextTimestamp } from './timestamp.js';

/** Deterministic append-only authoring; no LLM calls, evaluation, approval or publishing. */
export class SkillProposalService {
  readonly #project: ProjectScope;
  constructor(
    private readonly db: Database.Database,
    project: ProjectScope,
    private readonly sourceAgent: 'codex' | 'claude' | 'unknown' = 'unknown',
    private readonly enabled = true,
  ) {
    this.#project = Object.freeze({ ...project });
  }

  propose(input: unknown) {
    if (!this.enabled)
      throw new AgentMindError(
        'SKILL_PROPOSALS_DISABLED',
        'Skill proposals are disabled by local startup configuration.',
      );
    const parsed = skillProposeSchema.safeParse(input);
    if (!parsed.success)
      throw new AgentMindError(
        'INVALID_INPUT',
        'Invalid skill proposal fields, source IDs or snapshot limits.',
      );
    const validation = assertValidSkillBundle({
      name: parsed.data.name,
      description: parsed.data.description,
      files: parsed.data.files,
    });
    const request = parsed.data;
    return this.db
      .transaction(() => {
        const sources = request.source_experience_ids.map((id) => {
          const source = this.db
            .prepare(`SELECT e.id, e.updated_at, r.id AS review_id FROM experiences e
          JOIN experience_reviews r ON r.experience_id = e.id AND r.created_at = e.reviewed_at AND r.decision = 'approved'
          WHERE e.id = ? AND e.project_id = ? AND e.approval_status = 'approved' AND e.updated_at = r.created_at`)
            .get(id, this.#project.id) as
            | { id: string; updated_at: string; review_id: string }
            | undefined;
          if (!source)
            throw new AgentMindError(
              'SOURCE_NOT_APPROVED',
              'Every source must be a currently approved experience in this project.',
            );
          return source;
        });
        let identity = this.db
          .prepare('SELECT id, updated_at FROM skills WHERE name = ? AND project_id = ?')
          .get(request.name, this.#project.id) as { id: string; updated_at: string } | undefined;
        const latest = identity
          ? (this.db
              .prepare(
                'SELECT version, created_at FROM skill_versions WHERE skill_id = ? ORDER BY version DESC LIMIT 1',
              )
              .get(identity.id) as { version: number; created_at: string } | undefined)
          : undefined;
        if ((latest?.version ?? 0) !== request.expected_latest_version) {
          throw new AgentMindError(
            'STALE_SKILL_VERSION',
            'The latest version changed; inspect the skill before proposing another version.',
          );
        }
        const previous = [
          identity?.updated_at,
          latest?.created_at,
          ...sources.map((source) => source.updated_at),
        ]
          .filter((value): value is string => value !== undefined)
          .sort()
          .at(-1);
        const createdAt = nextTimestamp(previous);
        if (!identity) {
          identity = { id: randomUUID(), updated_at: createdAt };
          this.db
            .prepare(`INSERT INTO skills (id, project_id, name, description, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`)
            .run(
              identity.id,
              this.#project.id,
              request.name,
              request.description,
              createdAt,
              createdAt,
            );
        }
        const versionId = randomUUID();
        this.db
          .prepare(`INSERT INTO skill_versions (id, skill_id, project_id, version, description, files_json, content_hash, source_agent, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            versionId,
            identity.id,
            this.#project.id,
            request.expected_latest_version + 1,
            request.description,
            JSON.stringify(request.files),
            hashSkillFiles(request.files),
            this.sourceAgent,
            createdAt,
          );
        for (const source of sources)
          this.db
            .prepare(`INSERT INTO skill_version_sources
        (version_id, skill_id, project_id, experience_id, experience_review_id, experience_updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(
              versionId,
              identity.id,
              this.#project.id,
              source.id,
              source.review_id,
              source.updated_at,
            );
        this.db
          .prepare(
            'INSERT INTO skill_version_states (version_id, skill_id, project_id, updated_at) VALUES (?, ?, ?, ?)',
          )
          .run(versionId, identity.id, this.#project.id, createdAt);
        const store = new SkillStore(this.db, this.#project);
        return {
          identity: store.getIdentity(identity.id),
          ...store.getVersion(versionId),
          evaluation_result: 'NOT_VERIFIED' as const,
          validation,
        };
      })
      .immediate();
  }
}

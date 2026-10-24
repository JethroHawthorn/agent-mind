import type Database from 'better-sqlite3';
import { z } from 'zod';
import { AgentMindError } from './errors.js';
import type { ProjectScope } from './project.js';
import {
  skillIdentitySchema,
  skillNameSchema,
  skillVersionSchema,
  skillVersionSourceSchema,
  skillVersionStateSchema,
} from './skill-model.js';
import {
  skillGetSchema,
  skillListSchema,
  skillSearchSchema,
  skillValidateSchema,
} from './skill-requests.js';

import { validateSkillBundle } from './skill-validation.js';

/** Scoped read model. Request handlers must never pass a model-selected project ID. */
export class SkillStore {
  readonly #project: ProjectScope;
  constructor(
    private readonly db: Database.Database,
    project: ProjectScope,
  ) {
    this.#project = Object.freeze({ ...project });
  }

  getIdentity(input: unknown) {
    const id = this.id(input);
    const row = this.db
      .prepare('SELECT * FROM skills WHERE id = ? AND project_id = ?')
      .get(id, this.#project.id);
    if (!row) throw this.notFound();
    return skillIdentitySchema.parse(row);
  }

  getVersion(input: unknown) {
    const id = this.id(input);
    const row = this.db
      .prepare('SELECT * FROM skill_versions WHERE id = ? AND project_id = ?')
      .get(id, this.#project.id) as { files_json: string } | undefined;
    if (!row) throw this.notFound();
    const { files_json, ...fields } = row;
    const state = this.db
      .prepare('SELECT * FROM skill_version_states WHERE version_id = ? AND project_id = ?')
      .get(id, this.#project.id);
    const sources = this.db
      .prepare(
        'SELECT * FROM skill_version_sources WHERE version_id = ? AND project_id = ? ORDER BY experience_id',
      )
      .all(id, this.#project.id);
    return {
      version: skillVersionSchema.parse({ ...fields, files: JSON.parse(files_json) }),
      state: skillVersionStateSchema.parse(state),
      sources: sources.map((source) => skillVersionSourceSchema.parse(source)),
      untrusted_data: true as const,
    };
  }

  get(input: unknown) {
    const parsed = skillGetSchema.safeParse(input);
    if (!parsed.success)
      throw new AgentMindError(
        'INVALID_INPUT',
        'Use a version UUID, or a skill name with an optional version number.',
      );
    const request = parsed.data;
    if ('version_id' in request) {
      const snapshot = this.getVersion(request.version_id);
      return { identity: this.getIdentity(snapshot.version.skill_id), ...snapshot };
    }
    if (request.version === undefined) {
      const active = this.getActiveByName(request.name);
      if (!active) throw this.notFound();
      return active;
    }
    const row = this.db
      .prepare(`SELECT v.id FROM skill_versions v JOIN skills k ON k.id = v.skill_id
      WHERE k.name = ? AND k.project_id = ? AND v.project_id = ? AND v.version = ?`)
      .get(request.name, this.#project.id, this.#project.id, request.version) as
      | { id: string }
      | undefined;
    if (!row) throw this.notFound();
    const snapshot = this.getVersion(row.id);
    return { identity: this.getIdentity(snapshot.version.skill_id), ...snapshot };
  }

  validate(input: unknown) {
    const parsed = skillValidateSchema.safeParse(input);
    if (!parsed.success) throw new AgentMindError('INVALID_INPUT', 'Expected a version UUID.');
    return this.db.transaction(() => {
      const snapshot = this.get({ version_id: parsed.data.version_id });
      return {
        version_id: snapshot.version.id,
        ...validateSkillBundle({
          name: snapshot.identity.name,
          description: snapshot.version.description,
          files: snapshot.version.files,
        }),
      };
    })();
  }

  getActiveByName(input: unknown) {
    const parsed = skillNameSchema.safeParse(input);
    if (!parsed.success) throw new AgentMindError('INVALID_INPUT', 'Expected a valid skill name.');
    return this.db.transaction(() => {
      const row = this.db
        .prepare(`SELECT k.id, k.active_version_id FROM skills k
        JOIN skill_version_states s ON s.version_id = k.active_version_id
        WHERE k.name = ? AND k.project_id = ? AND s.project_id = ? AND s.status = 'approved'`)
        .get(parsed.data, this.#project.id, this.#project.id) as
        | { id: string; active_version_id: string }
        | undefined;
      return row
        ? { identity: this.getIdentity(row.id), ...this.getVersion(row.active_version_id) }
        : null;
    })();
  }

  list(input: unknown = {}) {
    const parsed = skillListSchema.safeParse(input);
    if (!parsed.success)
      throw new AgentMindError('INVALID_INPUT', 'Invalid skill discovery filters or limits.');
    return this.page(parsed.data);
  }

  search(query: unknown, options: unknown = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw new AgentMindError('INVALID_INPUT', 'Invalid skill search options.');
    const filters = skillListSchema.safeParse(options);
    if (!filters.success)
      throw new AgentMindError('INVALID_INPUT', 'Invalid skill search options.');
    const parsed = skillSearchSchema.safeParse({ ...filters.data, query });
    if (!parsed.success)
      throw new AgentMindError('INVALID_INPUT', 'Invalid skill search query, filters or limits.');
    const words = [
      ...new Set(
        parsed.data.query
          .normalize('NFKC')
          .toLowerCase()
          .match(/[\p{L}\p{N}_]+/gu) ?? [],
      ),
    ];
    if (!words.length)
      return { skills: [], next_offset: null, truncated: false, untrusted_data: true as const };
    const project = this.#project.id.replaceAll('"', '""');
    const match = `project_id : "${project}" AND {name description} : (${words.map((word) => `"${word}"`).join(' AND ')})`;
    return this.page(parsed.data, match);
  }

  private page(options: { status: string; limit: number; offset: number }, match?: string) {
    // SQL fragments depend only on the chosen method; all request values are bound.
    const join = match === undefined ? '' : 'JOIN skills_fts ON skills_fts.rowid = k.rowid';
    const predicate = match === undefined ? '' : 'AND skills_fts MATCH ?';
    const order = match === undefined ? 'k.name' : 'bm25(skills_fts, 2, 1, 0), k.name';
    const rows = this.db
      .prepare(`SELECT k.*,
      (SELECT COUNT(*) FROM skill_versions WHERE skill_id = k.id) AS version_count,
      (SELECT id FROM skill_versions WHERE skill_id = k.id ORDER BY version DESC LIMIT 1) AS latest_version_id,
      (SELECT MAX(version) FROM skill_versions WHERE skill_id = k.id) AS latest_version,
      (SELECT s.status FROM skill_versions v JOIN skill_version_states s ON s.version_id = v.id
        WHERE v.skill_id = k.id ORDER BY v.version DESC LIMIT 1) AS latest_status
      FROM skills k ${join} WHERE k.project_id = ? ${predicate}
      AND ((? = 'active' AND k.active_version_id IS NOT NULL) OR EXISTS(
        SELECT 1 FROM skill_version_states s WHERE s.skill_id = k.id AND s.project_id = k.project_id
          AND ((? = 'visible' AND s.status != 'rejected') OR s.status = ?)))
      ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(
        this.#project.id,
        ...(match === undefined ? [] : [match]),
        options.status,
        options.status,
        options.status,
        options.limit + 1,
        options.offset,
      ) as Array<Record<string, unknown>>;
    const more = rows.length > options.limit;
    return {
      skills: rows.slice(0, options.limit).map((row) => {
        const { version_count, latest_version_id, latest_version, latest_status, ...identity } =
          row;
        return {
          identity: skillIdentitySchema.parse(identity),
          version_count,
          latest_version_id,
          latest_version,
          latest_status,
        };
      }),
      next_offset:
        more && options.offset + options.limit <= 10000 ? options.offset + options.limit : null,
      truncated: more,
      untrusted_data: true as const,
    };
  }

  private id(input: unknown): string {
    const parsed = z.uuid().safeParse(input);
    if (!parsed.success)
      throw new AgentMindError('INVALID_INPUT', 'Expected a skill or version UUID.');
    return parsed.data;
  }

  private notFound() {
    return new AgentMindError('SKILL_NOT_FOUND', 'Skill record is not available in this project.');
  }
}

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { SCHEMA_VERSION } from './database.js';
import { AgentMindError } from './errors.js';
import { assertSafeSummary } from './privacy.js';
import type { ProjectScope } from './project.js';
import { saveSchema, searchSchema } from './schemas.js';

export type Memory = {
  id: string;
  project_id: string;
  title: string;
  content: string;
  kind: string;
  source_agent: string;
  status: 'unverified';
  created_at: string;
};

export class MemoryService {
  readonly #project: ProjectScope;
  constructor(
    private readonly db: Database.Database,
    project: ProjectScope,
    private readonly sourceAgent: 'codex' | 'claude' | 'unknown' = 'unknown',
  ) {
    this.#project = Object.freeze({ ...project });
    db.prepare('INSERT OR IGNORE INTO projects(id, canonical_path) VALUES (?, ?)').run(
      project.id,
      project.root,
    );
  }

  save(input: unknown): Memory {
    const parsed = saveSchema.safeParse(input);
    if (!parsed.success)
      throw new AgentMindError(
        'INVALID_INPUT',
        'Invalid memory fields; only title, content and kind are accepted.',
      );
    const { title, content, kind } = parsed.data;
    assertSafeSummary(`${title}\n${content}`);
    const memory: Memory = {
      id: randomUUID(),
      project_id: this.#project.id,
      title,
      content,
      kind,
      source_agent: this.sourceAgent,
      status: 'unverified',
      created_at: new Date().toISOString(),
    };
    this.db
      .prepare(`INSERT INTO memories
      (id, project_id, title, content, kind, source_agent, status, created_at)
      VALUES (@id, @project_id, @title, @content, @kind, @source_agent, @status, @created_at)`)
      .run(memory);
    return memory;
  }

  search(input: unknown): Memory[] {
    const parsed = searchSchema.safeParse(input);
    if (!parsed.success)
      throw new AgentMindError(
        'INVALID_INPUT',
        'Invalid search fields; only query and limit are accepted.',
      );
    // Literal AND terms: never interpret model-supplied SQL or FTS operators.
    const tokens = parsed.data.query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (!tokens.length) return [];
    const query = tokens.map((token) => `"${token}"`).join(' AND ');
    return this.db
      .prepare(`SELECT m.* FROM memories_fts
      JOIN memories m ON m.rowid = memories_fts.rowid
      WHERE memories_fts MATCH ? AND m.project_id = ?
      ORDER BY bm25(memories_fts), m.created_at DESC, m.id
      LIMIT ?`)
      .all(query, this.#project.id, parsed.data.limit) as Memory[];
  }

  health(): { ok: true; schema_version: number; project_id: string } {
    const result = this.db.pragma('quick_check', { simple: true });
    if (result !== 'ok')
      throw new AgentMindError('DATABASE_UNHEALTHY', 'SQLite integrity check failed.');
    this.db.prepare('SELECT rowid FROM memories_fts LIMIT 0').all();
    this.db.prepare('SELECT rowid FROM experiences_fts LIMIT 0').all();
    return { ok: true, schema_version: SCHEMA_VERSION, project_id: this.#project.id };
  }
}

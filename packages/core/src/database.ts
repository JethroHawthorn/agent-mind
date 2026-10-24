import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { AgentMindError } from './errors.js';
import { migrateExperiences } from './experience-migration.js';
import { migrateExperienceScopeIndex } from './experience-scope-migration.js';
import { migrateSkills } from './skill-migration.js';
import { migrateSkillOperator } from './skill-operator-migration.js';
import { migrateSkillDiscovery } from './skill-search-migration.js';

export const SCHEMA_VERSION = 7;

export function migrate(db: Database.Database): void {
  if (db.inTransaction)
    throw new AgentMindError(
      'MIGRATION_TRANSACTION',
      'Run migrations outside an existing transaction.',
    );
  const foreignKeys = db.pragma('foreign_keys', { simple: true }) as number;
  // SQLite's documented table-rebuild procedure disables FK enforcement before
  // BEGIN, then checks referential integrity before committing the new schema.
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      const version = db.pragma('user_version', { simple: true }) as number;
      if (version > SCHEMA_VERSION) {
        throw new AgentMindError(
          'SCHEMA_TOO_NEW',
          'Database schema is newer than this AgentMind version.',
        );
      }
      if (version === 0) {
        db.exec(`
        CREATE TABLE projects (id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL UNIQUE);
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id),
          kind TEXT NOT NULL CHECK(kind IN ('fact', 'decision', 'preference')),
          title TEXT NOT NULL,
          content TEXT NOT NULL,
          source_agent TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'unverified' CHECK(status = 'unverified'),
          created_at TEXT NOT NULL
        );
        CREATE INDEX memories_project ON memories(project_id);
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          title, content, content='memories', content_rowid='rowid', tokenize='unicode61'
        );
        CREATE TRIGGER memories_insert AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
        END;
        CREATE TRIGGER memories_delete AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, title, content)
          VALUES ('delete', old.rowid, old.title, old.content);
        END;
        CREATE TRIGGER memories_update AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, title, content)
          VALUES ('delete', old.rowid, old.title, old.content);
          INSERT INTO memories_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
        END;
        PRAGMA user_version = 1;
      `);
      }
      if (version < 2) {
        // IDs and FTS rows stay unchanged; one root can have multiple scopes.
        db.exec(`
        CREATE TABLE projects_v2 (id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL);
        INSERT INTO projects_v2 SELECT id, canonical_path FROM projects;
        DROP TABLE projects;
        ALTER TABLE projects_v2 RENAME TO projects;
        PRAGMA user_version = 2;
      `);
      }
      if (version < 3) migrateExperiences(db);
      if (version < 4) migrateExperienceScopeIndex(db);
      if (version < 5) migrateSkills(db);
      if (version < 6) migrateSkillDiscovery(db);
      if (version < 7) migrateSkillOperator(db);
      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length) {
        throw new AgentMindError(
          'DATABASE_UNHEALTHY',
          'Database contains invalid project references.',
        );
      }
    }).immediate();
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  }
}

function enableWal(db: Database.Database): void {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      db.pragma('journal_mode = WAL');
      return;
    } catch (error) {
      if (!(error as { code?: string }).code?.startsWith('SQLITE_BUSY') || Date.now() >= deadline)
        throw error;
      // Journal-mode changes can return BUSY without invoking SQLite's busy
      // handler when two processes open a new file simultaneously.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

export function openDatabase(path: string): Database.Database {
  let db: Database.Database | undefined;
  try {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    db = new Database(path, { timeout: 5000 });
    if (path !== ':memory:' && process.platform !== 'win32') {
      try {
        chmodSync(path, 0o600);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(code ?? '')) throw error;
        console.error(
          '[agentmind] FILE_PERMISSIONS_UNSUPPORTED: Verify database access using filesystem or OS permissions.',
        );
      }
    }
    db.pragma('foreign_keys = ON');
    enableWal(db);
    db.pragma('synchronous = FULL');
    migrate(db);
    // Also verifies FTS5 on already-migrated databases.
    db.prepare('SELECT rowid FROM memories_fts LIMIT 0').all();
    db.prepare('SELECT rowid FROM experiences_fts LIMIT 0').all();
    db.prepare('SELECT rowid FROM skills_fts LIMIT 0').all();
    db.prepare('SELECT id FROM skill_operator_events LIMIT 0').all();
    return db;
  } catch (error) {
    db?.close();
    if (error instanceof AgentMindError) throw error;
    throw new AgentMindError(
      'DATABASE_UNAVAILABLE',
      'Cannot initialize SQLite with FTS5. Check the database path and driver installation.',
    );
  }
}

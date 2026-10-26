import type Database from 'better-sqlite3';
import { AgentMindError } from '../errors.js';
export function authoringStorageExists(db: Database.Database) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='authoring_schema'").get()) return false;
  const rows = db.prepare('SELECT version FROM authoring_schema').all() as { version: number }[];
  if (rows.length !== 1 || rows[0]?.version !== 1)
    throw new AgentMindError(
      'AUTHORING_SCHEMA_UNSUPPORTED',
      'Unsupported authoring metadata schema.',
    );
  return true;
}
export function migrateAuthoring(db: Database.Database) {
  db.transaction(() => {
    if (authoringStorageExists(db)) return;
    db.exec(`CREATE TABLE authoring_schema(version INTEGER PRIMARY KEY CHECK(version=1));INSERT INTO authoring_schema VALUES(1);
 CREATE TABLE authoring_contexts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),source_digest TEXT NOT NULL,digest TEXT NOT NULL,request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(request_json)<=2048),payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(payload_json)<=16000),created_at TEXT NOT NULL,UNIQUE(id,project_id));
 CREATE TABLE authoring_proposals(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_id TEXT NOT NULL,request_digest TEXT NOT NULL,context_id TEXT NOT NULL,candidate_id TEXT NOT NULL,skill_id TEXT NOT NULL,base_id TEXT,type TEXT NOT NULL CHECK(type IN ('CREATE_NEW','PATCH_EXISTING','REWRITE_EXISTING')),source_agent TEXT NOT NULL,session_digest TEXT NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(payload_json)<=8192),created_at TEXT NOT NULL,UNIQUE(project_id,request_id),UNIQUE(candidate_id),FOREIGN KEY(context_id,project_id) REFERENCES authoring_contexts(id,project_id),FOREIGN KEY(candidate_id,skill_id,project_id) REFERENCES skill_versions(id,skill_id,project_id),FOREIGN KEY(base_id,skill_id,project_id) REFERENCES skill_versions(id,skill_id,project_id));
 CREATE INDEX authoring_pending ON authoring_proposals(project_id,created_at,id);
 CREATE INDEX authoring_session ON authoring_proposals(project_id,session_digest);`);
    for (const table of ['authoring_contexts', 'authoring_proposals'])
      db.exec(
        `CREATE TRIGGER ${table}_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable authoring provenance');END;CREATE TRIGGER ${table}_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'retained authoring provenance');END;CREATE TRIGGER ${table}_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'immutable authoring provenance');END;`,
      );
  }).immediate();
}

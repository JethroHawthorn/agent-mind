import type Database from 'better-sqlite3';
import { AgentMindError } from '../errors.js';
export function curatorStorageExists(db: Database.Database) {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='curator_schema'")
    .get();
  if (!exists) return false;
  const rows = db.prepare('SELECT version FROM curator_schema').all() as Array<{ version: number }>;
  if (rows.length !== 1 || rows[0]?.version !== 1)
    throw new AgentMindError('CURATOR_SCHEMA_UNSUPPORTED', 'Unknown recommendation schema.');
  return true;
}
/** Versioned additive extension. No lifecycle-table DDL or writes. Called only on authorized metadata writes. */
export function migrateCurator(db: Database.Database) {
  db.transaction(() => {
    if (curatorStorageExists(db)) return;
    db.exec(`CREATE TABLE curator_schema(version INTEGER PRIMARY KEY CHECK(version=1));INSERT INTO curator_schema VALUES(1);
 CREATE TABLE curator_recommendations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),skill_id TEXT NOT NULL,version_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL,policy_version TEXT NOT NULL,config_digest TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('open','dismissed','superseded')),
 priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 2),payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(payload_json)<=8192),revision INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL,last_evaluated_at TEXT NOT NULL,UNIQUE(project_id,fingerprint),UNIQUE(id,project_id));
 CREATE INDEX curator_project_state ON curator_recommendations(project_id,state,priority,id);
 CREATE TABLE curator_history(id INTEGER PRIMARY KEY,project_id TEXT NOT NULL,recommendation_id TEXT NOT NULL,revision INTEGER NOT NULL,
 state TEXT NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),created_at TEXT NOT NULL,UNIQUE(recommendation_id,revision),
 FOREIGN KEY(recommendation_id,project_id) REFERENCES curator_recommendations(id,project_id));
 CREATE TABLE curator_runs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),fingerprint TEXT NOT NULL,source_digest TEXT NOT NULL,created_at TEXT NOT NULL,
 summary_json TEXT NOT NULL CHECK(json_valid(summary_json) AND length(summary_json)<=8192),UNIQUE(project_id,fingerprint));`);
    for (const table of ['curator_history', 'curator_runs']) {
      db.exec(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable recommendation history');END;
  CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'immutable recommendation history');END;
  CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'immutable recommendation history');END;`);
    }
  }).immediate();
}

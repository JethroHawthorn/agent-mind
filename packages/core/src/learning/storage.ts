import type Database from 'better-sqlite3';
import { AgentMindError } from '../errors.js';
export function learningStorageExists(db: Database.Database) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='learning_schema'").get()) return false;
  const rows = db.prepare('SELECT version FROM learning_schema').all() as { version: number }[];
  if (rows.length !== 1 || rows[0]?.version !== 1)
    throw new AgentMindError(
      'LEARNING_SCHEMA_UNSUPPORTED',
      'Unsupported learning metadata schema.',
    );
  return true;
}
/** Additive metadata only. Source/lifecycle migrations are untouched. */
export function migrateLearning(db: Database.Database) {
  db.transaction(() => {
    if (learningStorageExists(db)) return;
    db.exec(`CREATE TABLE learning_schema(version INTEGER PRIMARY KEY CHECK(version=1));INSERT INTO learning_schema VALUES(1);
 CREATE TABLE learning_signals(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),fingerprint TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('open','dismissed','superseded')),revision INTEGER NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(payload_json)<=8192),UNIQUE(project_id,fingerprint));
 CREATE INDEX learning_project_status ON learning_signals(project_id,status,id);
 CREATE TABLE learning_history(id INTEGER PRIMARY KEY,signal_id TEXT NOT NULL REFERENCES learning_signals(id),project_id TEXT NOT NULL REFERENCES projects(id),revision INTEGER NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(payload_json)<=8192),UNIQUE(signal_id,revision));
 CREATE TABLE learning_cursors(project_id TEXT NOT NULL REFERENCES projects(id),source TEXT NOT NULL,last_row INTEGER NOT NULL CHECK(last_row>=0),PRIMARY KEY(project_id,source));
 CREATE TRIGGER learning_no_delete BEFORE DELETE ON learning_signals BEGIN SELECT RAISE(ABORT,'retained learning history');END;
 CREATE TRIGGER learning_no_replace BEFORE INSERT ON learning_signals WHEN EXISTS(SELECT 1 FROM learning_signals WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'retained learning history');END;
 CREATE TRIGGER learning_history_scope BEFORE INSERT ON learning_history WHEN NOT EXISTS(SELECT 1 FROM learning_signals WHERE id=NEW.signal_id AND project_id=NEW.project_id) BEGIN SELECT RAISE(ABORT,'learning scope mismatch');END;
 CREATE TRIGGER learning_history_update BEFORE UPDATE ON learning_history BEGIN SELECT RAISE(ABORT,'immutable learning history');END;
 CREATE TRIGGER learning_history_delete BEFORE DELETE ON learning_history BEGIN SELECT RAISE(ABORT,'immutable learning history');END;
 CREATE TRIGGER learning_history_replace BEFORE INSERT ON learning_history WHEN EXISTS(SELECT 1 FROM learning_history WHERE id=NEW.id OR (signal_id=NEW.signal_id AND revision=NEW.revision)) BEGIN SELECT RAISE(ABORT,'immutable learning history');END;`);
  }).immediate();
}

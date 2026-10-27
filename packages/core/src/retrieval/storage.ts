import type Database from 'better-sqlite3';
import { AgentMindError } from '../errors.js';
import { migrateHybridDiscovery } from './hybrid-storage.js';
export function retrievalStorageExists(db: Database.Database) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='retrieval_schema'").get()) return false;
  const rows = db.prepare('SELECT version FROM retrieval_schema').all() as { version: number }[];
  if (rows.length !== 1 || rows[0]?.version !== 1)
    throw new AgentMindError(
      'RETRIEVAL_SCHEMA_UNSUPPORTED',
      'Unsupported retrieval metadata index.',
    );
  return true;
}
/** Explicit startup/maintenance migration only; reads never create or repair an index. */
export function migrateRetrieval(db: Database.Database) {
  db.transaction(() => {
    if (retrievalStorageExists(db)) return;
    db.exec(`CREATE TABLE retrieval_schema(version INTEGER PRIMARY KEY CHECK(version=1));INSERT INTO retrieval_schema VALUES(1);
 CREATE VIRTUAL TABLE skill_version_retrieval_fts USING fts5(name,description,version_id UNINDEXED,project_id UNINDEXED,tokenize='porter unicode61 remove_diacritics 2');
 INSERT INTO skill_version_retrieval_fts(rowid,name,description,version_id,project_id) SELECT v.rowid,k.name,v.description,v.id,v.project_id FROM skill_versions v JOIN skills k ON k.id=v.skill_id AND k.project_id=v.project_id;
 CREATE TRIGGER skill_version_retrieval_insert AFTER INSERT ON skill_versions BEGIN
 INSERT INTO skill_version_retrieval_fts(rowid,name,description,version_id,project_id) SELECT NEW.rowid,k.name,NEW.description,NEW.id,NEW.project_id FROM skills k WHERE k.id=NEW.skill_id AND k.project_id=NEW.project_id;END;`);
  }).immediate();
  migrateHybridDiscovery(db);
}

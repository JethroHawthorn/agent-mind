import type Database from 'better-sqlite3';
import { AgentMindError } from '../errors.js';

/** SQL-only extraction keeps inserts from all CLI connections compatible; no JS SQLite functions. */
const prefix = (files: string) =>
  `COALESCE((SELECT CASE WHEN instr(substr(json_extract(j.value,'$.content'),5),char(10)||'---') BETWEEN 1 AND 8193 THEN substr(json_extract(j.value,'$.content'),1,instr(substr(json_extract(j.value,'$.content'),5),char(10)||'---')+3) ELSE '' END FROM json_each(${files}) j WHERE json_extract(j.value,'$.path')='SKILL.md' LIMIT 1),'')`;
export function hybridStorageExists(db: Database.Database) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='hybrid_discovery_schema'").get())
    return false;
  const rows = db.prepare('SELECT version FROM hybrid_discovery_schema').all() as {
    version: number;
  }[];
  if (rows.length !== 1 || rows[0]?.version !== 1)
    throw new AgentMindError('RETRIEVAL_SCHEMA_UNSUPPORTED', 'Unsupported hybrid metadata index.');
  return true;
}
export function migrateHybridDiscovery(db: Database.Database) {
  db.transaction(() => {
    if (hybridStorageExists(db)) return;
    db.exec(`CREATE TABLE hybrid_discovery_schema(version INTEGER PRIMARY KEY CHECK(version=1));INSERT INTO hybrid_discovery_schema VALUES(1);
 CREATE VIRTUAL TABLE skill_discovery_fts USING fts5(name,description,metadata,project_id,version_id UNINDEXED,digest UNINDEXED,tokenize='porter unicode61 remove_diacritics 2');
 INSERT INTO skill_discovery_fts(rowid,name,description,metadata,project_id,version_id,digest) SELECT v.rowid,k.name,v.description,${prefix('v.files_json')},v.project_id,v.id,v.content_hash FROM skill_versions v JOIN skills k ON k.id=v.skill_id AND k.project_id=v.project_id;
 CREATE TRIGGER skill_discovery_insert AFTER INSERT ON skill_versions BEGIN
 INSERT INTO skill_discovery_fts(rowid,name,description,metadata,project_id,version_id,digest) SELECT NEW.rowid,k.name,NEW.description,${prefix('NEW.files_json')},NEW.project_id,NEW.id,NEW.content_hash FROM skills k WHERE k.id=NEW.skill_id AND k.project_id=NEW.project_id;END;`);
  }).immediate();
}

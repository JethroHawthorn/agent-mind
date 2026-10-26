import type Database from 'better-sqlite3';
import { AgentMindError } from '../../errors.js';
export function similarityStorageExists(db: Database.Database) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='curator_similarity_schema'").get())
    return false;
  const versions = db.prepare('SELECT version FROM curator_similarity_schema').all() as {
    version: number;
  }[];
  if (versions.length !== 1 || versions[0]?.version !== 1)
    throw new AgentMindError('CURATOR_SCHEMA_UNSUPPORTED', 'Unsupported similarity cache schema.');
  return true;
}
export function migrateSimilarity(db: Database.Database) {
  if (similarityStorageExists(db)) return;
  db.exec(`CREATE TABLE curator_similarity_schema(version INTEGER PRIMARY KEY CHECK(version=1));INSERT INTO curator_similarity_schema VALUES(1);
 CREATE TABLE curator_feature_cache(project_id TEXT NOT NULL REFERENCES projects(id),digest TEXT NOT NULL,policy TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload) AND length(payload)<=8192),checksum TEXT NOT NULL,PRIMARY KEY(project_id,digest,policy));
 CREATE TABLE curator_pair_cache(project_id TEXT NOT NULL REFERENCES projects(id),fingerprint TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload) AND length(payload)<=8192),checksum TEXT NOT NULL,PRIMARY KEY(project_id,fingerprint));`);
}

import type Database from 'better-sqlite3';
import { AgentMindError } from '../errors.js';
export function reviewStorageExists(db: Database.Database) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='learning_review_schema'").get())
    return false;
  const rows = db.prepare('SELECT version FROM learning_review_schema').all() as {
    version: number;
  }[];
  if (rows.length !== 1 || rows[0]?.version !== 1)
    throw new AgentMindError('REVIEW_SCHEMA_UNSUPPORTED', 'Unsupported review metadata schema.');
  return true;
}
export function migrateLearningReview(db: Database.Database) {
  db.transaction(() => {
    if (reviewStorageExists(db)) return;
    db.exec(`CREATE TABLE learning_review_schema(version INTEGER PRIMARY KEY CHECK(version=1));INSERT INTO learning_review_schema VALUES(1);
 CREATE UNIQUE INDEX IF NOT EXISTS authoring_proposal_scope ON authoring_proposals(id,project_id);
 CREATE TABLE learning_review_events(
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL,proposal_id TEXT NOT NULL,request_id TEXT NOT NULL,request_digest TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),candidate_digest TEXT NOT NULL,snapshot_digest TEXT NOT NULL,evidence_digest TEXT NOT NULL,
 decision TEXT NOT NULL CHECK(decision IN ('DEFER','DISMISS','MARK_REVIEWED','RECOMMEND_FOR_APPROVAL','REQUEST_MORE_EVIDENCE','REOPEN')),
 state TEXT NOT NULL CHECK(state IN ('DEFERRED','DISMISSED','REVIEWED','RECOMMENDED','NEEDS_EVIDENCE','PENDING_REVIEW')),
 reason TEXT NOT NULL CHECK(length(reason)<=500),actor_json TEXT NOT NULL CHECK(json_valid(actor_json) AND length(actor_json)<=1024),created_at TEXT NOT NULL,
 UNIQUE(project_id,request_id),UNIQUE(project_id,proposal_id,revision),FOREIGN KEY(proposal_id,project_id) REFERENCES authoring_proposals(id,project_id));
 CREATE INDEX learning_review_latest ON learning_review_events(project_id,proposal_id,revision DESC);
 CREATE INDEX authoring_review_skill ON authoring_proposals(project_id,skill_id,created_at,id);`);
    for (const op of ['UPDATE', 'DELETE'])
      db.exec(
        `CREATE TRIGGER learning_review_no_${op.toLowerCase()} BEFORE ${op} ON learning_review_events BEGIN SELECT RAISE(ABORT,'immutable review history');END;`,
      );
    db.exec(
      `CREATE TRIGGER learning_review_no_replace BEFORE INSERT ON learning_review_events WHEN EXISTS(SELECT 1 FROM learning_review_events WHERE id=NEW.id OR (project_id=NEW.project_id AND request_id=NEW.request_id) OR (project_id=NEW.project_id AND proposal_id=NEW.proposal_id AND revision=NEW.revision)) BEGIN SELECT RAISE(ABORT,'immutable review history');END;`,
    );
  }).immediate();
}

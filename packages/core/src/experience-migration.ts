import type Database from 'better-sqlite3';

export function migrateExperiences(db: Database.Database): void {
  db.exec(`
    CREATE TABLE experiences (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      source_agent TEXT NOT NULL CHECK(source_agent IN ('codex', 'claude', 'unknown')),
      problem TEXT NOT NULL,
      solution TEXT NOT NULL,
      outcome_status TEXT NOT NULL CHECK(outcome_status IN ('succeeded', 'failed', 'partial', 'unknown')),
      outcome_summary TEXT NOT NULL,
      evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
      provenance_json TEXT NOT NULL CHECK(json_valid(provenance_json)),
      fingerprint TEXT NOT NULL,
      redacted INTEGER NOT NULL CHECK(redacted IN (0, 1)),
      approval_status TEXT NOT NULL DEFAULT 'candidate' CHECK(approval_status IN ('candidate', 'approved', 'rejected')),
      verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK(verification_status = 'unverified'),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reviewed_by TEXT,
      reviewed_at TEXT
    );
    CREATE INDEX experiences_scope_status ON experiences(project_id, approval_status);
    CREATE INDEX experiences_fingerprint ON experiences(project_id, fingerprint);
    CREATE VIRTUAL TABLE experiences_fts USING fts5(
      problem, solution, outcome_summary, content='experiences', content_rowid='rowid', tokenize='unicode61'
    );
    CREATE TRIGGER experiences_insert AFTER INSERT ON experiences BEGIN
      INSERT INTO experiences_fts(rowid, problem, solution, outcome_summary)
      VALUES (new.rowid, new.problem, new.solution, new.outcome_summary);
    END;
    CREATE TRIGGER experiences_delete AFTER DELETE ON experiences BEGIN
      INSERT INTO experiences_fts(experiences_fts, rowid, problem, solution, outcome_summary)
      VALUES ('delete', old.rowid, old.problem, old.solution, old.outcome_summary);
    END;
    CREATE TRIGGER experiences_update AFTER UPDATE OF problem, solution, outcome_summary ON experiences BEGIN
      INSERT INTO experiences_fts(experiences_fts, rowid, problem, solution, outcome_summary)
      VALUES ('delete', old.rowid, old.problem, old.solution, old.outcome_summary);
      INSERT INTO experiences_fts(rowid, problem, solution, outcome_summary)
      VALUES (new.rowid, new.problem, new.solution, new.outcome_summary);
    END;
    CREATE TABLE experience_reviews (
      id TEXT PRIMARY KEY,
      experience_id TEXT NOT NULL REFERENCES experiences(id),
      previous_status TEXT NOT NULL CHECK(previous_status IN ('candidate', 'approved', 'rejected')),
      decision TEXT NOT NULL CHECK(decision IN ('approved', 'rejected')),
      reviewer TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX experience_reviews_record ON experience_reviews(experience_id);
    PRAGMA user_version = 3;
  `);
}

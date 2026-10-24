import type Database from 'better-sqlite3';

/** Append-only confirmation provenance for the local workflow, not OS authentication. */
export function migrateSkillOperator(db: Database.Database) {
  db.exec(`
    CREATE TABLE skill_operator_events (
      id TEXT PRIMARY KEY NOT NULL,
      skill_id TEXT NOT NULL, project_id TEXT NOT NULL, version_id TEXT NOT NULL,
      content_hash TEXT NOT NULL CHECK(length(content_hash) = 64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
      evaluation_id TEXT, evaluator_version TEXT,
      action TEXT NOT NULL CHECK(action IN ('approve','reject','promote','rollback','deactivate')),
      review_id TEXT UNIQUE, promotion_id TEXT UNIQUE,
      operator_id TEXT NOT NULL CHECK(length(operator_id) BETWEEN 1 AND 100),
      session_id TEXT NOT NULL UNIQUE,
      authorization_method TEXT NOT NULL CHECK(authorization_method = 'local-tty-confirmation-v1'),
      context_digest TEXT NOT NULL CHECK(length(context_digest) = 64 AND context_digest NOT GLOB '*[^a-f0-9]*'),
      reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
      created_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json) AND length(metadata_json) <= 2000),
      CHECK((action IN ('approve','reject') AND review_id IS NOT NULL AND promotion_id IS NULL)
        OR (action IN ('promote','rollback','deactivate') AND promotion_id IS NOT NULL AND review_id IS NULL)),
      CHECK(action IN ('reject','deactivate') OR evaluation_id IS NOT NULL),
      FOREIGN KEY(version_id,skill_id,project_id) REFERENCES skill_versions(id,skill_id,project_id),
      FOREIGN KEY(evaluation_id,version_id,skill_id,project_id) REFERENCES skill_evaluations(id,version_id,skill_id,project_id),
      FOREIGN KEY(review_id,version_id,skill_id,project_id) REFERENCES skill_reviews(id,version_id,skill_id,project_id),
      FOREIGN KEY(promotion_id,skill_id,project_id) REFERENCES skill_promotions(id,skill_id,project_id)
    );
    CREATE INDEX skill_operator_scope ON skill_operator_events(project_id,version_id,created_at);
    CREATE TRIGGER skill_operator_valid BEFORE INSERT ON skill_operator_events BEGIN
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM skill_versions v WHERE v.id=NEW.version_id AND v.skill_id=NEW.skill_id
        AND v.project_id=NEW.project_id AND v.content_hash=NEW.content_hash)
        OR (NEW.evaluation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM skill_evaluations e
          WHERE e.id=NEW.evaluation_id AND e.evaluator_version=NEW.evaluator_version AND e.content_hash=NEW.content_hash))
        OR (NEW.review_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM skill_reviews r WHERE r.id=NEW.review_id
          AND r.reviewer=NEW.operator_id AND r.reason=NEW.reason AND r.created_at=NEW.created_at
          AND r.evaluation_id IS NEW.evaluation_id AND r.decision=CASE NEW.action WHEN 'approve' THEN 'approved' ELSE 'rejected' END))
        OR (NEW.promotion_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM skill_promotions p WHERE p.id=NEW.promotion_id
          AND p.actor=NEW.operator_id AND p.reason=NEW.reason AND p.created_at=NEW.created_at AND p.action=NEW.action
          AND CASE NEW.action WHEN 'deactivate' THEN p.from_version_id ELSE p.to_version_id END=NEW.version_id))
        THEN RAISE(ABORT,'invalid operator audit binding') END;
    END;
    CREATE TRIGGER skill_operator_no_update BEFORE UPDATE ON skill_operator_events
      BEGIN SELECT RAISE(ABORT,'immutable operator audit'); END;
    CREATE TRIGGER skill_operator_no_delete BEFORE DELETE ON skill_operator_events
      BEGIN SELECT RAISE(ABORT,'immutable operator audit'); END;
    CREATE TRIGGER skill_operator_no_replace BEFORE INSERT ON skill_operator_events
      WHEN EXISTS(SELECT 1 FROM skill_operator_events WHERE id=NEW.id)
      BEGIN SELECT RAISE(ABORT,'immutable operator audit'); END;
    PRAGMA user_version = 7;
  `);
}

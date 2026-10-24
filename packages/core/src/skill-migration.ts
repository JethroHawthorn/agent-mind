import type Database from 'better-sqlite3';

/** P2-001 persistence invariants only; no authoring, evaluator or operator workflow. */
export function migrateSkills(db: Database.Database): void {
  db.exec(`
    CREATE UNIQUE INDEX skill_experience_scope ON experiences(id, project_id);
    CREATE UNIQUE INDEX skill_experience_review_parent ON experience_reviews(id, experience_id);
    CREATE TABLE skills (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id),
      name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 64 AND name NOT GLOB '*[^a-z0-9-]*'
        AND name NOT LIKE '-%' AND name NOT LIKE '%-' AND instr(name, '--') = 0),
      description TEXT NOT NULL CHECK(length(trim(description)) BETWEEN 1 AND 1024),
      active_version_id TEXT,
      last_transition_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(id, project_id), UNIQUE(project_id, name),
      CHECK(active_version_id IS NULL OR last_transition_id IS NOT NULL),
      FOREIGN KEY(active_version_id, id, project_id) REFERENCES skill_versions(id, skill_id, project_id),
      FOREIGN KEY(last_transition_id, id, project_id) REFERENCES skill_promotions(id, skill_id, project_id)
    );
    CREATE TABLE skill_versions (
      id TEXT PRIMARY KEY NOT NULL,
      skill_id TEXT NOT NULL, project_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK(version > 0),
      description TEXT NOT NULL CHECK(length(trim(description)) BETWEEN 1 AND 1024),
      files_json TEXT NOT NULL CHECK(json_valid(files_json) AND json_type(files_json) = 'array' AND length(files_json) <= 262144),
      content_hash TEXT NOT NULL CHECK(length(content_hash) = 64 AND content_hash NOT GLOB '*[^a-f0-9]*'),
      source_agent TEXT NOT NULL CHECK(source_agent IN ('codex', 'claude', 'unknown')),
      created_at TEXT NOT NULL,
      UNIQUE(id, skill_id, project_id), UNIQUE(skill_id, version),
      FOREIGN KEY(skill_id, project_id) REFERENCES skills(id, project_id),
      FOREIGN KEY(id) REFERENCES skill_version_states(version_id) DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TABLE skill_version_sources (
      version_id TEXT NOT NULL, skill_id TEXT NOT NULL, project_id TEXT NOT NULL,
      experience_id TEXT NOT NULL, experience_review_id TEXT NOT NULL, experience_updated_at TEXT NOT NULL,
      PRIMARY KEY(version_id, experience_id),
      FOREIGN KEY(version_id, skill_id, project_id) REFERENCES skill_versions(id, skill_id, project_id),
      FOREIGN KEY(experience_id, project_id) REFERENCES experiences(id, project_id),
      FOREIGN KEY(experience_review_id, experience_id) REFERENCES experience_reviews(id, experience_id)
    );
    CREATE TABLE skill_version_states (
      version_id TEXT PRIMARY KEY NOT NULL, skill_id TEXT NOT NULL, project_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate', 'approved', 'rejected')),
      latest_evaluation_id TEXT, review_id TEXT,
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0), updated_at TEXT NOT NULL,
      FOREIGN KEY(version_id, skill_id, project_id) REFERENCES skill_versions(id, skill_id, project_id),
      FOREIGN KEY(latest_evaluation_id, version_id, skill_id, project_id) REFERENCES skill_evaluations(id, version_id, skill_id, project_id),
      FOREIGN KEY(review_id, version_id, skill_id, project_id) REFERENCES skill_reviews(id, version_id, skill_id, project_id)
    );
    CREATE TABLE skill_evaluations (
      id TEXT PRIMARY KEY NOT NULL, version_id TEXT NOT NULL, skill_id TEXT NOT NULL, project_id TEXT NOT NULL,
      evaluator TEXT NOT NULL CHECK(length(trim(evaluator)) BETWEEN 1 AND 100),
      evaluator_version TEXT NOT NULL CHECK(length(evaluator_version) BETWEEN 1 AND 100),
      result TEXT NOT NULL CHECK(result IN ('PASS', 'FAIL', 'NOT_VERIFIED')),
      checks_json TEXT NOT NULL CHECK(json_valid(checks_json) AND json_type(checks_json) = 'array'
        AND json_array_length(checks_json) BETWEEN 1 AND 64 AND length(checks_json) <= 150000),
      baseline_version_id TEXT, regression_result TEXT NOT NULL CHECK(regression_result IN ('PASS', 'FAIL', 'NOT_VERIFIED')),
      content_hash TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(id, version_id, skill_id, project_id),
      FOREIGN KEY(version_id, skill_id, project_id) REFERENCES skill_versions(id, skill_id, project_id),
      FOREIGN KEY(baseline_version_id, skill_id, project_id) REFERENCES skill_versions(id, skill_id, project_id)
    );
    CREATE TABLE skill_reviews (
      id TEXT PRIMARY KEY NOT NULL, version_id TEXT NOT NULL, skill_id TEXT NOT NULL, project_id TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('approved', 'rejected')), evaluation_id TEXT,
      reviewer TEXT NOT NULL CHECK(length(trim(reviewer)) BETWEEN 1 AND 100),
      reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000), created_at TEXT NOT NULL,
      UNIQUE(id, version_id, skill_id, project_id),
      FOREIGN KEY(version_id, skill_id, project_id) REFERENCES skill_versions(id, skill_id, project_id),
      FOREIGN KEY(evaluation_id, version_id, skill_id, project_id) REFERENCES skill_evaluations(id, version_id, skill_id, project_id)
    );
    CREATE TABLE skill_promotions (
      id TEXT PRIMARY KEY NOT NULL, skill_id TEXT NOT NULL, project_id TEXT NOT NULL,
      from_version_id TEXT, to_version_id TEXT, approval_id TEXT,
      action TEXT NOT NULL CHECK(action IN ('promote', 'rollback', 'deactivate')),
      expected_revision INTEGER NOT NULL CHECK(expected_revision >= 0),
      actor TEXT NOT NULL CHECK(length(trim(actor)) BETWEEN 1 AND 100),
      reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 2000), created_at TEXT NOT NULL,
      UNIQUE(id, skill_id, project_id), UNIQUE(skill_id, expected_revision),
      CHECK(from_version_id IS NOT to_version_id),
      CHECK((action = 'deactivate' AND to_version_id IS NULL AND approval_id IS NULL) OR
        (action != 'deactivate' AND to_version_id IS NOT NULL AND approval_id IS NOT NULL)),
      FOREIGN KEY(skill_id, project_id) REFERENCES skills(id, project_id),
      FOREIGN KEY(from_version_id, skill_id, project_id) REFERENCES skill_versions(id, skill_id, project_id),
      FOREIGN KEY(to_version_id, skill_id, project_id) REFERENCES skill_versions(id, skill_id, project_id),
      FOREIGN KEY(approval_id, to_version_id, skill_id, project_id) REFERENCES skill_reviews(id, version_id, skill_id, project_id)
    );

    CREATE TRIGGER skills_initial BEFORE INSERT ON skills BEGIN
      SELECT CASE WHEN NEW.active_version_id IS NOT NULL OR NEW.last_transition_id IS NOT NULL OR NEW.revision != 0
        OR NEW.updated_at != NEW.created_at OR EXISTS(SELECT 1 FROM skills WHERE id = NEW.id OR (project_id = NEW.project_id AND name = NEW.name))
        THEN RAISE(ABORT, 'invalid initial skill state') END;
    END;
    CREATE TRIGGER skill_versions_sequence BEFORE INSERT ON skill_versions BEGIN
      SELECT CASE WHEN EXISTS(SELECT 1 FROM skill_versions WHERE id = NEW.id)
        OR NEW.version != COALESCE((SELECT MAX(version) FROM skill_versions WHERE skill_id = NEW.skill_id), 0) + 1
        THEN RAISE(ABORT, 'invalid skill version sequence') END;
    END;
    CREATE TRIGGER skill_sources_approved BEFORE INSERT ON skill_version_sources BEGIN
      SELECT CASE WHEN EXISTS(SELECT 1 FROM skill_version_states WHERE version_id = NEW.version_id)
        OR NOT EXISTS(SELECT 1 FROM experiences e JOIN experience_reviews r ON r.id = NEW.experience_review_id AND r.experience_id = e.id
          WHERE e.id = NEW.experience_id AND e.project_id = NEW.project_id AND e.approval_status = 'approved'
            AND e.updated_at = NEW.experience_updated_at AND r.decision = 'approved' AND r.created_at = e.reviewed_at)
        THEN RAISE(ABORT, 'skill source must be a current approved scoped experience') END;
    END;
    CREATE TRIGGER skill_state_initial BEFORE INSERT ON skill_version_states BEGIN
      SELECT CASE WHEN EXISTS(SELECT 1 FROM skill_version_states WHERE version_id = NEW.version_id)
        OR NEW.status != 'candidate' OR NEW.latest_evaluation_id IS NOT NULL OR NEW.review_id IS NOT NULL
        OR NEW.revision != 0 OR NEW.updated_at IS NOT (SELECT created_at FROM skill_versions WHERE id = NEW.version_id)
        OR (SELECT COUNT(*) FROM skill_version_sources WHERE version_id = NEW.version_id) NOT BETWEEN 1 AND 32
        THEN RAISE(ABORT, 'invalid initial skill version state') END;
    END;
    CREATE TRIGGER skill_evaluations_valid BEFORE INSERT ON skill_evaluations BEGIN
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM skill_version_states s JOIN skill_versions v ON v.id = s.version_id
        JOIN skills k ON k.id = s.skill_id WHERE s.version_id = NEW.version_id AND s.status = 'candidate'
          AND NEW.content_hash = v.content_hash AND NEW.created_at > s.updated_at AND NEW.baseline_version_id IS k.active_version_id)
        OR NEW.baseline_version_id IS NEW.version_id
        OR EXISTS(SELECT 1 FROM json_each(NEW.checks_json) WHERE json_type(value, '$.name') IS NOT 'text'
          OR length(trim(json_extract(value, '$.name'))) NOT BETWEEN 1 AND 100
          OR json_type(value, '$.details') IS NOT 'text' OR length(json_extract(value, '$.details')) > 2000
          OR json_extract(value, '$.result') NOT IN ('PASS', 'FAIL', 'NOT_VERIFIED') OR json_type(value, '$.result') IS NOT 'text')
        OR (NEW.result = 'PASS' AND (EXISTS(SELECT 1 FROM json_each(NEW.checks_json) WHERE json_extract(value, '$.result') != 'PASS')
          OR (NEW.baseline_version_id IS NOT NULL AND NEW.regression_result != 'PASS')))
        THEN RAISE(ABORT, 'invalid skill evaluation record') END;
    END;
    CREATE TRIGGER skill_evaluations_apply AFTER INSERT ON skill_evaluations BEGIN
      UPDATE skill_version_states SET latest_evaluation_id = NEW.id, revision = revision + 1, updated_at = NEW.created_at
        WHERE version_id = NEW.version_id;
    END;
    CREATE TRIGGER skill_reviews_valid BEFORE INSERT ON skill_reviews BEGIN
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM skill_version_states s WHERE s.version_id = NEW.version_id
        AND s.status != 'rejected' AND NEW.created_at > s.updated_at AND NEW.evaluation_id IS s.latest_evaluation_id)
        OR EXISTS(SELECT 1 FROM skills WHERE active_version_id = NEW.version_id)
        OR (NEW.decision = 'approved' AND (NOT EXISTS(SELECT 1 FROM skill_version_states s
          JOIN skill_evaluations e ON e.id = s.latest_evaluation_id JOIN skills k ON k.id = s.skill_id
          WHERE s.version_id = NEW.version_id AND s.status = 'candidate' AND e.result = 'PASS'
            AND e.baseline_version_id IS k.active_version_id)
          OR EXISTS(SELECT 1 FROM skill_version_sources r JOIN experiences e ON e.id = r.experience_id
            WHERE r.version_id = NEW.version_id AND e.approval_status != 'approved')))
        THEN RAISE(ABORT, 'invalid skill review record') END;
    END;
    CREATE TRIGGER skill_reviews_apply AFTER INSERT ON skill_reviews BEGIN
      UPDATE skill_version_states SET status = NEW.decision, review_id = NEW.id,
        revision = revision + 1, updated_at = NEW.created_at WHERE version_id = NEW.version_id;
    END;
    CREATE TRIGGER skill_state_guard BEFORE UPDATE ON skill_version_states BEGIN
      SELECT CASE WHEN NEW.version_id != OLD.version_id OR NEW.skill_id != OLD.skill_id OR NEW.project_id != OLD.project_id
        OR NEW.revision != OLD.revision + 1 OR NEW.updated_at <= OLD.updated_at OR OLD.status = 'rejected'
        OR NOT ((OLD.status = 'candidate' AND NEW.status = 'candidate' AND NEW.review_id IS OLD.review_id
          AND NEW.latest_evaluation_id IS NOT OLD.latest_evaluation_id AND EXISTS(SELECT 1 FROM skill_evaluations
            WHERE id = NEW.latest_evaluation_id AND version_id = NEW.version_id AND created_at = NEW.updated_at))
          OR (NEW.latest_evaluation_id IS OLD.latest_evaluation_id AND NEW.review_id IS NOT OLD.review_id
            AND EXISTS(SELECT 1 FROM skill_reviews WHERE id = NEW.review_id AND version_id = NEW.version_id
              AND decision = NEW.status AND created_at = NEW.updated_at)
            AND ((OLD.status = 'candidate' AND NEW.status IN ('approved', 'rejected')) OR
              (OLD.status = 'approved' AND NEW.status = 'rejected'))))
        THEN RAISE(ABORT, 'invalid skill lifecycle transition') END;
    END;
    CREATE TRIGGER skill_promotions_valid BEFORE INSERT ON skill_promotions BEGIN
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM skills WHERE id = NEW.skill_id AND project_id = NEW.project_id
          AND revision = NEW.expected_revision AND active_version_id IS NEW.from_version_id AND NEW.created_at > updated_at)
        OR (NEW.action != 'deactivate' AND (NOT EXISTS(SELECT 1 FROM skill_version_states s JOIN skill_reviews r ON r.id = s.review_id
          JOIN skill_evaluations e ON e.id = s.latest_evaluation_id WHERE s.version_id = NEW.to_version_id
            AND s.status = 'approved' AND r.id = NEW.approval_id AND r.decision = 'approved' AND e.result = 'PASS')
          OR EXISTS(SELECT 1 FROM skill_version_sources r JOIN experiences e ON e.id = r.experience_id
            WHERE r.version_id = NEW.to_version_id AND e.approval_status != 'approved')))
        OR (NEW.action = 'promote' AND NOT EXISTS(SELECT 1 FROM skill_version_states s
          JOIN skill_evaluations e ON e.id = s.latest_evaluation_id WHERE s.version_id = NEW.to_version_id
            AND e.baseline_version_id IS NEW.from_version_id))
        OR (NEW.action = 'rollback' AND NOT EXISTS(SELECT 1 FROM skill_promotions
          WHERE skill_id = NEW.skill_id AND to_version_id = NEW.to_version_id))
        THEN RAISE(ABORT, 'invalid skill promotion record') END;
    END;
    CREATE TRIGGER skill_promotions_apply AFTER INSERT ON skill_promotions BEGIN
      UPDATE skills SET active_version_id = NEW.to_version_id, last_transition_id = NEW.id,
        revision = revision + 1, updated_at = NEW.created_at WHERE id = NEW.skill_id;
    END;
    CREATE TRIGGER skills_pointer_guard BEFORE UPDATE ON skills BEGIN
      SELECT CASE WHEN NEW.id != OLD.id OR NEW.project_id != OLD.project_id OR NEW.name != OLD.name
        OR NEW.description != OLD.description OR NEW.created_at != OLD.created_at OR NEW.revision != OLD.revision + 1
        OR NOT EXISTS(SELECT 1 FROM skill_promotions p WHERE p.id = NEW.last_transition_id AND p.skill_id = NEW.id
          AND p.project_id = NEW.project_id AND p.expected_revision = OLD.revision
          AND p.from_version_id IS OLD.active_version_id AND p.to_version_id IS NEW.active_version_id AND p.created_at = NEW.updated_at)
        THEN RAISE(ABORT, 'skill pointer requires an audited transition') END;
    END;
    PRAGMA user_version = 5;
  `);
  // These table names are fixed migration identifiers, never user input.
  for (const table of [
    'skill_versions',
    'skill_version_sources',
    'skill_evaluations',
    'skill_reviews',
    'skill_promotions',
  ]) {
    for (const action of ['UPDATE', 'DELETE'])
      db.exec(`CREATE TRIGGER ${table}_immutable_${action.toLowerCase()}
      BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT, 'immutable skill history'); END;`);
  }
  for (const table of ['skill_evaluations', 'skill_reviews', 'skill_promotions'])
    db.exec(`
    CREATE TRIGGER ${table}_no_replace BEFORE INSERT ON ${table}
    WHEN EXISTS(SELECT 1 FROM ${table} WHERE id = NEW.id)
    BEGIN SELECT RAISE(ABORT, 'immutable skill history'); END;`);
  db.exec(`CREATE TRIGGER skill_states_no_delete BEFORE DELETE ON skill_version_states
    BEGIN SELECT RAISE(ABORT, 'immutable skill history'); END;
    CREATE TRIGGER skills_no_delete BEFORE DELETE ON skills
    BEGIN SELECT RAISE(ABORT, 'immutable skill history'); END;`);
}

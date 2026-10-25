import type Database from 'better-sqlite3';

export function migrateSkillUsage(db: Database.Database) {
  db.exec(`
    CREATE TABLE skill_usage_dedup (
      event_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id),
      payload_hash TEXT NOT NULL, received_at TEXT NOT NULL, UNIQUE(event_id,project_id)
    );
    CREATE TABLE skill_usage_events (
      event_id TEXT PRIMARY KEY NOT NULL,
      schema_version INTEGER NOT NULL CHECK(schema_version=1),
      project_id TEXT NOT NULL, skill_id TEXT NOT NULL, version_id TEXT NOT NULL,
      artifact_digest TEXT NOT NULL, timestamp TEXT NOT NULL, received_at TEXT NOT NULL,
      source_cli TEXT NOT NULL CHECK(source_cli IN ('codex','claude','unknown')),
      event_type TEXT NOT NULL CHECK(event_type IN ('installed','discovered','invoked','executed','task_succeeded','task_failed','task_unknown')),
      installation_id TEXT, session_id TEXT, task_id TEXT, evidence_reference TEXT, note TEXT,
      category TEXT NOT NULL CHECK(category IN ('llm_reported','registry_install','mcp_observation','native_hook','test_runner','operator_confirmed')),
      method TEXT NOT NULL, verification TEXT NOT NULL CHECK(verification IN ('unverified','observed','verified_check','operator_confirmed')),
      details_json TEXT NOT NULL CHECK(json_valid(details_json) AND length(details_json)<=8192),
      FOREIGN KEY(version_id,skill_id,project_id) REFERENCES skill_versions(id,skill_id,project_id),
      FOREIGN KEY(event_id,project_id) REFERENCES skill_usage_dedup(event_id,project_id),
      CHECK(event_type NOT IN ('task_succeeded','task_failed') OR verification IN ('unverified','operator_confirmed')),
      CHECK(verification!='operator_confirmed' OR category='operator_confirmed'),
      CHECK(category!='llm_reported' OR verification='unverified')
    );
    CREATE INDEX skill_usage_project_time ON skill_usage_events(project_id,timestamp,event_id);
    CREATE INDEX skill_usage_version_time ON skill_usage_events(project_id,version_id,timestamp);
    CREATE INDEX skill_usage_retention ON skill_usage_events(project_id,received_at,event_id);
    CREATE TRIGGER skill_usage_immutable BEFORE UPDATE ON skill_usage_events BEGIN SELECT RAISE(ABORT,'immutable usage event'); END;
    CREATE TRIGGER skill_usage_no_replace BEFORE INSERT ON skill_usage_events WHEN EXISTS(SELECT 1 FROM skill_usage_events WHERE event_id=NEW.event_id) BEGIN SELECT RAISE(ABORT,'immutable usage event'); END;
    CREATE TRIGGER skill_usage_dedup_immutable BEFORE UPDATE ON skill_usage_dedup BEGIN SELECT RAISE(ABORT,'immutable usage identity'); END;
    CREATE TRIGGER skill_usage_dedup_no_delete BEFORE DELETE ON skill_usage_dedup BEGIN SELECT RAISE(ABORT,'retained usage identity'); END;
    CREATE TRIGGER skill_usage_dedup_no_replace BEFORE INSERT ON skill_usage_dedup WHEN EXISTS(SELECT 1 FROM skill_usage_dedup WHERE event_id=NEW.event_id) BEGIN SELECT RAISE(ABORT,'immutable usage identity'); END;
    CREATE TABLE skill_usage_cleanup (
      id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id),
      cutoff TEXT NOT NULL, deleted_count INTEGER NOT NULL, operator_id TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TRIGGER skill_usage_cleanup_immutable BEFORE UPDATE ON skill_usage_cleanup BEGIN SELECT RAISE(ABORT,'immutable cleanup audit'); END;
    CREATE TRIGGER skill_usage_cleanup_no_delete BEFORE DELETE ON skill_usage_cleanup BEGIN SELECT RAISE(ABORT,'immutable cleanup audit'); END;
    CREATE TRIGGER skill_usage_cleanup_no_replace BEFORE INSERT ON skill_usage_cleanup WHEN EXISTS(SELECT 1 FROM skill_usage_cleanup WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'immutable cleanup audit'); END;
    PRAGMA user_version=9;
  `);
}

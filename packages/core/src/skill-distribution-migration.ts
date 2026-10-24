import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export function migrateSkillDistribution(db: Database.Database) {
  db.exec(`
    CREATE TABLE skill_registry_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL UNIQUE);
    CREATE TRIGGER skill_registry_identity_no_update BEFORE UPDATE ON skill_registry_identity BEGIN SELECT RAISE(ABORT,'immutable registry identity'); END;
    CREATE TRIGGER skill_registry_identity_no_delete BEFORE DELETE ON skill_registry_identity BEGIN SELECT RAISE(ABORT,'immutable registry identity'); END;
    CREATE TABLE skill_installations (
      id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, skill_id TEXT NOT NULL, version_id TEXT NOT NULL,
      target TEXT NOT NULL CHECK(target IN ('codex','claude')), scope TEXT NOT NULL CHECK(scope IN ('project','user')),
      destination TEXT NOT NULL UNIQUE, installed_digest TEXT NOT NULL,
      manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json) AND length(manifest_json)<=8192), manifest_hash TEXT NOT NULL,
      root_identity TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('installed','removed')),
      last_verified_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(version_id,skill_id,project_id) REFERENCES skill_versions(id,skill_id,project_id)
    );
    CREATE INDEX skill_installations_scope ON skill_installations(project_id,skill_id);
    CREATE TABLE skill_distribution_intents (
      id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, skill_id TEXT NOT NULL,
      target TEXT NOT NULL CHECK(target IN ('codex','claude')), scope TEXT NOT NULL CHECK(scope IN ('project','user')),
      destination TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('INSTALL','UPDATE','REMOVE','REPAIR')),
      manifest_json TEXT CHECK(manifest_json IS NULL OR (json_valid(manifest_json) AND length(manifest_json)<=8192)), manifest_hash TEXT,
      worker_id TEXT NOT NULL,
      old_record_json TEXT CHECK(old_record_json IS NULL OR (json_valid(old_record_json) AND length(old_record_json)<=20000)), stage_identity TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','completed','aborted')),
      operator_id TEXT NOT NULL, session_id TEXT NOT NULL, context_digest TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY(skill_id,project_id) REFERENCES skills(id,project_id)
    );
    CREATE UNIQUE INDEX skill_distribution_pending ON skill_distribution_intents(destination) WHERE status='pending';
    CREATE TABLE skill_distribution_events (
      id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, skill_id TEXT NOT NULL, destination TEXT NOT NULL,
      target TEXT NOT NULL CHECK(target IN ('codex','claude')), scope TEXT NOT NULL CHECK(scope IN ('project','user')),
      intent_id TEXT REFERENCES skill_distribution_intents(id), action TEXT NOT NULL, outcome TEXT NOT NULL,
      version_id TEXT, installed_digest TEXT, operator_id TEXT NOT NULL, authorization_method TEXT NOT NULL,
      session_id TEXT, context_digest TEXT, created_at TEXT NOT NULL,
      FOREIGN KEY(skill_id,project_id) REFERENCES skills(id,project_id),
      FOREIGN KEY(version_id,skill_id,project_id) REFERENCES skill_versions(id,skill_id,project_id)
    );
    CREATE INDEX skill_distribution_event_scope ON skill_distribution_events(project_id,skill_id,created_at);
    CREATE TRIGGER skill_distribution_events_no_update BEFORE UPDATE ON skill_distribution_events BEGIN SELECT RAISE(ABORT,'immutable distribution audit'); END;
    CREATE TRIGGER skill_distribution_events_no_delete BEFORE DELETE ON skill_distribution_events BEGIN SELECT RAISE(ABORT,'immutable distribution audit'); END;
    CREATE TRIGGER skill_distribution_events_no_replace BEFORE INSERT ON skill_distribution_events WHEN EXISTS(SELECT 1 FROM skill_distribution_events WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT,'immutable distribution audit'); END;
    PRAGMA user_version = 8;
  `);
  db.prepare('INSERT INTO skill_registry_identity VALUES(1,?)').run(randomUUID());
}

import type Database from 'better-sqlite3';
/** Additive intent guards. Planning/reads never install these triggers. */
export function migrateDistributionReliability(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS distribution_recovery_decisions(
    intent_id TEXT PRIMARY KEY REFERENCES skill_distribution_intents(id),project_id TEXT NOT NULL,
    outcome TEXT NOT NULL,record_json TEXT CHECK(record_json IS NULL OR (json_valid(record_json) AND length(record_json)<=20000)));
    CREATE TRIGGER IF NOT EXISTS recovery_decision_no_update BEFORE UPDATE ON distribution_recovery_decisions BEGIN SELECT RAISE(ABORT,'immutable recovery decision');END;
    CREATE TRIGGER IF NOT EXISTS recovery_decision_no_delete BEFORE DELETE ON distribution_recovery_decisions BEGIN SELECT RAISE(ABORT,'immutable recovery decision');END;
    CREATE TRIGGER IF NOT EXISTS recovery_decision_no_replace BEFORE INSERT ON distribution_recovery_decisions WHEN EXISTS(SELECT 1 FROM distribution_recovery_decisions WHERE intent_id=NEW.intent_id) BEGIN SELECT RAISE(ABORT,'immutable recovery decision');END;
    CREATE TABLE IF NOT EXISTS distribution_recovery_resolutions(
      intent_id TEXT PRIMARY KEY REFERENCES distribution_recovery_decisions(intent_id),project_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('ABORTED_STALE_PUBLICATION','ABORTED_CORRUPT_PUBLICATION','ABORTED_UNPUBLISHED')));
    CREATE TRIGGER IF NOT EXISTS recovery_resolution_no_update BEFORE UPDATE ON distribution_recovery_resolutions BEGIN SELECT RAISE(ABORT,'immutable recovery resolution');END;
    CREATE TRIGGER IF NOT EXISTS recovery_resolution_no_delete BEFORE DELETE ON distribution_recovery_resolutions BEGIN SELECT RAISE(ABORT,'immutable recovery resolution');END;
    CREATE TRIGGER IF NOT EXISTS recovery_resolution_no_replace BEFORE INSERT ON distribution_recovery_resolutions WHEN EXISTS(SELECT 1 FROM distribution_recovery_resolutions WHERE intent_id=NEW.intent_id) BEGIN SELECT RAISE(ABORT,'immutable recovery resolution');END;
    CREATE INDEX IF NOT EXISTS distribution_intent_history ON skill_distribution_intents(project_id,skill_id,created_at,id);
    CREATE TRIGGER IF NOT EXISTS distribution_intent_binding BEFORE UPDATE ON skill_distribution_intents
    WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.skill_id IS NOT OLD.skill_id
      OR NEW.target IS NOT OLD.target OR NEW.scope IS NOT OLD.scope OR NEW.destination IS NOT OLD.destination
      OR NEW.action IS NOT OLD.action OR NEW.manifest_json IS NOT OLD.manifest_json OR NEW.manifest_hash IS NOT OLD.manifest_hash
      OR NEW.old_record_json IS NOT OLD.old_record_json OR NEW.operator_id IS NOT OLD.operator_id
      OR NEW.session_id IS NOT OLD.session_id OR NEW.context_digest IS NOT OLD.context_digest OR NEW.created_at IS NOT OLD.created_at
      OR (OLD.stage_identity IS NOT NULL AND NEW.stage_identity IS NOT OLD.stage_identity)
      OR OLD.status != 'pending'
    BEGIN SELECT RAISE(ABORT,'immutable distribution intent binding'); END;
    CREATE TRIGGER IF NOT EXISTS distribution_intent_no_delete BEFORE DELETE ON skill_distribution_intents
    BEGIN SELECT RAISE(ABORT,'immutable distribution intent'); END;`);
}
/** Named observation boundaries. Tests mock this module; no production/env fault switch exists. */
export function distributionCheckpoint(_name: string, _intent: string): void {}

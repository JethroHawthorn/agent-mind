import type Database from 'better-sqlite3';

/** Test-fixture downgrade only, to reconstruct legacy schemas from openDatabase(). */
export function removeSkillSchema(db: Database.Database): void {
  const foreignKeys = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      DROP TABLE IF EXISTS skill_distribution_events; DROP TABLE IF EXISTS skill_distribution_intents; DROP TABLE IF EXISTS skill_installations; DROP TABLE IF EXISTS skill_registry_identity;
      DROP TABLE IF EXISTS skill_operator_events;
      DROP TABLE IF EXISTS skills_fts;
      DROP TABLE skill_promotions;
      DROP TABLE skill_reviews;
      DROP TABLE skill_evaluations;
      DROP TABLE skill_version_sources;
      DROP TABLE skill_version_states;
      DROP TABLE skill_versions;
      DROP TABLE skills;
      DROP INDEX skill_experience_scope;
      DROP INDEX skill_experience_review_parent;
      PRAGMA user_version = 4;
    `);
  } finally {
    db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  }
}

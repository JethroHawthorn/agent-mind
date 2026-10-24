import type Database from 'better-sqlite3';

/** v4: intersect content terms with an indexed trusted project term inside FTS. */
export function migrateExperienceScopeIndex(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER experiences_insert;
    DROP TRIGGER experiences_delete;
    DROP TRIGGER experiences_update;
    DROP TABLE experiences_fts;
    CREATE VIRTUAL TABLE experiences_fts USING fts5(
      problem, solution, outcome_summary, project_id,
      content='experiences', content_rowid='rowid', tokenize='unicode61'
    );
    CREATE TRIGGER experiences_insert AFTER INSERT ON experiences BEGIN
      INSERT INTO experiences_fts(rowid, problem, solution, outcome_summary, project_id)
      VALUES (new.rowid, new.problem, new.solution, new.outcome_summary, new.project_id);
    END;
    CREATE TRIGGER experiences_delete AFTER DELETE ON experiences BEGIN
      INSERT INTO experiences_fts(experiences_fts, rowid, problem, solution, outcome_summary, project_id)
      VALUES ('delete', old.rowid, old.problem, old.solution, old.outcome_summary, old.project_id);
    END;
    CREATE TRIGGER experiences_update AFTER UPDATE OF problem, solution, outcome_summary, project_id ON experiences BEGIN
      INSERT INTO experiences_fts(experiences_fts, rowid, problem, solution, outcome_summary, project_id)
      VALUES ('delete', old.rowid, old.problem, old.solution, old.outcome_summary, old.project_id);
      INSERT INTO experiences_fts(rowid, problem, solution, outcome_summary, project_id)
      VALUES (new.rowid, new.problem, new.solution, new.outcome_summary, new.project_id);
    END;
    INSERT INTO experiences_fts(experiences_fts) VALUES ('rebuild');
    PRAGMA user_version = 4;
  `);
}

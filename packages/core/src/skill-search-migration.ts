import type Database from 'better-sqlite3';

export function migrateSkillDiscovery(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE skills_fts USING fts5(name, description, project_id,
      content='skills', content_rowid='rowid', tokenize='unicode61');
    CREATE TRIGGER skills_fts_insert AFTER INSERT ON skills BEGIN
      INSERT INTO skills_fts(rowid, name, description, project_id) VALUES(new.rowid, new.name, new.description, new.project_id);
    END;
    CREATE TRIGGER skills_fts_delete AFTER DELETE ON skills BEGIN
      INSERT INTO skills_fts(skills_fts, rowid, name, description, project_id)
      VALUES('delete', old.rowid, old.name, old.description, old.project_id);
    END;
    CREATE TRIGGER skills_fts_update AFTER UPDATE OF name, description, project_id ON skills BEGIN
      INSERT INTO skills_fts(skills_fts, rowid, name, description, project_id)
      VALUES('delete', old.rowid, old.name, old.description, old.project_id);
      INSERT INTO skills_fts(rowid, name, description, project_id) VALUES(new.rowid, new.name, new.description, new.project_id);
    END;
    INSERT INTO skills_fts(skills_fts) VALUES('rebuild');
    PRAGMA user_version = 6;
  `);
}

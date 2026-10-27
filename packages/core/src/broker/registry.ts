import type Database from 'better-sqlite3';
import { denied } from './policy.js';
/** This marker is not a signature/secret. Its provenance is the fresh broker-owned
 * file created inside an already-private OS boundary, plus root-owned config.
 * Never import an agent-supplied DB/schema or marker as trusted protected state. */
export function verifyProtectedRegistry(db: Database.Database, deploymentId: string) {
  const table = db.prepare("SELECT type FROM sqlite_master WHERE name='broker_deployment'").get() as
    | { type: string }
    | undefined;
  if (table?.type !== 'table')
    denied(
      'Existing registry has no protected origin checkpoint; untrusted SQLite migration is unsupported.',
    );
  const rows = db.prepare('SELECT singleton,deployment_id FROM broker_deployment').all() as {
    singleton: number;
    deployment_id: string;
  }[];
  if (rows.length !== 1 || rows[0]?.singleton !== 1 || rows[0].deployment_id !== deploymentId)
    denied('Protected registry origin differs from root-owned deployment policy.');
}
/** Call only on a newly created private registry, before broker/domain admission. */
export function initializeProtectedRegistry(db: Database.Database, deploymentId: string) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='broker_deployment'").get())
    denied('Refusing to overwrite a registry checkpoint.');
  db.transaction(() => {
    db.exec(`CREATE TABLE broker_deployment(singleton INTEGER PRIMARY KEY CHECK(singleton=1),deployment_id TEXT NOT NULL);
 CREATE TRIGGER broker_deployment_no_update BEFORE UPDATE ON broker_deployment BEGIN SELECT RAISE(ABORT,'immutable protected origin');END;
 CREATE TRIGGER broker_deployment_no_delete BEFORE DELETE ON broker_deployment BEGIN SELECT RAISE(ABORT,'immutable protected origin');END;
 CREATE TRIGGER broker_deployment_no_replace BEFORE INSERT ON broker_deployment WHEN EXISTS(SELECT 1 FROM broker_deployment) BEGIN SELECT RAISE(ABORT,'immutable protected origin');END;`);
    db.prepare('INSERT INTO broker_deployment VALUES(1,?)').run(deploymentId);
  }).immediate();
}

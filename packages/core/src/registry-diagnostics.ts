import { realpathSync } from 'node:fs';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION } from './database.js';
import { inspectDatabase } from './database-maintenance.js';
import type { ProjectScope } from './project.js';
import { SkillRetrievalService } from './retrieval/service.js';
/** Read-only, bounded, project-scoped diagnostics; no schema creation, repairs or content output. */
export function inspectRegistry(path: string, scope: ProjectScope) {
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true, timeout: 250 });
    const version = db.pragma('user_version', { simple: true });
    if (version !== SCHEMA_VERSION)
      return {
        status: 'FAIL' as const,
        reason: 'SCHEMA_MISMATCH',
        expected_schema: SCHEMA_VERSION,
      };
    const project = db.prepare('SELECT canonical_path FROM projects WHERE id=?').get(scope.id) as
      | { canonical_path: string }
      | undefined;
    if (project && project.canonical_path !== scope.root)
      return { status: 'FAIL' as const, reason: 'SCOPE_MISMATCH' };
    const ids = db
      .prepare(
        'SELECT id FROM skills WHERE project_id=? AND active_version_id IS NOT NULL ORDER BY id LIMIT 101',
      )
      .all(scope.id) as { id: string }[];
    let valid = 0,
      invalid = 0;
    const retrieval = new SkillRetrievalService(db, scope);
    for (const row of ids.slice(0, 100)) {
      try {
        retrieval.load({ skill_id: row.id });
        valid++;
      } catch {
        invalid++;
      }
    }
    return {
      status: invalid
        ? ('FAIL' as const)
        : ids.length > 100
          ? ('WARNING' as const)
          : ('PASS' as const),
      reason: invalid
        ? 'ACTIVE_ARTIFACT_UNAVAILABLE_OR_INVALID'
        : ids.length > 100
          ? 'BOUNDED_SAMPLE_ONLY'
          : 'READ_ONLY_CHECKS_COMPLETE',
      schema: version,
      storage: inspectDatabase(realpathSync(path)),
      checked: valid + invalid,
      invalid,
      incomplete: ids.length > 100,
    };
  } catch {
    return { status: 'FAIL' as const, reason: 'REGISTRY_UNAVAILABLE_LOCKED_OR_INVALID' };
  } finally {
    db?.close();
  }
}

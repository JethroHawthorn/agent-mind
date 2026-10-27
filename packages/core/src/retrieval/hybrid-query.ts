import type Database from 'better-sqlite3';
import { AgentMindError } from '../errors.js';
import type { ProjectScope } from '../project.js';
import { hybridStorageExists } from './hybrid-storage.js';
import { retrieveCandidates } from './ranking.js';
export type HybridCandidate = {
  skill_id: string;
  name: string;
  description: string;
  version_id: string;
  content_hash: string;
  metadata?: string;
};
const base = `FROM skill_discovery_fts f JOIN skill_versions v ON v.rowid=f.rowid AND v.id=f.version_id AND v.project_id=f.project_id AND v.content_hash=f.digest
 JOIN skills k ON k.id=v.skill_id AND k.project_id=v.project_id AND k.active_version_id=v.id
 JOIN skill_version_states s ON s.version_id=v.id AND s.project_id=v.project_id AND s.status='approved'
 WHERE v.project_id=? AND f.project_id=? AND f.name=k.name AND f.description=v.description
 AND NOT EXISTS(SELECT 1 FROM skill_version_sources r JOIN experiences e ON e.id=r.experience_id AND e.project_id=r.project_id WHERE r.version_id=v.id AND (e.approval_status!='approved' OR e.updated_at!=r.experience_updated_at))`;
/** Bounded multi-channel union, no all-registry feature scan, BM25 or cross-project statistics. */
export function hybridCandidates(
  db: Database.Database,
  scope: ProjectScope,
  terms: string[],
  exactName: string,
  limit: number,
) {
  if (!hybridStorageExists(db))
    throw new AgentMindError(
      'RETRIEVAL_INDEX_UNAVAILABLE',
      'Initialize hybrid discovery through trusted startup/maintenance.',
    );
  const half = Math.max(1, Math.floor(limit / 2));
  const exact = db
    .prepare(
      `SELECT k.id skill_id,k.name,v.description,v.id version_id,v.content_hash,f.metadata ${base} AND k.name=? LIMIT 1`,
    )
    .all(scope.id, scope.id, exactName) as HybridCandidate[];
  if (!terms.length) return exact;
  const match = `{name description metadata}:(${terms.map((t) => `"${t}"`).join(' OR ')}) AND project_id:"${scope.id}"`;
  const enriched = db
    .prepare(
      `SELECT k.id skill_id,k.name,v.description,v.id version_id,v.content_hash,f.metadata ${base} AND skill_discovery_fts MATCH ? ORDER BY CASE WHEN instr(lower(f.metadata),?)>0 THEN 1 ELSE 0 END DESC,k.name,k.id LIMIT ?`,
    )
    .all(scope.id, scope.id, match, exactName.replaceAll('-', ' '), half) as HybridCandidate[];
  const legacy = retrieveCandidates(db, scope, terms.join(' '), half).rows;
  const rows = new Map<string, HybridCandidate>();
  for (const row of exact) rows.set(row.skill_id, row);
  for (let i = 0; i < Math.max(enriched.length, legacy.length); i++)
    for (const row of [legacy[i], enriched[i]])
      if (row && !rows.has(row.skill_id) && rows.size < limit) rows.set(row.skill_id, row);
  return [...rows.values()];
}

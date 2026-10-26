import type Database from 'better-sqlite3';
import { AgentMindError } from '../errors.js';
import { sanitizeExperienceText } from '../experience-privacy.js';
import type { ProjectScope } from '../project.js';
import { MAX_RETRIEVAL_CANDIDATES } from './model.js';
import { retrievalStorageExists } from './storage.js';

// Small code-owned spelling expansions, never instructions or model output.
const aliases: Readonly<Record<string, string>> = {
  js: 'javascript',
  ts: 'typescript',
  db: 'database',
  postgres: 'postgresql',
};
const stop = new Set([
  'a',
  'an',
  'the',
  'for',
  'to',
  'with',
  'and',
  'in',
  'on',
  'how',
  'use',
  'using',
  'skill',
  'please',
]);
export function queryTerms(query: string) {
  if (sanitizeExperienceText(query).redacted)
    throw new AgentMindError(
      'RETRIEVAL_INVALID_INPUT',
      'Use a short task description without secrets.',
    );
  const words = [
    ...new Set(
      query
        .normalize('NFKC')
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? [],
    ),
  ].filter((w) => !stop.has(w));
  const original = words.slice(0, 12).map((w) => w.slice(0, 40));
  const expanded = [
    ...new Set(original.flatMap((w) => (aliases[w] ? [w, aliases[w] as string] : [w]))),
  ];
  return { terms: expanded, normalized: original.join('-'), terms_truncated: words.length > 12 };
}
export type RankedCandidate = {
  skill_id: string;
  name: string;
  description: string;
  version_id: string;
  content_hash: string;
  exact_name: number;
  name_hits: number;
  description_hits: number;
};
function assertCandidateLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RETRIEVAL_CANDIDATES)
    throw new AgentMindError(
      'RETRIEVAL_INVALID_CONFIG',
      'Candidate verification limit must be an integer between 1 and 50.',
    );
}
/** Code-owned SQL plan shared with the offline EXPLAIN benchmark, never exposed as an MCP operation. */
export function buildRetrievalQuery(
  scope: ProjectScope,
  normalized: ReturnType<typeof queryTerms>,
  limit: number,
) {
  assertCandidateLimit(limit);
  const match = normalized.terms.map((t) => `"${t}"`).join(' OR ');
  const hits = (column: string) =>
    normalized.terms
      .map(() =>
        column === 'k.name'
          ? `CASE WHEN instr('-'||k.name||'-','-'||?||'-')>0 THEN 1 ELSE 0 END`
          : `CASE WHEN instr(lower(${column}),?)>0 THEN 1 ELSE 0 END`,
      )
      .join('+');
  return {
    sql: `SELECT k.id AS skill_id,k.name,v.description,v.id AS version_id,v.content_hash,
 CASE WHEN k.name=? THEN 1 ELSE 0 END AS exact_name,(${hits('k.name')}) AS name_hits,(${hits('v.description')}) AS description_hits
 FROM skill_version_retrieval_fts f JOIN skill_versions v ON v.rowid=f.rowid AND v.id=f.version_id AND v.project_id=f.project_id
 JOIN skills k ON k.id=v.skill_id AND k.project_id=v.project_id AND k.active_version_id=v.id
 JOIN skill_version_states s ON s.version_id=v.id AND s.project_id=v.project_id AND s.status='approved'
 WHERE skill_version_retrieval_fts MATCH ? AND v.project_id=? AND f.project_id=? AND f.name=k.name AND f.description=v.description
 ORDER BY exact_name DESC,name_hits DESC,description_hits DESC,k.name,k.id LIMIT ?`,
    parameters: [
      normalized.normalized,
      ...normalized.terms,
      ...normalized.terms,
      match,
      scope.id,
      scope.id,
      limit + 1,
    ],
  };
}
/** FTS5 finds candidates; project-local lexical ordering avoids cross-project BM25/IDF statistics. */
export function retrieveCandidates(
  db: Database.Database,
  scope: ProjectScope,
  query: string,
  limit: number,
) {
  assertCandidateLimit(limit);
  if (!retrievalStorageExists(db))
    throw new AgentMindError(
      'RETRIEVAL_INDEX_UNAVAILABLE',
      'Initialize the derived retrieval index through trusted startup or the maintenance CLI.',
    );
  const normalized = queryTerms(query);
  if (!normalized.terms.length)
    return { rows: [] as RankedCandidate[], ...normalized, truncated: false };
  const plan = buildRetrievalQuery(scope, normalized, limit);
  const rows = db.prepare(plan.sql).all(...plan.parameters) as RankedCandidate[];
  return { rows: rows.slice(0, limit), ...normalized, truncated: rows.length > limit };
}

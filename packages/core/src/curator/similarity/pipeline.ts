import { performance } from 'node:perf_hooks';
import type Database from 'better-sqlite3';
import { AgentMindError } from '../../errors.js';
import type { ProjectScope } from '../../project.js';
import { hashSkillFiles, skillFilesSchema } from '../../skill-model.js';
import { curatorDigest, draftRecommendationSchema, type RecommendationDraft } from '../model.js';
import { retrievePairs, scorePair } from './detect.js';
import { extractSkillFeatures, fingerprint } from './features.js';
import {
  compareRequestSchema,
  comparisonSchema,
  DETECTION_POLICY,
  type DuplicatePolicy,
  duplicateOptionsSchema,
  FEATURE_POLICY,
  type Features,
  featureSchema,
  type PairResult,
  pairResultSchema,
  suggestTriage,
} from './model.js';
import { similarityStorageExists } from './storage.js';
export type Eligible = {
  skill_id: string;
  version_id: string;
  content_hash: string;
  source_ids: string[];
};
const limitations = [
  'Lexical analysis is not semantic or behavioral equivalence; high similarity never proves safe interchangeability.',
  'Conflict detection covers exact imperative complements only, not general natural-language contradictions.',
  'No skill file was executed, no model was invoked, and no approval or installation is authorized.',
  'Selection and feature bounds can omit matches. SEC-01 protected deployment and BE-001 execution remain unverified.',
];
function eligible(
  db: Database.Database,
  scope: ProjectScope,
  p: DuplicatePolicy,
  options: ReturnType<typeof duplicateOptionsSchema.parse>,
  compare?: ReturnType<typeof compareRequestSchema.parse>,
) {
  const status = options.include_candidates
    ? "s.status IN ('approved','candidate')"
    : "s.status='approved'";
  const scopeFilter = options.include_inactive
    ? '1'
    : '(k.active_version_id IS NOT NULL OR k.last_transition_id IS NULL)';
  const latest = `(SELECT vv.id FROM skill_versions vv JOIN skill_version_states ss ON ss.version_id=vv.id AND ss.project_id=vv.project_id WHERE vv.skill_id=k.id AND vv.project_id=k.project_id AND ${options.include_candidates ? "ss.status IN ('approved','candidate')" : "ss.status='approved'"} ORDER BY vv.version DESC LIMIT 1)`;
  const selected = compare
    ? 'v.id IN (?,?)'
    : `v.id=${options.include_candidates ? latest : `COALESCE(k.active_version_id,${latest})`}`;
  const rows = db
    .prepare(
      `SELECT k.id AS skill_id,v.id AS version_id,v.content_hash FROM skills k JOIN skill_versions v ON v.skill_id=k.id AND v.project_id=k.project_id JOIN skill_version_states s ON s.version_id=v.id AND s.project_id=v.project_id WHERE k.project_id=? AND ${status} AND ${scopeFilter} AND ${selected} ORDER BY k.id,v.id LIMIT ?`,
    )
    .all(
      scope.id,
      ...(compare ? [compare.left_version_id, compare.right_version_id] : []),
      p.max_skills + 1,
    ) as Omit<Eligible, 'source_ids'>[];
  if (
    compare &&
    new Set(rows.map((r) => r.version_id)).size !==
      new Set([compare.left_version_id, compare.right_version_id]).size
  )
    throw new AgentMindError(
      'CURATOR_SCOPE_DENIED',
      'An exact version is unavailable or ineligible in this project.',
    );
  return rows.map((r) => ({
    ...r,
    source_ids: (
      db
        .prepare(
          'SELECT experience_id FROM skill_version_sources WHERE version_id=? AND project_id=? ORDER BY experience_id LIMIT 32',
        )
        .all(r.version_id, scope.id) as { experience_id: string }[]
    ).map((s) => s.experience_id),
  }));
}
export function runSimilarity(
  db: Database.Database,
  scope: ProjectScope,
  p: DuplicatePolicy,
  input: unknown,
  compareMode = false,
) {
  const start = performance.now();
  const request = compareMode
    ? compareRequestSchema.parse(input)
    : duplicateOptionsSchema.parse(input);
  const all = eligible(
    db,
    scope,
    p,
    request,
    compareMode ? compareRequestSchema.parse(input) : undefined,
  );
  const coverage = {
    skills_truncated: all.length > p.max_skills,
    events_truncated: false,
    experiences_truncated: false,
    recommendations_truncated: false,
    pairs_truncated: false,
    features_truncated: false,
  };
  const rows = all.slice(0, p.max_skills);
  const hasCache = similarityStorageExists(db);
  const featureWrites: Array<{ digest: string; payload: string; checksum: string }> = [];
  const pairWrites: Array<{ fingerprint: string; payload: string; checksum: string }> = [];
  let featureHits = 0,
    pairHits = 0;
  const features: Features[] = rows.map((row) => {
    const raw = db
      .prepare('SELECT files_json FROM skill_versions WHERE id=? AND project_id=?')
      .get(row.version_id, scope.id) as { files_json: string };
    if (!raw || Buffer.byteLength(raw.files_json) > 262144)
      throw new AgentMindError(
        'CURATOR_ARTIFACT_INVALID',
        'A selected artifact is unavailable or oversized.',
      );
    let files: ReturnType<typeof skillFilesSchema.parse>;
    try {
      files = skillFilesSchema.parse(JSON.parse(raw.files_json));
      if (hashSkillFiles(files) !== row.content_hash) throw new Error('digest');
    } catch {
      throw new AgentMindError('CURATOR_ARTIFACT_INVALID', 'Artifact integrity validation failed.');
    }
    const cached = hasCache
      ? (db
          .prepare(
            'SELECT payload,checksum FROM curator_feature_cache WHERE project_id=? AND digest=? AND policy=?',
          )
          .get(scope.id, row.content_hash, FEATURE_POLICY) as
          | { payload: string; checksum: string }
          | undefined)
      : undefined;
    if (cached && cached.checksum === fingerprint(cached.payload)) {
      try {
        const f = featureSchema.parse(JSON.parse(cached.payload));
        if (f.digest === row.content_hash) {
          featureHits++;
          return f;
        }
      } catch {}
    }
    let feature: Features;
    try {
      feature = extractSkillFeatures(files, row.content_hash);
    } catch {
      throw new AgentMindError(
        'CURATOR_ARTIFACT_INVALID',
        'Malformed skill instructions cannot be analyzed.',
      );
    }
    const payload = JSON.stringify(feature);
    featureWrites.push({ digest: row.content_hash, payload, checksum: fingerprint(payload) });
    return feature;
  });
  const extracted = performance.now();
  const retrieval = compareMode
    ? {
        pairs: rows.length === 1 ? [[0, 0] as [number, number]] : [[0, 1] as [number, number]],
        truncated: false,
      }
    : retrievePairs(features, p);
  const retrieved = performance.now();
  const comparisons = [];
  const drafts: RecommendationDraft[] = [];
  for (const [i, j] of retrieval.pairs) {
    const a = rows[i],
      b = rows[j],
      fa = features[i],
      fb = features[j];
    if (!a || !b || !fa || !fb) continue;
    const key = curatorDigest([
      DETECTION_POLICY,
      FEATURE_POLICY,
      p,
      fa,
      fb,
      a.source_ids,
      b.source_ids,
    ]);
    const cached = hasCache
      ? (db
          .prepare(
            'SELECT payload,checksum FROM curator_pair_cache WHERE project_id=? AND fingerprint=?',
          )
          .get(scope.id, key) as { payload: string; checksum: string } | undefined)
      : undefined;
    let result: PairResult | undefined;
    if (cached && cached.checksum === fingerprint(cached.payload))
      try {
        result = pairResultSchema.parse(JSON.parse(cached.payload));
        pairHits++;
      } catch {}
    if (!result) {
      result = scorePair(fa, fb, p);
      const payload = JSON.stringify(result);
      pairWrites.push({ fingerprint: key, payload, checksum: fingerprint(payload) });
    }
    if (a.skill_id === b.skill_id)
      result = {
        ...result,
        classification: 'NOT_RELATED',
        matched_signals: ['Versions of one skill identity are not duplicate skills.'],
      };
    const shared = a.source_ids.filter((id) => b.source_ids.includes(id));
    if (shared.length)
      result = {
        ...result,
        matched_signals: [
          ...result.matched_signals,
          `${shared.length} shared experience references (not proof of task equivalence).`,
        ],
      };
    const comparison = comparisonSchema.parse({
      ...result,
      left_skill_id: a.skill_id,
      right_skill_id: b.skill_id,
      left_version_id: a.version_id,
      right_version_id: b.version_id,
      left_digest: a.content_hash,
      right_digest: b.content_hash,
      policy_version: DETECTION_POLICY,
      triage: suggestTriage(result.classification),
    });
    if (compareMode) comparisons.push(comparison);
    if (['NOT_RELATED', 'INSUFFICIENT_EVIDENCE'].includes(result.classification)) continue;
    const type =
      result.classification === 'EXACT_DUPLICATE'
        ? 'CONSOLIDATE'
        : result.classification === 'NEAR_DUPLICATE'
          ? 'POSSIBLE_DUPLICATE'
          : 'REVIEW';
    drafts.push(
      draftRecommendationSchema.parse({
        skill_id: a.skill_id,
        version_id: a.version_id,
        related_version_id: b.version_id,
        rule_id: `duplicates:${result.classification.toLowerCase()}`,
        type,
        priority: result.classification === 'POSSIBLE_CONFLICT' ? 'MEDIUM' : 'LOW',
        priority_reason:
          'Review urgency is based on the detected signal, not proven interchangeability or causal effectiveness.',
        confidence: result.classification === 'EXACT_DUPLICATE' ? 'MEDIUM' : 'LOW',
        confidence_reason:
          'Package equality is deterministic; lexical and conflict signals remain unverified interpretations.',
        evidence: [
          { kind: 'skill_version', id: a.version_id },
          { kind: 'skill_version', id: b.version_id },
        ],
        limitations,
        explanation: result.matched_signals.join(' '),
        suggested_action:
          'Inspect exact versions, resources, triggers and evaluation evidence. Only a separately authorized reviewed workflow may consolidate or change skills.',
        comparison,
      }),
    );
  }
  coverage.pairs_truncated = retrieval.truncated;
  coverage.features_truncated = features.some((f) => f.truncated);
  if (drafts.length > 60) coverage.recommendations_truncated = true;
  return {
    drafts: drafts.slice(0, 60),
    source_digest: curatorDigest([DETECTION_POLICY, FEATURE_POLICY, rows, features, p, request]),
    coverage,
    comparisons,
    feature_writes: featureWrites,
    pair_writes: pairWrites,
    eligible_version_ids: rows.map((r) => r.version_id),
    statistics: {
      skills: rows.length,
      pair_count: retrieval.pairs.length,
      feature_cache_hits: featureHits,
      pair_cache_hits: pairHits,
      feature_ms: extracted - start,
      retrieval_ms: retrieved - extracted,
      scoring_ms: performance.now() - retrieved,
      peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
    },
  };
}

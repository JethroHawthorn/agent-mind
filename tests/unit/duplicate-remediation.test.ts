import { afterEach, expect, it } from 'vitest';
import { retrievePairs, scorePair } from '../../packages/core/src/curator/similarity/detect.js';
import {
  extractSkillFeatures,
  fingerprint,
} from '../../packages/core/src/curator/similarity/features.js';
import {
  classificationSchema,
  comparisonSchema,
  DETECTION_POLICY,
  duplicatePolicySchema,
  FEATURE_POLICY,
  suggestTriage,
} from '../../packages/core/src/curator/similarity/model.js';
import { hashSkillFiles, RecommendationService } from '../../packages/core/src/index.js';
import { files, retry } from '../helpers/duplicate-fixtures.js';
import { skillFixture } from '../helpers/skill-fixture.js';

const policy = duplicatePolicySchema.parse({});
const feature = (body = retry) => {
  const snapshot = files(body);
  return extractSkillFeatures(snapshot, hashSkillFiles(snapshot));
};
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
it('prioritizes rare features beyond the old hash-prefix cutoff in a dense corpus', () => {
  const base = feature();
  const common = Array.from({ length: 32 }, (_, i) => `common-${i}`);
  const corpus = Array.from({ length: 40 }, (_, i) => ({
    ...base,
    digest: `package-${i}`,
    instructions: `instructions-${i}`,
    shingles: [],
    tokens: [...common, i === 0 || i === 39 ? 'rare-shared' : `unique-${i}`],
  }));
  const result = retrievePairs(corpus, { ...policy, bucket_limit: 2 });
  expect(result.pairs).toContainEqual([0, 39]);
  expect(result.truncated).toBe(true);
  expect(result.pairs.length).toBeLessThanOrEqual(80);
  expect(retrievePairs(corpus, { ...policy, bucket_limit: 2 })).toEqual(result);
});
it('samples common lexical blocks instead of dropping all their candidate evidence', () => {
  const base = feature();
  const corpus = Array.from({ length: 40 }, (_, i) => ({
    ...base,
    digest: `package-${i}`,
    instructions: `instructions-${i}`,
    shingles: ['shared-shingle'],
    tokens: ['shared-token'],
  }));
  const result = retrievePairs(corpus, policy);
  expect(result.pairs.length).toBeGreaterThan(0);
  expect(result.truncated).toBe(true);
  expect(result.pairs.length).toBeLessThanOrEqual(40 * policy.bucket_limit);
});
it('retains global pair and neighbor bounds after IDF weighting', () => {
  const base = feature();
  const result = retrievePairs(
    Array.from({ length: 1000 }, () => base),
    { ...policy, max_pairs: 11 },
  );
  expect(result.pairs).toHaveLength(11);
  expect(new Set(result.pairs.map((p) => p.join(':'))).size).toBe(11);
  expect(result.truncated).toBe(true);
});
for (const [left, right] of [
  ['Must always use PostgreSQL.', 'Never use Postgres.'],
  ['Must enable write ahead logging.', 'Do not enable write ahead logging.'],
  ['Must install Kubernetes packages.', 'Never installing k8s packages.'],
  ['Always run node.js migration scripts.', 'Must not running nodejs migration scripts.'],
])
  it(`normalizes bounded directive variants: ${left}`, () => {
    const a = feature(`${retry}\n${left}`),
      b = feature(`${retry}\n${right}`);
    expect(scorePair(a, b, policy).classification).toBe('POSSIBLE_CONFLICT');
  });
for (const [left, right] of [
  ['Must use PostgreSQL.', 'Never deploy Postgres database.'],
  ['Must use PostgreSQL in production.', 'Never use Postgres in testing.'],
  ['Must use PostgreSQL.', 'Must not always use Postgres.'],
  ['Must use PostgreSQL.', 'Must never use Postgres.'],
  ['Must use PostgreSQL.', 'Never use Postgres unless approved.'],
])
  it(`does not invent equivalence for ambiguous or different actions: ${right}`, () => {
    expect(
      scorePair(feature(`${retry}\n${left}`), feature(`${retry}\n${right}`), policy).classification,
    ).not.toBe('POSSIBLE_CONFLICT');
  });
it('maps every classification to a non-authorizing human triage suggestion', () => {
  const expected = {
    EXACT_DUPLICATE: 'REVIEW_EXISTING_SKILL',
    NEAR_DUPLICATE: 'CONSIDER_UPDATE_EXISTING_SKILL',
    POSSIBLE_OVERLAP: 'CONSIDER_UPDATE_EXISTING_SKILL',
    POSSIBLE_CONFLICT: 'NEEDS_HUMAN_REVIEW',
    INSUFFICIENT_EVIDENCE: 'NEEDS_MORE_EVIDENCE',
    NOT_RELATED: 'CONSIDER_NEW_SKILL',
  };
  for (const classification of classificationSchema.options)
    expect(suggestTriage(classification)).toEqual({
      suggestion: expected[classification],
      authorization: 'NONE',
    });
});
it('preserves legacy v1 recommendation readability while invalidating v1 feature and pair caches', () => {
  const f = skillFixture();
  cleanup.push(f.close);
  const versions = ['legacy-left', 'legacy-right'].map((name) => {
    const id = f.identity(name),
      version = f.version(id, undefined, undefined, files(retry, name));
    f.evaluation(version);
    f.review(version);
    return version;
  });
  const service = new RecommendationService(f.db, f.scope);
  service.analyzeDuplicates();
  const original = service.list().recommendations[0];
  if (!original?.comparison) throw Error('fixture');
  const legacy = { ...original.comparison, policy_version: 'duplicate-signals-v1' as const };
  delete legacy.triage;
  expect(comparisonSchema.parse(legacy).policy_version).toBe('duplicate-signals-v1');
  const payload = JSON.parse(
    (
      f.db
        .prepare('SELECT payload_json FROM curator_recommendations WHERE id=?')
        .get(original.id) as { payload_json: string }
    ).payload_json,
  );
  payload.comparison = legacy;
  f.db
    .prepare('UPDATE curator_recommendations SET payload_json=? WHERE id=?')
    .run(JSON.stringify(payload), original.id);
  expect(service.get({ recommendation_id: original.id }).comparison?.policy_version).toBe(
    'duplicate-signals-v1',
  );
  const rows = f.db.prepare('SELECT * FROM curator_feature_cache').all() as Array<{
    project_id: string;
    digest: string;
    payload: string;
    checksum: string;
  }>;
  f.db.exec('DELETE FROM curator_feature_cache');
  for (const row of rows)
    f.db
      .prepare('INSERT INTO curator_feature_cache VALUES(?,?,?,?,?)')
      .run(row.project_id, row.digest, 'instruction-features-v1', row.payload, row.checksum);
  f.db.prepare("UPDATE curator_pair_cache SET fingerprint='old-policy-'||fingerprint").run();
  const result = service.analyzeDuplicates();
  expect(result.statistics.feature_cache_hits).toBe(0);
  expect(result.statistics.pair_cache_hits).toBe(0);
  expect(FEATURE_POLICY).toBe('instruction-features-v2');
  expect(DETECTION_POLICY).toBe('duplicate-signals-v2');
  const compared = service.compare({ left_version_id: versions[0], right_version_id: versions[1] });
  expect(compared.comparisons[0]?.triage?.authorization).toBe('NONE');
  expect(f.db.prepare('SELECT active_version_id FROM skills').all()).toEqual([
    { active_version_id: null },
    { active_version_id: null },
  ]);
  // Cache checksums still cover the payload rather than becoming authorization material.
  expect(rows.every((r) => fingerprint(r.payload) === r.checksum)).toBe(true);
});

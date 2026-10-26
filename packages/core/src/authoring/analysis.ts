import { scorePair } from '../curator/similarity/detect.js';
import { extractSkillFeatures } from '../curator/similarity/features.js';
import { DETECTION_POLICY, duplicatePolicySchema } from '../curator/similarity/model.js';
import type { SkillVersion } from '../skill-model.js';
import { hashSkillFiles } from '../skill-model.js';
/** Bounded reuse of P3-002 signals, never a routing decision or semantic proof. */
export function authoringWarnings(
  files: SkillVersion['files'],
  sources: Array<{ version: SkillVersion }>,
) {
  const features = extractSkillFeatures(files, hashSkillFiles(files));
  const internal_conflict = features.positive.some((hash) => features.negative.includes(hash));
  return {
    policy_version: DETECTION_POLICY,
    internal_conflict,
    comparisons: sources.slice(0, 3).map(({ version }) => {
      const result = scorePair(
        features,
        extractSkillFeatures(version.files, version.content_hash),
        duplicatePolicySchema.parse({}),
      );
      return {
        version_id: version.id,
        digest: version.content_hash,
        classification: result.classification,
        metrics: result.metrics,
        signals: result.matched_signals.slice(0, 3),
      };
    }),
    limitations:
      'Normalized lexical/polarity signals only. Comparing a patch with its own base is change review, not a claim of duplicate skill identities.',
  };
}

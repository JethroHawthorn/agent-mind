import type { DuplicatePolicy, Features, PairResult } from './model.js';
export function jaccard(a: string[], b: string[]) {
  const right = new Set(b);
  const common = a.filter((t) => right.has(t)).length;
  const union = new Set([...a, ...b]).size;
  return union ? common / union : 0;
}
export function scorePair(a: Features, b: Features, p: DuplicatePolicy): PairResult {
  const token = jaccard(a.tokens, b.tokens),
    shingle = jaccard(a.shingles, b.shingles);
  const sections = a.sections.filter(
    (s, i) => s.length >= 3 && jaccard(s, b.sections[i] ?? []) >= 0.5,
  ).length;
  const signals: string[] = [];
  let classification: PairResult['classification'] = 'NOT_RELATED';
  let strength: PairResult['evidence_strength'] = 'LEXICAL';
  if (a.digest === b.digest) {
    classification = 'EXACT_DUPLICATE';
    strength = 'PACKAGE_IDENTITY';
    signals.push('Identical canonical ordered package path/content snapshots.');
  } else if (a.tokens.length < 6 || b.tokens.length < 6) {
    classification = 'INSUFFICIENT_EVIDENCE';
    strength = 'INSUFFICIENT';
    signals.push('Too few substantive tokens after removing metadata and headings.');
  } else {
    const conflict =
      a.positive.some((v) => b.negative.includes(v)) ||
      b.positive.some((v) => a.negative.includes(v));
    if (conflict && token >= p.overlap_threshold) {
      classification = 'POSSIBLE_CONFLICT';
      signals.push('Matching imperative complement appears with opposite mandatory polarity.');
    } else if (a.instructions === b.instructions && a.resources !== b.resources) {
      classification = 'POSSIBLE_OVERLAP';
      signals.push(
        'Identical canonical substantive instructions; supporting-resource snapshots differ.',
      );
    } else if (shingle >= p.near_threshold && token >= p.near_threshold) {
      classification = 'NEAR_DUPLICATE';
      signals.push(
        'Substantive ordered token triples and vocabulary exceed the versioned near threshold.',
      );
    } else if (sections >= 2 && token >= p.overlap_threshold) {
      classification = 'POSSIBLE_OVERLAP';
      signals.push('At least two aligned workflow sections share substantive vocabulary.');
    } else
      signals.push(
        'Title, template or vocabulary resemblance does not establish workflow overlap.',
      );
  }
  if (a.resources === b.resources)
    signals.push('Supporting-resource snapshots match (possibly both empty).');
  if (a.truncated || b.truncated)
    signals.push('Features were truncated; similarity is based on bounded samples.');
  return {
    classification,
    evidence_strength: strength,
    metrics: {
      token_jaccard: token,
      shingle_jaccard: shingle,
      matched_workflow_sections: sections,
    },
    matched_signals: signals,
  };
}
/** Frequency-ranked bounded retrieval. IDF is a retrieval weight, never a duplication probability. */
export function retrievePairs(features: Features[], p: DuplicatePolicy) {
  const blocks = new Map<string, number[]>();
  const keys = features.map((f) => [
    `p:${f.digest}`,
    `i:${f.instructions}`,
    ...f.shingles.map((t) => `s:${t}`),
    ...f.tokens.map((t) => `t:${t}`),
  ]);
  keys.forEach((terms, i) => {
    for (const key of new Set(terms)) {
      const ids = blocks.get(key) ?? [];
      ids.push(i);
      blocks.set(key, ids);
    }
  });
  const idf = (key: string) =>
    1 + Math.log((features.length + 1) / ((blocks.get(key)?.length ?? 0) + 1));
  const pairs = new Set<string>();
  let capped = false;
  for (let i = 0; i < features.length; i++) {
    const terms = keys[i] ?? [];
    const ranked = (prefix: string, limit: number) =>
      terms
        .filter((t) => t.startsWith(prefix))
        .sort((a, b) => idf(b) - idf(a) || a.localeCompare(b))
        .slice(0, limit);
    const selected = [...terms.slice(0, 2), ...ranked('s:', 24), ...ranked('t:', 12)];
    const neighbors = new Map<number, number>();
    for (const key of selected) {
      const bucket = blocks.get(key) ?? [];
      const strong = /^[pi]:/.test(key);
      let candidates = bucket;
      if (bucket.length > p.bucket_limit) {
        capped = true;
        // Stable local posting window: common terms are discounted, never dropped wholesale.
        let lo = 0,
          hi = bucket.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if ((bucket[mid] ?? 0) < i) lo = mid + 1;
          else hi = mid;
        }
        const start = Math.max(
          0,
          Math.min(bucket.length - p.bucket_limit, lo - Math.floor(p.bucket_limit / 2)),
        );
        candidates = bucket.slice(start, start + p.bucket_limit);
        if (strong && bucket[0] !== i) candidates = [bucket[0] as number, ...candidates];
      }
      const weight = strong ? 10000 : idf(key);
      for (const j of candidates) if (j !== i) neighbors.set(j, (neighbors.get(j) ?? 0) + weight);
    }
    const ordered = [...neighbors].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    if (ordered.length > p.bucket_limit) capped = true;
    for (const [j] of ordered.slice(0, p.bucket_limit)) {
      const key = `${Math.min(i, j)}:${Math.max(i, j)}`;
      if (pairs.has(key)) continue;
      if (pairs.size >= p.max_pairs) {
        capped = true;
        break;
      }
      pairs.add(key);
    }
  }
  return {
    pairs: [...pairs].map((s) => s.split(':').map(Number) as [number, number]),
    truncated: capped,
  };
}

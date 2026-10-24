import type { ExperienceContext } from './experience.js';

/** Fit the top preview without dropping its identity, trust labels or timestamps. */
export function fitTopExperience(
  preview: ExperienceContext,
  fits: (preview: ExperienceContext) => boolean,
): ExperienceContext {
  const candidate = {
    ...preview,
    outcome: { ...preview.outcome },
    evidence: [],
    provenance: {},
    content_truncated: true,
  };
  const clip = (value: string, size: number) => {
    if (size >= value.length) return value;
    if (size < 2) return '';
    // Do not return a dangling UTF-16 high surrogate when clipping Unicode text.
    let prefix = value.slice(0, size - 1);
    if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
    return `${prefix}…`;
  };
  const scaled = (scale: number): ExperienceContext => ({
    ...candidate,
    problem: clip(preview.problem, Math.floor((preview.problem.length * scale) / 1000)),
    solution: clip(preview.solution, Math.floor((preview.solution.length * scale) / 1000)),
    outcome: {
      ...preview.outcome,
      summary: clip(
        preview.outcome.summary,
        Math.floor((preview.outcome.summary.length * scale) / 1000),
      ),
    },
  });
  let low = 0;
  let high = 1000;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(scaled(middle))) low = middle;
    else high = middle - 1;
  }
  return scaled(low);
}

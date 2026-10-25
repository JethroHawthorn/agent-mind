import { type EvidenceCollection, evidenceWords } from './data.js';
import {
  type CuratorPolicy,
  draftRecommendationSchema,
  type EvidenceReference,
  type RecommendationDraft,
} from './model.js';
import { extractCuratorSignals } from './signals.js';

const COMMON = [
  'Observational associations do not establish skill causation or effectiveness.',
  'Instrumentation is incomplete; absence of reports is not success or obsolescence.',
  'Samples have selection bias; task labels are correlations, not independently proven tasks.',
  'Operator confirmations and local hooks inherit the undeployed SEC-01 same-user limitations.',
];
export function generateCuratorRecommendations(
  data: EvidenceCollection,
  policy: CuratorPolicy,
  asOf: string,
) {
  asOf = `${asOf.slice(0, 10)}T00:00:00.000Z`;
  const drafts: RecommendationDraft[] = [];
  for (const skill of data.skills) {
    const s = extractCuratorSignals(skill, data.events, asOf);
    const limitations = [
      ...COMMON,
      ...(s.uncertain_version
        ? ['A session references multiple versions; loaded artifact attribution is uncertain.']
        : []),
      ...(s.conflicting
        ? ['Success and failure were reported for the same task; no resolved outcome is inferred.']
        : []),
      ...(s.sampled.length === 24 ? ['At most 24 recent events per version are used.'] : []),
    ];
    const refs: EvidenceReference[] = [
      { kind: 'skill_version', id: skill.version_id },
      ...s.sampled.map((e) => ({ kind: 'usage' as const, id: e.event_id })),
    ];
    const confidence =
      s.attested_tasks >= policy.min_failures && !s.conflicting && !s.uncertain_version
        ? 'MEDIUM'
        : 'LOW';
    const add = (
      rule_id: string,
      type: RecommendationDraft['type'],
      explanation: string,
      priority: RecommendationDraft['priority'],
      evidence = refs,
      related_version_id?: string,
    ) => {
      const chosenConfidence = ['repeated-failures', 'convergent-opportunity'].includes(rule_id)
        ? confidence
        : 'LOW';
      drafts.push(
        draftRecommendationSchema.parse({
          skill_id: skill.skill_id,
          version_id: skill.version_id,
          rule_id,
          type,
          priority,
          priority_reason:
            priority === 'HIGH'
              ? 'Multiple operator-attested task labels plus convergent review signals warrant prompt investigation.'
              : priority === 'MEDIUM'
                ? 'Multiple distinct task labels or newer approved evidence warrant review.'
                : 'Sparse or indirect signals warrant information gathering, not a lifecycle change.',
          confidence: chosenConfidence,
          confidence_reason:
            chosenConfidence === 'MEDIUM'
              ? 'Repeated operator-attested task labels support an association; they do not prove reproducibility or causation.'
              : 'Evidence is sparse, reported, indirect, conflicting or uncertain; no effectiveness claim is supported.',
          evidence: [...new Map(evidence.map((e) => [`${e.kind}:${e.id}`, e])).values()],
          limitations,
          explanation,
          suggested_action:
            'Inspect the cited records and acceptance criteria. Gather controlled evidence and, if warranted, propose a separate candidate for normal evaluation and human review. No lifecycle action is authorized.',
          ...(related_version_id ? { related_version_id } : {}),
        }),
      );
    };
    if (policy.rules.failures) {
      if (
        s.attested_tasks >= policy.min_failures ||
        s.reported_tasks >= policy.min_failures ||
        s.failures.length >= policy.min_failures
      )
        add(
          'repeated-failures',
          'INVESTIGATE',
          `${s.attested.length} operator-attested and ${s.reported.length} other failure reports span ${s.independent_failure_tasks} task labels in this bounded version sample. Failure association is not evidence that the skill caused it.`,
          s.attested_tasks >= policy.min_failures && !s.conflicting ? 'MEDIUM' : 'LOW',
        );
      else if (s.unknown.length || !s.sampled.length)
        add(
          'outcome-evidence',
          'REVIEW',
          'No sufficient resolved outcome evidence exists in the bounded view. Unknown outcomes and missing telemetry are not failures or successes.',
          'LOW',
        );
    }
    const newer = skill.experience_ids.map((id) => ({ kind: 'experience' as const, id }));
    if (policy.rules.experiences && newer.length)
      add(
        'new-experiences',
        'REVIEW',
        `${newer.length} newer approved keyword-matching experience references are absent from this version's source list. Their information may already be covered; approval is not independent verification.`,
        'MEDIUM',
        [...refs.filter((r) => r.kind === 'skill_version'), ...newer],
      );
    const age = Date.parse(asOf) - Date.parse(skill.created_at);
    const maintained =
      Date.parse(asOf) - Date.parse(skill.maintained_at) < policy.maintenance_days * 86400000 ||
      (s.recentSuccess && s.observed_sessions >= policy.min_observed_sessions);
    if (
      policy.rules.stale &&
      age >= policy.stale_days * 86400000 &&
      !maintained &&
      (newer.length > 0 || s.independent_failure_tasks >= policy.min_failures)
    )
      add(
        'currency-review',
        'POSSIBLE_STALE',
        'Version age combined with newer approved experience or repeated failure signals warrants a currency review. Low usage alone was not used; the skill is not declared obsolete.',
        'LOW',
        [...refs, ...newer],
      );
    if (
      policy.rules.opportunity &&
      s.attested_tasks >= policy.min_failures &&
      newer.length &&
      s.evaluation_gap &&
      s.observed_sessions >= policy.min_observed_sessions &&
      !s.conflicting &&
      !s.uncertain_version
    )
      add(
        'convergent-opportunity',
        'IMPROVE',
        'Repeated operator-attested failures, newer approved experience, an evaluation gap and multiple observed session labels converge on an investigation opportunity. No version is declared better.',
        'HIGH',
        [
          ...refs,
          ...newer,
          ...(skill.evaluation_id
            ? [{ kind: 'evaluation' as const, id: skill.evaluation_id }]
            : []),
        ],
      );
  }
  if (policy.rules.overlap)
    for (let i = 0; i < data.skills.length; i++)
      for (let j = i + 1; j < data.skills.length; j++) {
        const a = data.skills[i],
          b = data.skills[j];
        if (!a || !b) continue;
        const left = new Set(evidenceWords(`${a.name} ${a.description}`)),
          right = new Set(evidenceWords(`${b.name} ${b.description}`));
        const intersection = [...left].filter((w) => right.has(w)).length;
        const shared = a.source_ids.filter((id) => b.source_ids.includes(id)).slice(0, 8);
        if (
          shared.length < 2 &&
          !(intersection >= 3 && intersection / new Set([...left, ...right]).size >= 0.6)
        )
          continue;
        drafts.push(
          draftRecommendationSchema.parse({
            skill_id: a.skill_id,
            version_id: a.version_id,
            related_version_id: b.version_id,
            rule_id: 'possible-overlap',
            type: 'POSSIBLE_DUPLICATE',
            priority: 'LOW',
            priority_reason:
              'Lexical/source overlap is an inexpensive review signal, not semantic equivalence.',
            confidence: 'LOW',
            confidence_reason:
              'Only deterministic token/source overlap was assessed; no semantic or behavioral equivalence is established.',
            evidence: [
              { kind: 'skill_version', id: a.version_id },
              { kind: 'skill_version', id: b.version_id },
              ...shared.map((id) => ({ kind: 'experience', id })),
            ],
            limitations: COMMON,
            explanation:
              'Two project skills share lexical metadata or source references. They are potential duplicates only; neither should be merged or deleted automatically.',
            suggested_action:
              'Compare exact scoped versions and source references manually. Preserve independent identities unless a later reviewed proposal is justified.',
          }),
        );
      }
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  drafts.sort(
    (a, b) =>
      rank[a.priority] - rank[b.priority] ||
      a.skill_id.localeCompare(b.skill_id) ||
      a.rule_id.localeCompare(b.rule_id) ||
      a.version_id.localeCompare(b.version_id),
  );
  if (drafts.length > policy.max_recommendations) data.coverage.recommendations_truncated = true;
  if (Object.values(data.coverage).some(Boolean))
    for (const draft of drafts)
      draft.limitations.push(
        'Source or output windows were truncated; absence claims and supersession are not complete.',
      );
  return drafts.slice(0, policy.max_recommendations);
}

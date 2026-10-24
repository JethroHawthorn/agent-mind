import type { SkillEvaluationCheck, SkillVersion } from './skill-model.js';
import { SKILL_VALIDATION_POLICY, validateSkillBundle } from './skill-validation.js';

export const SKILL_EVALUATOR = 'agentmind-deterministic';
export const SKILL_EVALUATOR_VERSION = `static-contract-v2/${SKILL_VALIDATION_POLICY}`;
export type EvaluationResult = 'PASS' | 'FAIL' | 'NOT_VERIFIED';
type Bundle = Pick<SkillVersion, 'files' | 'description' | 'content_hash'> & { name: string };

/** Fixed, code-owned data assertions. No user callbacks, scripts, modules or subprocesses. */
export function evaluateStaticContract(bundle: Bundle): SkillEvaluationCheck[] {
  const validation = validateSkillBundle({
    name: bundle.name,
    description: bundle.description,
    files: bundle.files,
  });
  const checks: SkillEvaluationCheck[] = [
    {
      name: 'scope.static-contract',
      result: 'PASS',
      details:
        'Only static Markdown contract checks. Task behavior, script execution and process isolation are NOT VERIFIED.',
    },
    {
      name: 'validation.current-policy',
      result: validation.validation_result === 'VALID' ? 'PASS' : 'FAIL',
      details:
        validation.validation_result === 'VALID'
          ? `Accepted by ${SKILL_VALIDATION_POLICY}.`
          : `Rejected by current policy: ${[...new Set(validation.issues.filter((issue) => issue.severity === 'error').map((issue) => issue.code))].join(', ').slice(0, 1500)}. Submitted text is omitted.`,
    },
  ];
  const skill = bundle.files.find((file) => file.path === 'SKILL.md')?.content ?? '';
  const body = skill.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  const sections = sectionText(body);
  for (const name of ['goal', 'when to use', 'procedure', 'verification']) {
    checks.push({
      name: `fixture.section.${name.replaceAll(' ', '-')}`,
      result: sections.get(name)?.trim() ? 'PASS' : 'FAIL',
      details:
        'Static contract requires this ATX section with nonempty prose outside code fences and comments.',
    });
  }
  return checks;
}

export function compareStaticRegression(
  candidate: Bundle,
  baseline: Bundle | null,
): SkillEvaluationCheck {
  if (!baseline)
    return {
      name: 'regression.active-baseline',
      result: 'PASS',
      details: 'No active baseline; comparison is not applicable.',
    };
  const current = evaluateStaticContract(candidate);
  const previous = evaluateStaticContract(baseline);
  if (previous.some((check) => check.result !== 'PASS')) {
    return {
      name: 'regression.active-baseline',
      result: 'NOT_VERIFIED',
      details:
        'Active baseline fails current static policy; comparison cannot certify regression safety.',
    };
  }
  if (current.some((check) => check.result !== 'PASS')) {
    return {
      name: 'regression.active-baseline',
      result: 'FAIL',
      details: 'Candidate fails a static contract satisfied by the active baseline.',
    };
  }
  if (
    candidate.content_hash === baseline.content_hash &&
    candidate.description === baseline.description
  ) {
    return {
      name: 'regression.active-baseline',
      result: 'PASS',
      details:
        'Identical snapshot and description; static contract unchanged. Task behavior remains unverified.',
    };
  }
  return {
    name: 'regression.active-baseline',
    result: 'NOT_VERIFIED',
    details:
      'Static checks pass but content changed. Behavioral regression is not verified by text comparison.',
  };
}

export function aggregateEvaluation(checks: SkillEvaluationCheck[]): EvaluationResult {
  if (checks.some((check) => check.result === 'FAIL')) return 'FAIL';
  if (!checks.length || checks.some((check) => check.result === 'NOT_VERIFIED'))
    return 'NOT_VERIFIED';
  return 'PASS';
}

function sectionText(body: string): Map<string, string> {
  let fence: string | undefined;
  let width = 0;
  let section: string | undefined;
  const sections = new Map<string, string>();
  for (const line of body.replace(/<!--[\s\S]*?(?:-->|$)/g, '').split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker?.[1]) {
      if (!fence) {
        fence = marker[1][0];
        width = marker[1].length;
      } else if (marker[1][0] === fence && marker[1].length >= width && !marker[2]?.trim())
        fence = undefined;
      continue;
    }
    if (fence || /^(?: {4}|\t)/.test(line)) continue;
    const heading = /^ {0,3}#{1,6} +(.+?)\s*#*\s*$/.exec(line);
    if (heading?.[1]) {
      // Normalize only a small, documented set of harmless heading decorations.
      // Anchored section lookup still rejects suffixes such as "Goal injection".
      section = heading[1]
        .trim()
        .toLowerCase()
        .replace(/^[0-9]+[.)][ \t]+/, '')
        .replace(/:[ \t]*$/, '')
        .replace(/[ \t]+/g, ' ')
        .trim();
      continue;
    }
    if (section && line.trim())
      sections.set(section, `${sections.get(section) ?? ''}\n${line.trim()}`);
  }
  return sections;
}

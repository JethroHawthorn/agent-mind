import { parseDocument } from 'yaml';
import { z } from 'zod';
import { sanitizeExperienceText } from '../experience-privacy.js';
import { assertSafeSummary } from '../privacy.js';
export const DISCOVERY_FEATURE_POLICY = 'discovery-features-v1';
export const HYBRID_POLICY = 'hybrid-selection-cards-v1';
const phrases = z.array(z.string().trim().min(1).max(100)).max(4);
const featureSchema = z.strictObject({
  aliases: phrases.default([]),
  triggers: phrases.default([]),
  languages: phrases.default([]),
  frameworks: phrases.default([]),
  preconditions: phrases.default([]),
  not_for: phrases.default([]),
  purpose: z.string().max(256).optional(),
  distinguishes: z.string().max(256).default(''),
});
export function discoveryPrefix(main: string) {
  const end = main.indexOf('\n---', 4);
  return end >= 0 && end <= 8196 ? main.slice(0, end) : '';
}
/** Pure extraction of declared immutable metadata, not a semantic/safety evaluator. */
export function discoveryFeatures(main: string, description: string) {
  const prefix = discoveryPrefix(main);
  let invalid = false;
  try {
    const document = parseDocument(prefix.replace(/^---\r?\n/, ''), {
      schema: 'failsafe',
      uniqueKeys: true,
      prettyErrors: false,
      logLevel: 'silent',
    });
    if (!prefix || document.errors.length || document.warnings.length) throw Error();
    const front = document.toJS({ maxAliasCount: 0 }),
      values: Record<string, unknown> = {};
    const allowed = new Set([
      'aliases',
      'triggers',
      'languages',
      'frameworks',
      'preconditions',
      'not_for',
      'purpose',
      'distinguishes',
    ]);
    for (const [key, value] of Object.entries(front.metadata ?? {})) {
      if (!key.startsWith('discovery.')) continue;
      const name = key.slice(10);
      if (!allowed.has(name) || typeof value !== 'string' || value.length > 256) throw Error();
      values[name] = ['purpose', 'distinguishes'].includes(name) ? value : JSON.parse(value);
    }
    const f = featureSchema.parse(values);
    const body = main.slice(prefix.length).replace(/^\n---\r?\n/, '');
    const section = (heading: string) => {
      const matches = [
        ...body.matchAll(
          new RegExp(`^#{1,6} +${heading} *\\r?\\n([\\s\\S]*?)(?=^#{1,6} |$(?![\\s\\S]))`, 'gmi'),
        ),
      ]
        .map((m) => m[1]?.trim() ?? '')
        .filter(Boolean);
      return matches;
    };
    const pre = [...f.preconditions, ...section('preconditions')],
      negative = [...f.not_for, ...section('when not to use')];
    const when = f.triggers.length ? f.triggers.join('; ') : section('when to use').join('\n');
    const compatibility = typeof front.compatibility === 'string' ? front.compatibility : '';
    if (compatibility) pre.push(compatibility);
    const complete =
      pre.length <= 4 &&
      negative.length <= 4 &&
      pre.every((x) => x.length <= 256) &&
      negative.every((x) => x.length <= 256) &&
      when.length <= 512;
    const all = [
      ...f.aliases,
      ...f.triggers,
      ...f.languages,
      ...f.frameworks,
      ...pre,
      ...negative,
      f.purpose ?? '',
      f.distinguishes,
      when,
    ];
    for (const value of all) {
      assertSafeSummary(value);
      if (
        sanitizeExperienceText(value).redacted ||
        [...value.replace(/[\n\r\t]/g, '')].some(
          (c) => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159),
        ) ||
        /\b(?:ignore|bypass|override)\b.{0,80}\b(?:system|developer|security|approval|permission)\b/i.test(
          value,
        )
      )
        throw Error();
    }
    const normalize = (s: string) =>
      s
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
    if (
      f.not_for.some((n) =>
        [...f.languages, ...f.frameworks].some((p) => normalize(p) === normalize(n)),
      )
    )
      throw Error();
    return {
      ...f,
      purpose: f.purpose ?? description,
      preconditions: pre,
      not_for: negative,
      when_to_use: when,
      complete,
      invalid: false,
      prefix,
      policy: DISCOVERY_FEATURE_POLICY,
    };
  } catch {
    invalid = true;
  }
  return {
    aliases: [],
    triggers: [],
    languages: [],
    frameworks: [],
    preconditions: [],
    not_for: [],
    purpose: description,
    distinguishes: '',
    when_to_use: '',
    complete: false,
    invalid,
    prefix,
    policy: DISCOVERY_FEATURE_POLICY,
  };
}
export type DiscoveryFeatures = ReturnType<typeof discoveryFeatures>;

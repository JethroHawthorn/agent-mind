import { createHash } from 'node:crypto';
import { redactSecrets } from '../../privacy.js';
import { hashSkillFiles, skillFilesSchema } from '../../skill-model.js';
import type { Features } from './model.js';
export const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex');
const stop = new Set(
  'the a an and or of to for in on is are be with this that skill instructions procedure verification goal when use input output steps required must should do not never always'.split(
    ' ',
  ),
);
function words(text: string) {
  return (
    redactSecrets(text)
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}_-]+/gu) ?? []
  ).filter((w) => w.length > 2 && !stop.has(w));
}
const hashes = (values: string[], max: number) =>
  [...new Set(values.map((v) => fingerprint(v).slice(0, 16)))].sort().slice(0, max);
/** Deliberately narrow inflections/aliases; different actions, flags and environments stay distinct. */
export function normalizeAction(text: string) {
  const aliases: Record<string, string> = {
    postgresql: 'postgres',
    postgres: 'postgres',
    'node.js': 'nodejs',
    k8s: 'kubernetes',
    uses: 'use',
    used: 'use',
    using: 'use',
    enables: 'enable',
    enabled: 'enable',
    enabling: 'enable',
    disables: 'disable',
    disabled: 'disable',
    disabling: 'disable',
    deploys: 'deploy',
    deployed: 'deploy',
    deploying: 'deploy',
    installs: 'install',
    installed: 'install',
    installing: 'install',
    runs: 'run',
    running: 'run',
    tests: 'test',
    tested: 'test',
    testing: 'test',
    writes: 'write',
    writing: 'write',
    written: 'write',
    reads: 'read',
    reading: 'read',
    requires: 'require',
    required: 'require',
    requiring: 'require',
  };
  return redactSecrets(text)
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/^always\s+/, '')
    .replace(/[.!]+$/, '')
    .split(/\s+/)
    .map((word) => aliases[word] ?? word)
    .join(' ');
}
/** Parses bounded snapshots as data. No includes, links, YAML objects, filesystem or executable code are evaluated. */
export function extractSkillFeatures(input: unknown, expectedDigest: string): Features {
  const files = skillFilesSchema.parse(input);
  if (hashSkillFiles(files) !== expectedDigest) throw new Error('artifact integrity');
  const skill = files.find((f) => f.path === 'SKILL.md')?.content ?? '';
  const front = skill.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  if (!front) throw new Error('frontmatter unavailable');
  const body = skill.slice(front[0].length);
  const sections: string[][] = Array.from({ length: 5 }, () => []);
  const substantive: string[] = [];
  const positive: string[] = [];
  const negative: string[] = [];
  let section = 0;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) {
      const heading = line.toLowerCase();
      section = /when|trigger|purpose|goal/.test(heading)
        ? 0
        : /input|prerequis/.test(heading)
          ? 1
          : /output|result/.test(heading)
            ? 2
            : /verif|test/.test(heading)
              ? 4
              : 3;
      continue;
    }
    const normalized = line.replace(/^\s*(?:[-*]|\d+\.)\s*/, '').trim();
    if (
      /^(?:follow best practices|use existing code|verify changes|follow repository conventions|check the results)[.!]?$/i.test(
        normalized,
      )
    )
      continue;
    const mandate = normalized
      .normalize('NFKC')
      .toLowerCase()
      .match(/^(must not|never|do not|must|always)\s+(.+?)[.!]?$/);
    if (mandate) {
      const action = normalizeAction(mandate[2] ?? '');
      // An embedded negation is not safely interpreted as another positive/negative assertion.
      if (
        action &&
        !(/not|never/.test(mandate[1] ?? '') && /^always\b/.test(mandate[2] ?? '')) &&
        !/\b(?:not|never|unless|except|cannot)\b/.test(action)
      )
        (/not|never/.test(mandate[1] ?? '') ? negative : positive).push(action);
    }
    const tokens = words(normalized);
    if (tokens.length < 3) continue;
    substantive.push(normalized.normalize('NFKC').toLowerCase().replace(/\s+/g, ' '));
    sections[section]?.push(...tokens);
  }
  const tokens = substantive.flatMap(words);
  const shingles = tokens
    .slice(0, 4096)
    .flatMap((_, i, a) => (i + 3 <= a.length ? [a.slice(i, i + 3).join(' ')] : []));
  return {
    digest: expectedDigest,
    instructions: fingerprint(substantive.join('\n')),
    resources: fingerprint(
      JSON.stringify(
        files.filter((f) => f.path !== 'SKILL.md').sort((a, b) => (a.path < b.path ? -1 : 1)),
      ),
    ),
    tokens: hashes(tokens, 64),
    shingles: hashes(shingles, 96),
    sections: sections.map((s) => hashes(s, 24)),
    positive: hashes(positive, 16),
    negative: hashes(negative, 16),
    truncated:
      tokens.length > 4096 ||
      new Set(tokens).size > 64 ||
      new Set(shingles).size > 96 ||
      sections.some((s) => new Set(s).size > 24),
  };
}

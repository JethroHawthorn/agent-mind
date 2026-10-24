import { isAlias, isNode, isPair, isScalar, parseDocument, visit } from 'yaml';
import { z } from 'zod';
import { AgentMindError } from './errors.js';
import { sanitizeExperienceText } from './experience-privacy.js';
import { assertSafeSummary } from './privacy.js';
import { hashSkillFiles, skillFilesSchema, skillNameSchema } from './skill-model.js';

export const SKILL_VALIDATION_POLICY = 'agentmind-markdown-v1';
const bundleSchema = z.strictObject({
  name: skillNameSchema,
  description: z.string().trim().min(1).max(1024),
  files: skillFilesSchema,
});
const frontmatterSchema = z.strictObject({
  name: skillNameSchema,
  description: z.string().trim().min(1).max(1024),
  license: z.string().trim().min(1).max(200).optional(),
  compatibility: z.string().trim().min(1).max(500).optional(),
  metadata: z
    .record(
      z
        .string()
        .min(1)
        .max(100)
        .refine((key) => !['__proto__', 'constructor', 'prototype'].includes(key)),
      z.string().max(256),
    )
    .refine((data) => Object.keys(data).length <= 16)
    .optional(),
});

export type SkillValidationIssue = {
  code: string;
  severity: 'error' | 'warning';
  message: string;
};

/** Diagnostics deliberately contain no submitted text, secret values, paths or YAML errors. */
export function validateSkillBundle(input: unknown) {
  const issues: SkillValidationIssue[] = [];
  let issueCount = 0;
  let invalid = false;
  const add = (code: string, message: string, severity: 'error' | 'warning' = 'error') => {
    issueCount++;
    invalid ||= severity === 'error';
    if (issues.length < 64) issues.push({ code, severity, message });
  };
  const result = () => ({
    policy_version: SKILL_VALIDATION_POLICY,
    validation_result: invalid ? ('INVALID' as const) : ('VALID' as const),
    evaluation_result: 'NOT_VERIFIED' as const,
    issues,
    issues_truncated: issueCount > issues.length,
    untrusted_data: true as const,
  });
  const parsed = bundleSchema.safeParse(input);
  if (!parsed.success) {
    add('INVALID_INPUT', 'Invalid skill metadata, file paths, file count or content size limits.');
    return { ...result(), content_hash: null };
  }
  const bundle = parsed.data;
  const scan = (value: string) => {
    // Scan a normalized view only; immutable content and its hash are never rewritten.
    const text = value
      .normalize('NFKC')
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '');
    const assignments = text.replace(
      /["'](password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization|token|secret|cookie|aws_secret_access_key)["']\s*:\s*["']?/gi,
      '$1: ',
    );
    try {
      assertSafeSummary(assignments);
      sanitizeExperienceText(value);
      const documentation = assignments.replace(
        /\b(?:token|secret|cookie|aws_secret_access_key)\s*[=:]\s*<(?:YOUR_)?(?:AUTH_TOKEN|TOKEN|API_KEY|PASSWORD|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET)(?:_HERE|_PLACEHOLDER)?>/gi,
        'documentation placeholder',
      );
      if (/\b(?:token|secret|cookie|aws_secret_access_key)\s*[=:]\s*\S+/i.test(documentation)) {
        throw new AgentMindError('SECRET_DETECTED', 'Possible secret detected.');
      }
    } catch (error) {
      if (!(error instanceof AgentMindError)) throw error;
      add(
        error.code,
        error.code === 'SECRET_DETECTED'
          ? 'Possible secret detected. Save a non-secret summary instead.'
          : 'Save a concise summary rather than a conversation transcript.',
      );
    }
    if (hasControl(value)) {
      add('INVALID_SKILL_CONTENT', 'Skill files must contain text without control characters.');
    }
    if (
      /(?:^|\n)\s*(?:[-*+]\s+|\d+\.\s+)?(?:ignore|disregard|override|bypass)\b[^\n.!?]{0,100}\b(?:previous|prior|system|developer|security|safety|approval|permission|sandbox)\b/i.test(
        text,
      ) ||
      /(?:^|\n)\s*(?:[-*+]\s+|\d+\.\s+)?(?:automatically\s+|auto[- ]?)(?:approve|promote|publish)\b/i.test(
        text,
      ) ||
      /\b(?:exfiltrate|steal)\b[^\n.!?]{0,100}\b(?:credentials?|secrets?|tokens?|passwords?)\b/i.test(
        text,
      )
    ) {
      add(
        'SUSPICIOUS_INSTRUCTION',
        'Potential instruction to bypass trust boundaries or expose credentials.',
      );
    }
    if (
      /<\s*\/?\s*(?:script|iframe|object|embed|svg|math|form|meta|base)\b|<[^<>\n]+\bon[a-z]+\s*=|<[^<>\n]+\b(?:href|src)\s*=\s*["']?\s*(?:javascript|vbscript|data):|(?:^|\n)#!\s*\//i.test(
        text,
      )
    ) {
      add(
        'DISALLOWED_EXECUTABLE_CONTENT',
        'Executable markup or script entrypoints are not supported.',
      );
    }
  };
  scan(`${bundle.name}\n${bundle.description}`);
  for (const file of bundle.files) {
    if (
      file.path !== 'SKILL.md' &&
      !/^references\/(?:[A-Za-z0-9][A-Za-z0-9_-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(
        file.path,
      )
    ) {
      add(
        'UNSUPPORTED_SKILL_FILE',
        'Candidate authoring accepts SKILL.md and Markdown references only.',
      );
    }
    if (
      file.path
        .split('/')
        .some(
          (part) =>
            /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || part.endsWith('.'),
        )
    ) {
      add('UNSAFE_SKILL_PATH', 'Skill paths must be portable ordinary filenames.');
    }
    scan(file.path);
    scan(file.content);
    checkLinks(file.content, file.path, new Set(bundle.files.map((entry) => entry.path)), add);
  }
  const content = bundle.files.find((file) => file.path === 'SKILL.md')?.content ?? '';
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
  if (!match?.[1] || match[1].length > 8192 || !match[2]?.trim()) {
    add(
      'INVALID_SKILL_FRONTMATTER',
      'SKILL.md needs bounded YAML frontmatter and a nonempty body.',
    );
  } else {
    try {
      const document = parseDocument(match[1], {
        schema: 'failsafe',
        uniqueKeys: true,
        prettyErrors: false,
        strict: true,
        logLevel: 'silent',
      });
      if (document.errors.length || document.warnings.length) throw new Error('invalid YAML');
      visit(document, (_key, node) => {
        if (
          isAlias(node) ||
          (isNode(node) && (node.anchor || node.tag)) ||
          (isPair(node) &&
            isScalar(node.key) &&
            ['__proto__', 'constructor', 'prototype'].includes(String(node.key.value)))
        )
          throw new Error('unsupported YAML');
      });
      const metadata = frontmatterSchema.parse(document.toJS({ maxAliasCount: 0 }));
      if (metadata.name !== bundle.name || metadata.description !== bundle.description)
        throw new Error('metadata mismatch');
      // YAML escape sequences and folded scalars must be checked after decoding too.
      for (const value of [
        metadata.name,
        metadata.description,
        metadata.license,
        metadata.compatibility,
      ]) {
        if (value !== undefined) scan(value);
      }
      for (const [key, value] of Object.entries(metadata.metadata ?? {})) {
        scan(key);
        scan(value);
        scan(`${key}: ${value}`);
      }
    } catch {
      add(
        'INVALID_SKILL_FRONTMATTER',
        'Invalid, unsupported or mismatched Agent Skills frontmatter.',
      );
    }
    // Also check recognizable JSON transcript bodies without collecting transcript files.
    scan(match[2]);
    const body = proseWithoutFences(match[2]);
    for (const section of ['goal', 'when to use', 'procedure', 'verification']) {
      const heading = new RegExp(`^ {0,3}#{1,6} +${section} *(?:#+ *)?$`, 'im');
      if (!heading.test(body))
        add('MISSING_RECOMMENDED_SECTION', `Consider adding a ${section} section.`, 'warning');
    }
  }
  return { ...result(), content_hash: hashSkillFiles(bundle.files) };
}

/** Existing Phase 2 ingestion errors remain stable; diagnostics never echo rejected content. */
export function assertValidSkillBundle(input: unknown) {
  const report = validateSkillBundle(input);
  const issue = report.issues.find((item) => item.severity === 'error');
  if (issue) throw new AgentMindError(issue.code, issue.message);
  return report;
}

function proseWithoutFences(content: string): string {
  let fence: string | undefined;
  let length = 0;
  return content
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .split(/\r?\n/)
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (marker?.[1]) {
        const char = marker[1][0];
        if (!fence) {
          fence = char;
          length = marker[1].length;
        } else if (char === fence && marker[1].length >= length && !marker[2]?.trim())
          fence = undefined;
        return '';
      }
      return fence ? '' : line;
    })
    .join('\n');
}

function checkLinks(
  content: string,
  path: string,
  files: Set<string>,
  add: (code: string, message: string) => void,
) {
  // Best-effort Markdown link checks, not a Markdown renderer or an execution boundary.
  const targets: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = content.indexOf('](', cursor);
    if (start === -1) break;
    const end = content.indexOf(')', start + 2);
    if (end === -1) break;
    const target = content.slice(start + 2, end);
    if (!target.includes('\n')) targets.push(target);
    cursor = end + 1;
  }
  for (const match of content.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]*>|\S+)/gm)) {
    targets.push(match[1] ?? '');
  }
  for (const value of targets) {
    let target: string;
    try {
      const raw = value.trim();
      const href = raw.startsWith('<')
        ? raw.slice(1, raw.indexOf('>'))
        : (raw.split(/\s/, 1)[0] ?? '');
      target = decodeURIComponent(href);
    } catch {
      add('UNSAFE_SKILL_REFERENCE', 'Malformed or unsafe skill reference.');
      continue;
    }
    if (target.startsWith('#') || /^https?:\/\//i.test(target)) continue;
    const local = target.split(/[?#]/)[0] ?? '';
    if (
      !local ||
      /[:\\\s]/.test(local) ||
      hasControl(local) ||
      local.startsWith('/') ||
      local.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      add(
        'UNSAFE_SKILL_REFERENCE',
        'Skill references must use safe relative paths or inert HTTP(S) URLs.',
      );
      continue;
    }
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    if (!files.has(`${parent}${local}`))
      add('MISSING_SKILL_REFERENCE', 'A local skill reference is absent from the snapshot.');
  }
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true;
  }
  return false;
}

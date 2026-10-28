import { AgentMindError } from './errors.js';

const secretPatterns = [
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/i,
  /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/,
  /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/,
  /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  // A fixed delimiter avoids quadratic scheme backtracking on long skill text.
  /:\/\/[^\s/:]+:[^\s/@]+@/i,
];
// Shared credential vocabulary. Detection is heuristic, never a complete DLP policy.
const credentialLabel = `(?:github[_ -]?token|openai[_ -]?api[_ -]?key|anthropic[_ -]?api[_ -]?key|gemini[_ -]?api[_ -]?key|id[_ -]?token|password|passwd|passphrase|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|session[_ -]?token|client[_ -]?secret|proxy[_ -]?authorization|authorization|private[_ -]?key|aws[_ -]?secret[_ -]?access[_ -]?key|aws[_ -]?session[_ -]?token|cookie|set[_ -]?cookie|token|secret)`;
const credentialValues = [
  new RegExp(String.raw`\b${credentialLabel}["']?\s*[=:]\s*\S+`, 'i'),
  /\bBearer\s+(?:[A-Za-z0-9._~+/-]{8,}|<[^>]+>)/i,
];

/** Only recognizable transcript exports; arbitrary prose/PII cannot be classified perfectly. */
export function assertNoTranscript(value: string): void {
  if (/(?:^|\n)\s*(?:user|assistant|system|human)\s*:\s*\S/i.test(value))
    throw new AgentMindError(
      'TRANSCRIPT_REJECTED',
      'Record a short experience summary, not a transcript.',
    );
  try {
    const parsed: unknown = JSON.parse(value);
    const messages = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && 'messages' in parsed
        ? parsed.messages
        : undefined;
    if (
      Array.isArray(messages) &&
      messages.some(
        (item) => item && typeof item === 'object' && 'role' in item && 'content' in item,
      )
    )
      throw new AgentMindError(
        'TRANSCRIPT_REJECTED',
        'Record a short experience summary, not a transcript.',
      );
  } catch (error) {
    if (error instanceof AgentMindError) throw error;
  }
}

/** Redacted display/capture text; never rewrite immutable packages or claim complete secret detection. */
export function redactSecrets(value: string): string {
  let text = value.replace(
    /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )*PRIVATE KEY-----|$)/gi,
    '[REDACTED]',
  );
  // Remove bearer values before generic assignments so "Authorization: Bearer"
  // cannot consume the prefix and leave the credential behind.
  text = text.replace(/\bBearer\s+(?:[A-Za-z0-9._~+/-]+|<[^>]+>)/gi, '[REDACTED]');
  for (const pattern of secretPatterns) {
    text = text.replace(new RegExp(pattern.source, `${pattern.flags}g`), '[REDACTED]');
  }
  // Header values may contain multiple cookies or non-Bearer authentication schemes.
  text = text.replace(
    /\b(?:cookie|set-cookie|authorization|proxy-authorization)\s*:\s*[^\r\n]+/gi,
    '[REDACTED]',
  );
  return text.replace(
    new RegExp(
      String.raw`\b${credentialLabel}["']?\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)`,
      'gi',
    ),
    '[REDACTED]',
  );
}

/** Best-effort rejection; callers must still save only deliberate, non-secret summaries. */
export function assertSafeSummary(text: string): void {
  // Exempt only explicit angle-bracket documentation placeholders in value
  // positions. Scan vendor keys in the original text so wrappers cannot hide keys.
  const documentation = text.replace(
    new RegExp(
      String.raw`\b(?:Bearer\s+|${credentialLabel}["']?\s*[=:]\s*)(?:Bearer\s+)?<(?:YOUR_)?(?:AUTH_TOKEN|TOKEN|API_KEY|PASSWORD|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|SECRET|COOKIE|PRIVATE_KEY|PASSPHRASE)(?:_HERE|_PLACEHOLDER)?>`,
      'gi',
    ),
    'documentation placeholder',
  );
  if (
    secretPatterns.some((pattern) => pattern.test(text)) ||
    credentialValues.some((pattern) => pattern.test(documentation))
  ) {
    throw new AgentMindError(
      'SECRET_DETECTED',
      'Possible secret detected. Save a non-secret summary instead.',
    );
  }
  assertNoTranscript(text);
}

const sensitiveKeys = new Set([
  'password',
  'passwd',
  'passphrase',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'sessiontoken',
  'idtoken',
  'authorization',
  'proxyauthorization',
  'clientsecret',
  'cookie',
  'setcookie',
  'secret',
  'token',
  'credentials',
  'privatekey',
  'awssecretaccesskey',
  'awsaccesskeyid',
  'awssessiontoken',
  'anthropicapikey',
  'openaiapikey',
  'geminiapikey',
  'githubtoken',
  'xapikey',
  'xauthtoken',
]);
export function sensitiveField(key: string): boolean {
  return sensitiveKeys.has(
    key
      .normalize('NFKC')
      .replace(/[\p{Cc}\p{Cf}]/gu, '')
      .replace(/[^a-z0-9]/gi, '')
      .toLowerCase(),
  );
}
/** View-only structured redaction, bounded for cycles/depth/node count. Canonical input is untouched.
 * Stable protocol keys may be preserved by callers; sensitive values are still removed.
 */
export function redactSensitiveValue(value: unknown, redactKeys = false): unknown {
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  function visit(input: unknown, depth: number): unknown {
    if (++nodes > 10000 || depth > 32) return '[REDACTION_LIMIT]';
    if (typeof input === 'string') return redactSecrets(input);
    if (!input || typeof input !== 'object') return input;
    if (ancestors.has(input)) return '[CIRCULAR]';
    ancestors.add(input);
    try {
      if (Array.isArray(input))
        return input.length > 10000 ? '[REDACTION_LIMIT]' : input.map((x) => visit(x, depth + 1));
      if (Object.keys(input).length > 10000) return '[REDACTION_LIMIT]';
      return Object.fromEntries(
        Object.entries(input).map(([key, child]) => [
          redactKeys ? redactSecrets(key) : key,
          sensitiveField(key) &&
          !(
            key.toLowerCase() === 'authorization' &&
            ['NONE', 'os-peer-operator-v2', 'separate-reviewed-budget-required'].includes(
              String(child),
            )
          )
            ? '[REDACTED]'
            : visit(child, depth + 1),
        ]),
      );
    } finally {
      ancestors.delete(input);
    }
  }
  return visit(value, 0);
}

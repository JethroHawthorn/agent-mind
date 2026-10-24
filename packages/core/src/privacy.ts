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
const credentialValues = [
  /\b(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization)\s*[=:]\s*\S+/i,
  /\bBearer\s+(?:[A-Za-z0-9._~+/-]{8,}|<[^>]+>)/i,
];

/** Experience-only redaction. Phase 0 memory saves retain their rejection behavior. */
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
  return text.replace(
    /\b(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization|token|secret|cookie|aws_secret_access_key)["']?\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
    '[REDACTED]',
  );
}

/** Best-effort rejection; callers must still save only deliberate, non-secret summaries. */
export function assertSafeSummary(text: string): void {
  // Exempt only explicit angle-bracket documentation placeholders in value
  // positions. Scan vendor keys in the original text so wrappers cannot hide keys.
  const documentation = text.replace(
    /\b(?:Bearer\s+|(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization)\s*[=:]\s*)(?:Bearer\s+)?<(?:YOUR_)?(?:AUTH_TOKEN|TOKEN|API_KEY|PASSWORD|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET)(?:_HERE|_PLACEHOLDER)?>/gi,
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
  if (/(?:^|\n)\s*(?:user|assistant|system|human)\s*:\s*\S/i.test(text)) {
    throw new AgentMindError(
      'TRANSCRIPT_REJECTED',
      'Save a concise fact or decision rather than a conversation transcript.',
    );
  }
}

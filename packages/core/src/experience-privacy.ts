import { assertNoTranscript, redactSecrets } from './privacy.js';
export function sanitizeExperienceText(value: string): { text: string; redacted: boolean } {
  assertNoTranscript(value);
  const text = redactSecrets(value);
  return { text, redacted: text !== value };
}

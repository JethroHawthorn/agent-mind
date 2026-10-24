import { AgentMindError } from './errors.js';
import { redactSecrets } from './privacy.js';

export function sanitizeExperienceText(value: string): { text: string; redacted: boolean } {
  if (/(?:^|\n)\s*(?:user|assistant|system|human)\s*:\s*\S/i.test(value)) {
    throw new AgentMindError(
      'TRANSCRIPT_REJECTED',
      'Record a short experience summary, not a transcript.',
    );
  }
  // Reject recognizable JSON message exports without reading any transcript files.
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
        (item: unknown) => item && typeof item === 'object' && 'role' in item && 'content' in item,
      )
    ) {
      throw new AgentMindError(
        'TRANSCRIPT_REJECTED',
        'Record a short experience summary, not a transcript.',
      );
    }
  } catch (error) {
    if (error instanceof AgentMindError) throw error;
  }
  const text = redactSecrets(value);
  return { text, redacted: text !== value };
}

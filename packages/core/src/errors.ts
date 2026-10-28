import { redactSecrets } from './privacy.js';
export class AgentMindError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentMindError';
  }
}

// Never include raw SQLite errors, user content, paths or validation inputs in logs.
export function safeError(error: unknown): { code: string; message: string } {
  return error instanceof AgentMindError
    ? {
        code: /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'INTERNAL_ERROR',
        message: redactSecrets(error.message)
          .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
          .slice(0, 512),
      }
    : {
        code: 'INTERNAL_ERROR',
        message: 'AgentMind operation failed; check local storage and configuration.',
      };
}

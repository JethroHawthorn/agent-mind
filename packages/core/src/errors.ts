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
    ? { code: error.code, message: error.message }
    : {
        code: 'INTERNAL_ERROR',
        message: 'AgentMind operation failed; check local storage and configuration.',
      };
}

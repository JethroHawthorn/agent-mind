import { z } from 'zod';
import { AgentMindError } from './errors.js';

/** Call inside the write transaction, using the persisted state's current timestamp. */
export function nextTimestamp(previous?: string, wallClock = Date.now()): string {
  if (previous !== undefined && !z.iso.datetime({ precision: 3 }).safeParse(previous).success) {
    throw new AgentMindError('INVALID_TIMESTAMP', 'Expected a canonical UTC timestamp.');
  }
  const milliseconds = Math.max(
    wallClock,
    previous === undefined ? -Infinity : Date.parse(previous) + 1,
  );
  if (
    !Number.isFinite(milliseconds) ||
    !Number.isSafeInteger(milliseconds) ||
    Math.abs(milliseconds) > 8640000000000000
  ) {
    throw new AgentMindError('INVALID_TIMESTAMP', 'Cannot generate a valid lifecycle timestamp.');
  }
  const timestamp = new Date(milliseconds).toISOString();
  if (!z.iso.datetime({ precision: 3 }).safeParse(timestamp).success) {
    throw new AgentMindError(
      'INVALID_TIMESTAMP',
      'Lifecycle timestamp is outside the supported range.',
    );
  }
  return timestamp;
}

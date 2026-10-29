import { z } from 'zod';
/** Provenance only. A source label is never authorization or outcome verification. */
export const sourceAgentSchema = z.enum(['codex', 'claude', 'gemini', 'antigravity', 'unknown']);
export type SourceAgent = z.infer<typeof sourceAgentSchema>;

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { AgentMindError, resolveProject } from '@agentmind/core';

export function readConfig(args = process.argv.slice(2)) {
  try {
    const { values } = parseArgs({
      args,
      options: {
        'project-root': { type: 'string' },
        db: { type: 'string' },
        'project-key': { type: 'string' },
        'source-agent': { type: 'string', default: 'unknown' },
        health: { type: 'boolean', default: false },
        'disable-experience-capture': { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (!values['project-root']) throw new Error('missing root');
    const dbPath = values.db ?? join(homedir(), '.agentmind', 'agentmind.db');
    if (!isAbsolute(dbPath)) throw new Error('absolute database path required');
    const sourceAgent = values['source-agent'];
    if (sourceAgent !== 'codex' && sourceAgent !== 'claude' && sourceAgent !== 'unknown')
      throw new Error('invalid source');
    return {
      project: resolveProject(values['project-root'], process.cwd(), values['project-key']),
      dbPath,
      sourceAgent: sourceAgent as 'codex' | 'claude' | 'unknown',
      health: values.health,
      captureEnabled: !values['disable-experience-capture'],
    };
  } catch (error) {
    if (error instanceof AgentMindError) throw error;
    throw new AgentMindError(
      'INVALID_CONFIG',
      'Use --project-root /absolute/project [--project-key trusted-stable-key] [--db /absolute/memory.db] [--source-agent codex|claude|unknown] [--disable-experience-capture] [--health].',
    );
  }
}

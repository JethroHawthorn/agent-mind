import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { AgentMindError } from './errors.js';

export type ProjectScope = Readonly<{ id: string; root: string }>;

/** Only call with trusted startup configuration, never MCP arguments or client roots. */
export function resolveProject(
  root: string,
  cwd = process.cwd(),
  projectKey?: string,
): ProjectScope {
  try {
    if (!isAbsolute(root)) throw new Error('absolute directory required');
    const canonicalRoot = realpathSync(root);
    const canonicalCwd = realpathSync(cwd);
    if (!statSync(canonicalRoot).isDirectory()) throw new Error('directory required');
    const rel = relative(canonicalRoot, canonicalCwd);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new AgentMindError(
        'PROJECT_SCOPE_DENIED',
        'Launch from inside the configured project directory.',
      );
    }
    if (projectKey !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{15,127}$/.test(projectKey)) {
      throw new AgentMindError(
        'INVALID_PROJECT_KEY',
        'Project key must contain 16–128 letters, digits, dots, underscores or hyphens, starting with a letter or digit.',
      );
    }
    return Object.freeze({
      id: createHash('sha256')
        .update(
          projectKey === undefined
            ? `agentmind:project:v1\0${canonicalRoot}`
            : `agentmind:project-key:v1\0${projectKey}`,
        )
        .digest('hex'),
      root: canonicalRoot,
    });
  } catch (error) {
    if (error instanceof AgentMindError) throw error;
    throw new AgentMindError(
      'INVALID_PROJECT',
      'Project root must be an existing absolute directory.',
    );
  }
}

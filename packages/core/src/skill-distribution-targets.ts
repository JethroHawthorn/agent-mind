import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { AgentMindError } from './errors.js';
import type { ProjectScope } from './project.js';

export const distributionAdapters = {
  codex: { directory: '.agents', reserved: [] as string[] },
  claude: { directory: '.claude', reserved: ['synced', 'anthropic-skills'] },
} as const;
export function trustedDistributionHome(input = homedir()): string {
  if (!isAbsolute(input))
    throw new AgentMindError(
      'INVALID_DISTRIBUTION_ROOT',
      'Distribution home must be an existing absolute directory supplied by the local operator.',
    );
  const root = realpathSync(input);
  if (!lstatSync(root).isDirectory())
    throw new AgentMindError('INVALID_DISTRIBUTION_ROOT', 'Distribution home must be a directory.');
  return root;
}
export function distributionDestination(
  project: ProjectScope,
  home: string,
  target: 'codex' | 'claude',
  scope: 'project' | 'user',
  name: string,
) {
  const base = scope === 'project' ? project.root : home;
  return {
    base,
    parent: join(base, distributionAdapters[target].directory, 'skills'),
    destination: join(base, distributionAdapters[target].directory, 'skills', name),
  };
}

import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectScope } from '../project.js';
import { SkillDistributionService } from '../skill-distribution.js';
import { type BrokerConfig, denied, required, verifyPaths } from './policy.js';

/** Ancestors must already be protected. No privileged traversal into the writable workspace. */
export function checkPublication(
  config: BrokerConfig,
  project: BrokerConfig['projects'][number],
  helper?: string,
) {
  if (project.distribution !== 'protected') denied('Protected publication is disabled.');
  const p = required(project.publication);
  const paths: string[] = [];
  for (let path = p.root; ; path = dirname(path)) {
    const s = lstatSync(path);
    if (
      realpathSync(path) !== path ||
      !s.isDirectory() ||
      ![0, config.broker_uid].includes(s.uid) ||
      s.mode & 0o7022
    )
      denied('Unsafe publication ancestor.');
    paths.push(path);
    if (path === dirname(path)) break;
  }
  const root = lstatSync(p.root);
  if (root.uid !== config.broker_uid || root.gid !== p.gid || (root.mode & 0o777) !== 0o750)
    denied('Publication root must be broker-owned 0750 with the configured project group.');
  // Inspect only fixed publication subtrees, never a sibling writable workspace.
  const walk = (path: string) => {
    if (paths.length > 10000) denied('Publication inventory exceeds limit.');
    let s: ReturnType<typeof lstatSync>;
    try {
      s = lstatSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    if (
      s.isSymbolicLink() ||
      (!s.isDirectory() && !s.isFile()) ||
      s.uid !== config.broker_uid ||
      s.gid !== p.gid ||
      s.mode & 0o7027 ||
      (s.isFile() && s.nlink !== 1)
    )
      denied('Publication subtree contains unsafe ownership, permissions or links.');
    paths.push(path);
    if (s.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
  };
  for (const name of ['.agents', '.claude', '.agentmind']) walk(join(p.root, name));
  if (helper) verifyPaths(helper, [...new Set(paths)]);
}
export function publicationService(
  db: ConstructorParameters<typeof SkillDistributionService>[0],
  config: BrokerConfig,
  project: BrokerConfig['projects'][number],
  scope: ProjectScope,
  helper?: string,
) {
  checkPublication(config, project, helper);
  const p = required(project.publication);
  return new SkillDistributionService(db, { id: scope.id, root: p.root }, p.root, { gid: p.gid });
}

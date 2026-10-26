import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { AgentMindError, resolveProject } from '@agentmind/core';
export const ENROLLMENT = '.agentmind/codex/enrollment.json';
function assertGitResult(cwd: string, result: { status: number | null; error?: unknown }) {
  if (result.error || result.status === null)
    throw new AgentMindError(
      'CODEX_GIT_UNAVAILABLE',
      'Git scope verification failed; install Git before enrolling.',
    );
  if (result.status !== 0) {
    let p = cwd;
    while (true) {
      if (existsSync(join(p, '.git')))
        throw new AgentMindError('CODEX_PROJECT_INVALID', 'Git metadata could not be verified.');
      const parent = dirname(p);
      if (parent === p) break;
      p = parent;
    }
  }
}
export function projectScope(root: string) {
  if (!isAbsolute(root))
    throw new AgentMindError('CODEX_PROJECT_INVALID', 'Use an absolute explicit project root.');
  const canonical = realpathSync(root);
  const git = spawnSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-C', canonical, 'rev-parse', '--show-toplevel'],
    {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 8192,
      env: {
        PATH: process.env.PATH ?? '',
        LANG: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    },
  );
  assertGitResult(canonical, git);
  if (git.status === 0 && realpathSync(git.stdout.trim()) !== canonical)
    throw new AgentMindError(
      'CODEX_PROJECT_INVALID',
      'Enroll the exact Git/worktree root; nested folders are not separate project roots.',
    );
  return resolveProject(canonical, canonical);
}
export function assertCallerProject(root: string, cwd = process.cwd()) {
  const scope = projectScope(root),
    caller = realpathSync(cwd);
  resolveProject(scope.root, caller);
  const git = spawnSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-C', caller, 'rev-parse', '--show-toplevel'],
    {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 8192,
      env: {
        PATH: process.env.PATH ?? '',
        LANG: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    },
  );
  assertGitResult(caller, git);
  if (git.status === 0 && realpathSync(git.stdout.trim()) !== scope.root)
    throw new AgentMindError(
      'CODEX_SCOPE_DENIED',
      'The current Git/worktree root differs from the enrolled project.',
    );
  return scope;
}
export function rejectLinks(root: string, relative: string) {
  let path = realpathSync(root);
  for (const part of relative.split('/')) {
    if (!part || part === '.' || part === '..')
      throw new AgentMindError('CODEX_PATH_UNSAFE', 'Unsafe integration path.');
    path = join(path, part);
    try {
      const s = lstatSync(path);
      if (s.isSymbolicLink() || (!s.isDirectory() && (!s.isFile() || s.nlink !== 1)))
        throw new AgentMindError(
          'CODEX_PATH_UNSAFE',
          'Integration paths must be ordinary directories/single-link files.',
        );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
  }
  return path;
}

import { lstatSync, realpathSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { AgentMindError, redactSecrets, reviewText } from '@agentmind/core';
import { digest, readBounded } from '../codex/files.js';
import { rejectLinks } from '../codex/project.js';
export type Watch = { root: string; path: string; opaque?: boolean };
export function fingerprint(w: Watch) {
  rejectLinks(w.root, relative(w.root, w.path));
  let identity: unknown = null;
  try {
    const s = lstatSync(w.path);
    if (!s.isFile() || s.nlink !== 1) throw Error();
    identity = [s.dev, s.ino, s.mode, s.uid, s.size, s.mtimeMs, s.ctimeMs];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new AgentMindError('INSTALLER_PATH_CONFLICT', 'A watched integration path is unsafe.');
  }
  const ancestors: unknown[] = [];
  let parent = dirname(w.path);
  while (parent !== w.root && parent !== dirname(parent)) {
    try {
      const s = lstatSync(parent);
      if (!s.isDirectory() || s.isSymbolicLink()) throw Error();
      ancestors.push([parent, s.dev, s.ino]);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new AgentMindError('INSTALLER_PATH_CONFLICT', 'An integration ancestor is unsafe.');
    }
    parent = dirname(parent);
  }
  return {
    identity,
    digest: w.opaque
      ? null
      : (() => {
          const s = readBounded(w.root, w.path, 1048576);
          return s === null ? null : digest(s);
        })(),
    ancestors,
  };
}
export function snapshots(files: Watch[]) {
  return files.map((w) => ({ watch: w, ...fingerprint(w) }));
}
export function validateSnapshot(
  before: ReturnType<typeof snapshots>,
  allowed: Map<string, string> = new Map(),
) {
  for (const b of before) {
    const now = fingerprint(b.watch);
    if (b.identity === null && now.digest === allowed.get(b.watch.path)) continue;
    if (
      JSON.stringify(now.identity) !== JSON.stringify(b.identity) ||
      now.digest !== b.digest ||
      b.ancestors.some((a) => !now.ancestors.some((n) => JSON.stringify(a) === JSON.stringify(n)))
    )
      throw new AgentMindError(
        'INSTALLER_CONCURRENT_CHANGE',
        'Integration files or their identity changed after planning; create a fresh plan.',
      );
  }
}
/** All values and keys are redacted. No raw configuration, environment or subprocess errors enter output. */
export function privacy(value: unknown): unknown {
  if (typeof value === 'string')
    return redactSecrets(value).replace(/(?:sk|AIza)[-_A-Za-z0-9]{16,}/g, '[REDACTED]');
  if (Array.isArray(value)) return value.map(privacy);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [String(privacy(k)), privacy(v)]),
    );
  return value;
}
export const diagnosticText = (value: unknown, pretty = true) => reviewText(privacy(value), pretty);
export function canonical(path: string) {
  try {
    return realpathSync(path);
  } catch {
    throw new AgentMindError(
      'INSTALLER_PATH_INVALID',
      'An explicit directory or build path is unavailable.',
    );
  }
}

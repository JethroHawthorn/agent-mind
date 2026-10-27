import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { AgentMindError } from '@agentmind/core';
import { rejectLinks } from './project.js';
export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export function readBounded(root: string, path: string, max = 131072): string | null {
  rejectLinks(root, relative(root, path).split('\\').join('/'));
  if (!existsSync(path)) return null;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.size > max)
      throw new AgentMindError('CODEX_FILE_CONFLICT', 'Integration file is oversized or unsafe.');
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}
/** Compare before commit; single-link/no-follow checks, private staging and same-directory rename. */
export function replaceFile(
  root: string,
  path: string,
  before: string | null,
  after: string | null,
  max = 131072,
) {
  if (readBounded(root, path, max) !== before)
    throw new AgentMindError(
      'CODEX_CONCURRENT_CHANGE',
      'File changed after planning; re-inspect before retry.',
    );
  rejectLinks(root, relative(root, path));
  if (after === null) {
    if (before !== null) unlinkSync(path);
    return;
  }
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (parent !== root) rejectLinks(root, relative(root, parent));
  const temp = join(parent, `.agentmind-stage-${randomUUID()}`);
  const fd = openSync(
    temp,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, after);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (readBounded(root, path, max) !== before)
      throw new AgentMindError('CODEX_CONCURRENT_CHANGE', 'File changed before replacement.');
    renameSync(temp, path);
  } finally {
    if (existsSync(temp) && lstatSync(temp).isFile()) unlinkSync(temp);
  }
}

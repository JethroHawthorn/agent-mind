import { createHash } from 'node:crypto';
import { AgentMindError } from '../errors.js';
import { type SkillVersion, skillFilesSchema } from '../skill-model.js';
import type { PatchOperation } from './model.js';
export const fileDigest = (content: string) => createHash('sha256').update(content).digest('hex');
/** In-memory literal edits only: no filesystem, extraction, shell, regex replacements or code execution. */
export function applySkillPatch(base: SkillVersion['files'], operations: PatchOperation[]) {
  if (new Set(operations.map((o) => o.path.toLowerCase())).size !== operations.length)
    throw new AgentMindError(
      'AUTHORING_PATCH_CONFLICT',
      'Each package path may be edited only once per proposal.',
    );
  const changedBytes = operations.reduce(
    (n, o) =>
      n +
      Buffer.byteLength(
        o.op === 'replace'
          ? o.old_text + o.new_text
          : o.op === 'add'
            ? o.content
            : (base.find((f) => f.path === o.path)?.content ?? ''),
      ),
    0,
  );
  if (changedBytes > 8192)
    throw new AgentMindError(
      'AUTHORING_PATCH_LIMIT',
      'Patch change text exceeds 8192 bytes; use an explicitly reviewed rewrite.',
    );
  const files = new Map(base.map((f) => [f.path, f.content]));
  for (const o of operations) {
    const current = files.get(o.path);
    if (o.op === 'add') {
      if ([...files.keys()].some((p) => p.toLowerCase() === o.path.toLowerCase()))
        throw new AgentMindError(
          'AUTHORING_PATCH_CONFLICT',
          'Added path collides with an existing file.',
        );
      files.set(o.path, o.content);
      continue;
    }
    if (current === undefined || fileDigest(current) !== o.expected_file_digest)
      throw new AgentMindError(
        'AUTHORING_PATCH_CONFLICT',
        'File precondition does not match the immutable base.',
      );
    if (o.op === 'remove') {
      files.delete(o.path);
      continue;
    }
    const at = current.indexOf(o.old_text);
    if (at < 0 || current.indexOf(o.old_text, at + 1) >= 0)
      throw new AgentMindError(
        'AUTHORING_PATCH_CONFLICT',
        'Replacement text must match exactly once.',
      );
    files.set(o.path, current.slice(0, at) + o.new_text + current.slice(at + o.old_text.length));
  }
  return skillFilesSchema.parse(
    [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => ({ path, content })),
  );
}

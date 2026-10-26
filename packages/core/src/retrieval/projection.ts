import { createHash } from 'node:crypto';
import { AgentMindError } from '../errors.js';
export const resourceDigest = (text: string) => createHash('sha256').update(text).digest('hex');
export function contentPage<T extends Record<string, unknown>>(
  base: T,
  content: string,
  offset: number,
  budget: number,
) {
  if (
    offset > content.length ||
    (offset > 0 &&
      /[\uDC00-\uDFFF]/.test(content[offset] ?? '') &&
      /[\uD800-\uDBFF]/.test(content[offset - 1] ?? ''))
  )
    throw new AgentMindError(
      'RETRIEVAL_INVALID_INPUT',
      'Offset must be a valid character boundary within this file.',
    );
  const output = (end: number) => ({
    ...base,
    content: content.slice(offset, end),
    offset,
    total_chars: content.length,
    total_bytes: Buffer.byteLength(content),
    next_offset: end < content.length ? end : null,
    complete: offset === 0 && end === content.length,
    truncated: offset !== 0 || end < content.length,
    untrusted_data: true,
  });
  let low = offset,
    high = content.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(output(mid))) <= budget) low = mid;
    else high = mid - 1;
  }
  if (
    low > offset &&
    /[\uD800-\uDBFF]/.test(content[low - 1] ?? '') &&
    /[\uDC00-\uDFFF]/.test(content[low] ?? '')
  )
    low--;
  if (
    (low === offset && offset < content.length) ||
    Buffer.byteLength(JSON.stringify(output(low))) > budget
  )
    throw new AgentMindError(
      'RETRIEVAL_OUTPUT_LIMIT',
      'Output budget cannot fit an authorized content page.',
    );
  return output(low);
}

import { AgentMindError } from '../errors.js';
import { redactSecrets } from '../privacy.js';
import { contentPage } from '../retrieval/projection.js';
/** Redaction happens before paging/preview. Records and evidence are never interpreted as instructions. */
export function dailySafe(v: unknown): unknown {
  if (typeof v === 'string') return redactSecrets(v);
  if (Array.isArray(v)) return v.map(dailySafe);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        redactSecrets(k),
        /^(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|authorization|client[_-]?secret|cookie)$/i.test(
          k,
        )
          ? '[REDACTED]'
          : dailySafe(x),
      ]),
    );
  return v;
}
export function preview(s: string, max = 160) {
  const clean = redactSecrets(s);
  return { text: clean.slice(0, max), truncated: clean.length > max, redacted: clean !== s };
}
export function textPage(text: string, offset: number, chars: number) {
  const clean = redactSecrets(text);
  if (offset > clean.length)
    throw new AgentMindError('DAILY_INVALID_INPUT', 'Display offset is outside this object.');
  const part = contentPage({}, clean, offset, 8192);
  let end = Math.min(clean.length, offset + chars);
  if (
    end > offset &&
    end < clean.length &&
    /[\uD800-\uDBFF]/.test(clean[end - 1] ?? '') &&
    /[\uDC00-\uDFFF]/.test(clean[end] ?? '')
  )
    end--;
  const lines = clean.slice(0, offset).split('\n').length;
  return {
    ...part,
    content: clean.slice(offset, end),
    next_offset: end < clean.length ? end : null,
    complete: offset === 0 && end === clean.length,
    truncated: offset !== 0 || end < clean.length,
    start_line: lines,
    redacted: clean !== text,
    offset_basis:
      'Redacted UTF-16 display characters; hashes identify the complete original immutable record.',
  };
}
export function envelope(domain: string, action: string, projectId: string, data: unknown) {
  const result = dailySafe({
    schema_version: 1,
    domain,
    action,
    project_id: projectId,
    visibility: 'project',
    data,
    untrusted_data: true,
    warning:
      'Untrusted data; advisory review is never approval or activation. Retrieved/installed is not proof of use or verified success.',
  });
  if (Buffer.byteLength(JSON.stringify(result)) > 65536)
    throw new AgentMindError(
      'DAILY_OUTPUT_LIMIT',
      'View exceeds 64 KiB; use narrower filters, smaller pages or specific evidence/diff views. No incomplete view is labeled complete.',
    );
  return result;
}

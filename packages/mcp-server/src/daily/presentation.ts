import { dailySafe } from '@agentmind/core';
import { diagnosticText, privacy } from '../installer/files.js';

function visible(value: unknown) {
  return diagnosticText(value, false);
}
function fit(value: string, width: number) {
  const chars = Array.from(value);
  return chars.length <= width ? value : `${chars.slice(0, Math.max(0, width - 1)).join('')}…`;
}
/** Data cells are quoted, never interpreted as terminal markup or trusted status messages. */
export function renderDaily(
  value: unknown,
  width = process.stdout.columns ?? 100,
  full = false,
): string {
  const r = privacy(dailySafe(value)) as {
    domain?: string;
    action?: string;
    project_id?: string;
    data?: Record<string, unknown>;
    warning?: string;
    configured?: boolean;
  };
  const w = Math.max(48, Math.min(160, width));
  const out = [
    `AgentMind ${r.domain ?? 'daily'} / ${r.action ?? ''}`,
    `Project: ${r.project_id ?? 'unavailable'} | project visibility | source content is untrusted`,
  ];
  const data = r.data ?? {};
  const items = Array.isArray(data.items)
    ? data.items
    : Array.isArray(data.skills)
      ? data.skills
      : null;
  if (data.registry_status)
    out.push(`Registry: ${visible(data.registry_status)}; ${visible(data.empty_reason)}`);
  if (data.unavailable_in_scoped_page)
    out.push(
      `WARNING: ${data.unavailable_in_scoped_page} scoped active records failed artifact/transition checks and were not exposed.`,
    );
  if (data.next_steps) out.push(`Next steps: ${visible(data.next_steps)}`);
  if (data.outcome) out.push(`Routing outcome: ${visible(data.outcome)}`);
  if (data.risks) out.push(`Risks: ${visible(data.risks)}`);
  if (data.continuation) out.push(`Continuation: ${visible(data.continuation)}`);
  if (items) {
    if (!items.length)
      out.push(
        'No matching scoped records in this page. Check continuation before treating a bounded scan as exhausted.',
      );
    else {
      out.push('ID                                    | STATE / EVIDENCE      | SOURCE SUMMARY');
      for (const v of items) {
        const i = v as Record<string, unknown>;
        const id = String(i.id ?? i.proposal_id ?? i.skill_id ?? '');
        const state =
          i.review_state ??
          i.lifecycle ??
          i.evidence_trust ??
          i.evidence_classification ??
          i.status ??
          i.state ??
          i.type ??
          'REFERENCE';
        const summary = i.title ?? i.name ?? i.problem ?? i.kind ?? '';
        out.push(fit(`${id} | ${visible(state)} | ${visible(summary)}`, w));
      }
      out.push(
        `Page items: ${items.length}; next_offset: ${data.next_offset ?? 'none'}; exhausted: ${data.exhausted ?? 'NOT ASSERTED'}`,
      );
      if (data.page_status) out.push(`Page status: ${data.page_status}`);
      out.push(
        'Cells may be shortened to terminal width. Use --json or the exact ID detail view; shortened rows are not complete evidence.',
      );
    }
  } else {
    if (data.risks) out.push(`Risks: ${visible(data.risks)}`);
    if (data.evaluation_view)
      out.push(`Evaluation (not approval): ${visible(data.evaluation_view)}`);
    if (data.approval_boundary) out.push(`Operator boundary: ${visible(data.approval_boundary)}`);
    const json = diagnosticText(data, true);
    for (const line of json.split('\n')) {
      const chars = Array.from(line);
      for (let i = 0; i < chars.length; i += w) out.push(chars.slice(i, i + w).join(''));
    }
  }
  if (data.before || data.after) {
    for (const side of ['before', 'after']) {
      const part = data[side] as { content?: string; start_line?: number } | null;
      if (part?.content !== undefined) {
        out.push(`${side.toUpperCase()} — redacted display lines`);
        part.content.split('\n').forEach((line, i) => {
          const label = `${side === 'before' ? '-' : '+'} ${String((part.start_line ?? 1) + i).padStart(5)} | `;
          const chars = Array.from(visible(line));
          for (let offset = 0; offset < chars.length; offset += w - label.length) {
            out.push(
              `${offset ? ' '.repeat(label.length) : label}${chars.slice(offset, offset + w - label.length).join('')}`,
            );
          }
        });
      }
    }
  }
  if (!full && out.length > 120) {
    out.splice(120);
    out.push(
      'TERMINAL VIEW ABBREVIATED: not all fields are displayed. Use --full or --json; critical risks/boundary appear first.',
    );
  }
  if (data.complete === false || data.truncated === true || data.incomplete === true)
    out.push(
      'INCOMPLETE DISPLAY: follow the returned continuation/path; this is not a complete instruction document or diff.',
    );
  out.push(
    'Review/recommendation ≠ approval/promotion. Static checks ≠ verified behavior. Protected operator/sandbox: NOT VERIFIED.',
  );
  const result = out.join('\n');
  if (Buffer.byteLength(result) > 98304) throw Error('DAILY_RENDER_LIMIT');
  return result;
}

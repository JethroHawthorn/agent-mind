import { diagnosticText } from './files.js';
/** Render only safe projections; JSON/verbose use exactly the same redaction boundary. */
export function renderSummary(action: string, result: unknown): string {
  const r = result as {
    agentmind_version?: string;
    project_id?: string;
    scope?: string;
    integrations?: { cli: string; state: string; router: string; mcp: string }[];
    plans?: {
      cli: string;
      disposition: string;
      operations: unknown[];
      diagnostics: { message: string }[];
    }[];
    checks?: { id: string; status: string; message: string }[];
    applied?: boolean;
  };
  const lines = [`AgentMind ${r.agentmind_version ?? ''} — ${action}`];
  if (r.project_id) lines.push(`Project ${r.project_id}; scope ${r.scope}`);
  for (const i of r.integrations ?? [])
    lines.push(`${i.cli}: ${i.state}; MCP ${i.mcp}; router ${i.router}`);
  for (const p of r.plans ?? []) {
    lines.push(`${p.cli}: ${p.disposition} (${p.operations.length} planned artifact operations)`);
    for (const d of p.diagnostics) lines.push(`  ${d.message}`);
  }
  if (r.plans)
    lines.push('Preview only. Use --apply to authorize changes; --json shows paths and digests.');
  for (const c of r.checks ?? []) lines.push(`${c.status} ${c.id}: ${c.message}`);
  if (r.applied)
    lines.push('Applied. Registry/data retained. Inspect status or doctor for next steps.');
  lines.push(
    'Protected deployment / behavioral sandbox: NOT VERIFIED; autonomous activation disabled.',
  );
  return lines
    .map((l) => JSON.parse(diagnosticText(l)))
    .join('\n')
    .replace(/[\p{Cc}\p{Cf}]/gu, (c) =>
      c === '\n' ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
}

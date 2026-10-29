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
    ready?: boolean;
    dry_run?: boolean;
    registry?: { path?: string };
    failed_stage?: string;
  };
  const lines = [`AgentMind ${r.agentmind_version ?? ''} — ${action}`];
  if (r.project_id) lines.push(`Project ${r.project_id}; scope ${r.scope}`);
  for (const i of r.integrations ?? [])
    lines.push(`${i.cli}: ${i.state}; MCP ${i.mcp}; router ${i.router}`);
  for (const p of r.plans ?? []) {
    lines.push(`${p.cli}: ${p.disposition} (${p.operations.length} planned artifact operations)`);
    for (const d of p.diagnostics) lines.push(`  ${d.message}`);
  }
  if (r.plans && r.dry_run !== false)
    lines.push('Preview only. Use --apply to authorize changes; --json shows paths and digests.');
  for (const c of r.checks ?? []) lines.push(`${c.status} ${c.id}: ${c.message}`);
  if (action === 'setup' && r.registry?.path)
    lines.push(`Registry: ${r.registry.path}; Mode: Supervised Local`);
  if (action === 'setup') {
    lines.push(
      r.ready
        ? 'Setup ready for the configured local integrations. Native model use: NOT VERIFIED.'
        : r.dry_run
          ? 'Setup preview; registry/index/runtime checks deferred to --apply.'
          : `Setup incomplete at ${r.failed_stage ?? 'preflight'}. Preserve data; rerun setup --dry-run and inspect doctor/journals.`,
    );
  }
  if (r.applied && action !== 'setup')
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

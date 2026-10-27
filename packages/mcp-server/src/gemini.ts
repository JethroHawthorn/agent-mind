#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AgentMindError, reviewText, safeError } from '@agentmind/core';
import { readBounded } from './codex/files.js';
import { projectScope } from './codex/project.js';
import { existingGeminiFiles, geminiCapabilities } from './gemini/configuration.js';
import { connectGemini } from './gemini/doctor.js';
import { GeminiSetup } from './gemini/setup.js';

async function main() {
  process.umask(0o077);
  const { values: v, positionals: p } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
      'project-root': { type: 'string' },
      db: { type: 'string' },
      scope: { type: 'string', default: 'project' },
      'dry-run': { type: 'boolean' },
      apply: { type: 'boolean' },
      connect: { type: 'boolean' },
      json: { type: 'boolean' },
      gemini: { type: 'string' },
    },
    strict: true,
    allowPositionals: true,
  });
  if (v.help) {
    process.stdout.write(`AgentMind Gemini integration (supervised local mode)
Usage: agentmind gemini setup|status|doctor|uninstall --project-root /absolute/project [options]
  --scope project|user   settings.json registration; user remains project-pinned
  --db PATH             Shared canonical registry path
  --dry-run             Preview (default); only managed change data is displayed
  --apply               Explicit setup/uninstall authorization
  --connect             Doctor only: SDK MCP connection, may initialize/migrate SQLite
  --gemini PATH          CLI executable for public capability detection
  --json                Machine-readable output
  -h, --help            Help without installed CLI/project
Offline configuration is supported; it does not prove native CLI/auth compatibility.
No credentials, GEMINI.md, hooks or policy settings are modified. No approval/promotion.
`);
    return;
  }
  const action = p[0];
  if (
    p.length !== 1 ||
    !['setup', 'status', 'doctor', 'uninstall'].includes(action ?? '') ||
    !v['project-root'] ||
    !['project', 'user'].includes(v.scope ?? '') ||
    (v.apply && v['dry-run']) ||
    (v.connect && (action !== 'doctor' || v['dry-run'])) ||
    (v.apply && !['setup', 'uninstall'].includes(action ?? ''))
  )
    throw new AgentMindError(
      'GEMINI_SETUP_INVALID',
      'Use --help; writes require explicit --apply.',
    );
  const root = projectScope(v['project-root']).root,
    saved = readBounded(root, join(root, '.agentmind/gemini/installation.json'), 524288);
  const setup = new GeminiSetup({
    root,
    database:
      v.db ?? (saved ? JSON.parse(saved).database : join(homedir(), '.agentmind/agentmind.db')),
    scope: v.scope as 'project' | 'user',
    gemini: v.gemini,
    adapter: fileURLToPath(new URL('./gemini/adapter.js', import.meta.url)),
    router: readFileSync(
      fileURLToPath(new URL('../../../skills/agentmind-router/SKILL.md', import.meta.url)),
      'utf8',
    ),
  });
  let result: unknown;
  if (action === 'setup') {
    if (v.apply) result = setup.setup();
    else {
      const plan = setup.plan();
      result = {
        action: plan.action,
        dry_run: true,
        scope: setup.scope,
        server_name: 'agentmind',
        capabilities: plan.capabilities,
        policy: plan.policy,
        changes:
          plan.action === 'SKIP'
            ? []
            : [
                {
                  path: setup.config,
                  operation: 'SET_MANAGED_MCP_ENTRY',
                  after_entry: plan.receipt.entry,
                },
                {
                  path: plan.receipt.router.path,
                  operation: plan.receipt.router.owned
                    ? 'INSTALL_MANAGED_ROUTER'
                    : 'REUSE_READ_ONLY',
                },
                { path: setup.enrollment, operation: 'WRITE_ENROLLMENT' },
              ],
        gemini_md: 'UNCHANGED',
        hooks: 'UNCHANGED',
        authentication: 'UNCHANGED',
        apply_required: plan.action !== 'SKIP',
      };
    }
  } else if (action === 'uninstall') result = setup.uninstall(v.apply ?? false);
  else if (action === 'status') result = setup.status();
  else
    result = {
      ...setup.status(),
      capabilities: geminiCapabilities(v.gemini),
      existing: existingGeminiFiles(setup.home),
      ...(v.connect
        ? await connectGemini(setup)
        : {
            connection:
              'NOT TESTED; --connect uses an SDK, not native Gemini, and may initialize/migrate SQLite.',
          }),
    };
  process.stdout.write(`${reviewText(result, !v.json)}\n`);
}
main().catch((e) => {
  const f = safeError(e);
  console.error(`[agentmind] ${f.code}: ${f.message}`);
  process.exitCode = 1;
});

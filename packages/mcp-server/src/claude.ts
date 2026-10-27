#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AgentMindError, reviewText, safeError } from '@agentmind/core';
import { capabilities, inspectClaude } from './claude/configuration.js';
import { connectClaude } from './claude/doctor.js';
import { ClaudeSetup } from './claude/setup.js';
import { readBounded } from './codex/files.js';
import { projectScope } from './codex/project.js';

async function main() {
  process.umask(0o077);
  const { values: v, positionals } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
      'project-root': { type: 'string' },
      db: { type: 'string' },
      scope: { type: 'string', default: 'project' },
      'dry-run': { type: 'boolean' },
      apply: { type: 'boolean' },
      connect: { type: 'boolean' },
      json: { type: 'boolean' },
      claude: { type: 'string' },
    },
    strict: true,
    allowPositionals: true,
  });
  if (v.help) {
    process.stdout.write(`AgentMind Claude integration (supervised local mode)
Usage: agentmind claude setup|status|doctor|uninstall --project-root /absolute/project [options]
  --scope project|user   Project .mcp.json (default) or official user registration
  --db PATH              Shared registry path; canonical project scope stays fixed
  --dry-run              Preview (setup/uninstall default)
  --apply                Explicit setup/uninstall authorization
  --connect              Doctor only: start MCP; can initialize SQLite
  --claude PATH          Official CLI executable
  --json                 Machine-readable output
  -h, --help             Help; no project or installed CLI required
User registration remains pinned to this enrolled project. Other projects fail closed.
No authentication/settings/CLAUDE.md edits or hooks; approval remains separate.
`);
    return;
  }
  const action = positionals[0];
  if (
    positionals.length !== 1 ||
    !['setup', 'status', 'doctor', 'uninstall'].includes(action ?? '') ||
    !v['project-root'] ||
    !['project', 'user'].includes(v.scope ?? '') ||
    (v.apply && v['dry-run']) ||
    (v.connect && (action !== 'doctor' || v['dry-run'])) ||
    (v.apply && !['setup', 'uninstall'].includes(action ?? ''))
  )
    throw new AgentMindError(
      'CLAUDE_SETUP_INVALID',
      'Use --help for commands/options; configuration changes require explicit --apply.',
    );
  const root = projectScope(v['project-root']).root;
  const saved = readBounded(root, join(root, '.agentmind/claude/installation.json'), 524288);
  const database =
    v.db ?? (saved ? JSON.parse(saved).database : join(homedir(), '.agentmind/agentmind.db'));
  const setup = new ClaudeSetup({
    root,
    database,
    scope: v.scope as 'project' | 'user',
    claude: v.claude,
    adapter: fileURLToPath(new URL('./claude/adapter.js', import.meta.url)),
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
        server_name: setup.serverName,
        project_id: setup.status().project_id,
        paths: [
          setup.scope === 'project' ? setup.config : 'OFFICIAL_CLAUDE_USER_REGISTRATION',
          setup.routerPath,
          setup.enrollment,
        ],
        claude_md: 'UNCHANGED',
        authentication: 'UNCHANGED',
        hooks_installed: false,
        apply_required: true,
      };
    }
  } else if (action === 'uninstall') result = setup.uninstall(v.apply ?? false);
  else if (action === 'status') result = setup.status();
  else
    result = {
      ...setup.status(),
      capabilities: capabilities(setup.claude),
      ...inspectClaude(setup.claude),
      ...(v.connect
        ? await connectClaude(setup)
        : { connection: 'NOT TESTED; --connect starts MCP and may initialize SQLite.' }),
    };
  process.stdout.write(`${reviewText(result, !v.json)}\n`);
}
main().catch((e) => {
  const f = safeError(e);
  console.error(`[agentmind] ${f.code}: ${f.message}`);
  process.exitCode = 1;
});

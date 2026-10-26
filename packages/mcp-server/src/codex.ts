#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AgentMindError, reviewText, safeError } from '@agentmind/core';
import { codexCapabilities, configBlock } from './codex/configuration.js';
import { connectDoctor } from './codex/doctor.js';
import { readBounded } from './codex/files.js';
import { projectScope, rejectLinks } from './codex/project.js';
import { CodexSetup } from './codex/setup.js';

async function main() {
  process.umask(0o077);
  const { values, positionals } = parseArgs({
    options: {
      'project-root': { type: 'string' },
      db: { type: 'string' },
      scope: { type: 'string', default: 'project' },
      'dry-run': { type: 'boolean' },
      apply: { type: 'boolean' },
      connect: { type: 'boolean' },
      json: { type: 'boolean' },
      codex: { type: 'string' },
    },
    allowPositionals: true,
    strict: true,
  });
  const action = positionals[0];
  if (
    positionals.length !== 1 ||
    !['setup', 'status', 'doctor', 'uninstall'].includes(action ?? '') ||
    !values['project-root'] ||
    values.scope !== 'project' ||
    (values.apply && values['dry-run']) ||
    (values.connect && values['dry-run']) ||
    (values.connect && action !== 'doctor') ||
    (values.apply && !['setup', 'uninstall'].includes(action ?? ''))
  )
    throw new AgentMindError(
      'CODEX_SETUP_INVALID',
      'Use setup|status|doctor|uninstall --scope project --project-root /absolute/project [--db /absolute/registry.db] [--dry-run | --apply] [--connect for doctor]. User/global configuration is not edited.',
    );
  const root = projectScope(values['project-root']).root;
  const state = readBounded(root, rejectLinks(root, '.agentmind/codex/installation.json'), 1048576);
  const remembered = state === null ? null : JSON.parse(state).database;
  const database = values.db ?? remembered ?? join(homedir(), '.agentmind', 'agentmind.db');
  const setup = new CodexSetup({
    root,
    database,
    adapter: fileURLToPath(new URL('./codex/adapter.js', import.meta.url)),
    router: readFileSync(
      fileURLToPath(new URL('../../../skills/agentmind-router/SKILL.md', import.meta.url)),
      'utf8',
    ),
    codex: values.codex,
  });
  let result: unknown;
  if (action === 'setup') {
    if (values.apply) result = setup.setup();
    else {
      const plan = setup.plan();
      result = {
        action: plan.action,
        dry_run: true,
        scope: 'project',
        paths: plan.record.changes.map((c) => ({
          path: c.path,
          operation:
            readBounded(root, join(root, c.path)) === c.after
              ? 'SKIP'
              : c.before === null
                ? 'CREATE'
                : 'PRESERVE_AND_APPEND',
        })),
        managed_config_block: configBlock(plan.record),
        private_state_paths: [
          '.agentmind/codex/.gitignore',
          '.agentmind/codex/installation.json',
          `.agentmind/codex/backups/${plan.record.installation_id}.json`,
        ],
        agents_md: 'UNCHANGED',
        database_created: false,
        apply_required: true,
      };
    }
  } else if (action === 'uninstall')
    result = { ...setup.uninstall(values.apply ?? false), dry_run: !values.apply };
  else if (action === 'status') result = setup.status();
  else {
    const capabilities = codexCapabilities(setup.codex),
      status = setup.status();
    result = {
      ...status,
      capabilities,
      build_present: existsSync(setup.adapter),
      database_exists: existsSync(database),
      native_workflow: 'NOT VERIFIED',
      ...(values.connect
        ? await connectDoctor(setup)
        : {
            connection:
              'NOT TESTED; --connect starts the enrolled MCP runtime and can initialize its database.',
          }),
    };
  }
  process.stdout.write(`${reviewText(result, !values.json)}\n`);
}
main().catch((e) => {
  const f = safeError(e);
  console.error(`[agentmind] ${f.code}: ${f.message}`);
  process.exitCode = 1;
});

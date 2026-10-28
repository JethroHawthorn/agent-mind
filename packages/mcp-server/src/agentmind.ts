#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  AgentMindError,
  behavioralSandboxStatus,
  classifySqliteError,
  inspectProtectedDeployment,
  inspectRegistry,
  releaseBoundaryStatus,
} from '@agentmind/core';
import { DAILY_DOMAINS, dailyHelp, runDailyCLI } from './daily/cli.js';
import { databaseHelp, runDatabaseCLI } from './database.js';
import { distributionHelp, runDistributionCLI } from './distribution.js';
import { evaluationHelp, runEvaluationCLI } from './evaluation.js';
import { runtimeDoctor } from './installer/doctor.js';
import { diagnosticText } from './installer/files.js';
import { type Action, diagnostic, EXIT, PROVIDERS, type Provider } from './installer/model.js';
import { nativeDoctor } from './installer/native.js';
import { renderSummary } from './installer/presentation.js';
import { UnifiedInstaller } from './installer/service.js';

const help = `AgentMind integrations — supervised local installation
Usage: agentmind setup|status|doctor|repair|update|uninstall [options]
  --cli codex|claude|gemini|all  Target providers (default: detected for setup, all for inspection)
  --project-root PATH          Explicit repository/worktree root (default current directory)
  --scope project|user         Project default; Codex user scope remains unsupported
  --db PATH                    Shared registry; existing receipt binding is preserved
  --dry-run                    Read-only plan (default for noninteractive mutations)
  --apply                      Explicit consent to configuration/owned router changes
  --json                       Stable JSON only on stdout; secrets/controls remain sanitized
  --verbose                    Include diagnostic details, never raw config/environment
  --protected-config PATH      Doctor: read-only protected deployment breakdown; no service start
  --connect                    Doctor: explicitly start enrolled MCP; can initialize/migrate SQLite
  --native --allow-model       Doctor: explicit opt-in to a disposable native Scenario A probe
  --codex PATH --claude PATH --gemini PATH  Official executable overrides
  -h, --help                   No project or CLI required
Status/ordinary doctor never authenticate or invoke models. Optional hooks are preserved,
not installed. Setup is not skill approval; autonomous promotion/distribution remain disabled.
No AGENTS.md/CLAUDE.md/GEMINI.md changes. Uninstall retains memories, registry and backups.
Legacy commands: pnpm codex|claude|gemini setup|status|doctor|uninstall ...
Exit: 0 success, 2 warnings/incomplete, 3 conflict, 4 arguments, 5 dependency,
      6 permission, 7 verification failure, 1 unexpected internal failure.
`;
async function main() {
  process.umask(0o077);
  if (process.argv[2] === 'db') {
    await runDatabaseCLI(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === 'distribution') {
    await runDistributionCLI(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === 'evaluation') {
    runEvaluationCLI(process.argv.slice(3));
    return;
  }
  if (DAILY_DOMAINS.includes(process.argv[2] ?? '')) {
    await runDailyCLI(process.argv.slice(2));
    return;
  }
  const { values: v, positionals } = parseArgs({
    strict: true,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      cli: { type: 'string' },
      'project-root': { type: 'string' },
      'protected-config': { type: 'string' },
      db: { type: 'string' },
      scope: { type: 'string', default: 'project' },
      'dry-run': { type: 'boolean' },
      apply: { type: 'boolean' },
      json: { type: 'boolean' },
      verbose: { type: 'boolean' },
      connect: { type: 'boolean' },
      native: { type: 'boolean' },
      'allow-model': { type: 'boolean' },
      codex: { type: 'string' },
      claude: { type: 'string' },
      gemini: { type: 'string' },
    },
  });
  if (v.help) {
    process.stdout.write(
      `${help}\n${dailyHelp}\n${evaluationHelp}\n${distributionHelp}\n${databaseHelp}`,
    );
    return;
  }
  const action = positionals[0],
    mutation = ['setup', 'repair', 'update', 'uninstall'].includes(action ?? '');
  if (
    positionals.length !== 1 ||
    !['setup', 'status', 'doctor', 'repair', 'update', 'uninstall'].includes(action ?? '') ||
    !['project', 'user'].includes(v.scope ?? '') ||
    (v.cli && !['all', ...PROVIDERS].includes(v.cli)) ||
    (v.apply && (!mutation || v['dry-run'])) ||
    ((v.connect || v.native) && action !== 'doctor') ||
    (v.native && (!v['allow-model'] || v.codex || v.claude || v.gemini)) ||
    (v['allow-model'] && !v.native) ||
    (v['dry-run'] && !mutation)
  )
    throw new AgentMindError(
      'INSTALLER_ARGUMENTS',
      'Use --help; mutations need --apply, native model probes need --native --allow-model.',
    );
  if (v['protected-config']) {
    if (action !== 'doctor' || v.connect || v.native || v.apply)
      throw new AgentMindError(
        'INSTALLER_ARGUMENTS',
        'Protected diagnostic is read-only and cannot combine startup/native/apply.',
      );
    const result = inspectProtectedDeployment(v['protected-config']);
    process.stdout.write(`${diagnosticText(result, !v.json)}\n`);
    process.exitCode = result.checks.some((c) => c.status === 'FAIL') ? 7 : 2;
    return;
  }
  const base = fileURLToPath(new URL('.', import.meta.url));
  const service = new UnifiedInstaller({
    root: v['project-root'] ?? process.cwd(),
    database: v.db,
    scope: v.scope as 'project' | 'user',
    router: readFileSync(join(base, '../../../skills/agentmind-router/SKILL.md'), 'utf8'),
    adapters: Object.fromEntries(
      PROVIDERS.map((id) => [id, join(base, id, 'adapter.js')]),
    ) as Record<Provider, string>,
    executables: { codex: v.codex, claude: v.claude, gemini: v.gemini },
  });
  let ids: Provider[] = v.cli && v.cli !== 'all' ? [v.cli as Provider] : [...PROVIDERS];
  let result: unknown;
  if (action === 'status') {
    result = service.status(ids);
    process.exitCode = (result as ReturnType<typeof service.status>).integrations.some(
      (i) => i.state === 'CONFIG_ERROR' || i.state === 'POLICY_BLOCKED',
    )
      ? EXIT.conflict
      : EXIT.success;
  } else if (action === 'doctor') {
    const checks = service.diagnostics(ids);
    const registry = inspectRegistry(service.context.database, service.project);
    checks.push(diagnostic('registry.read-only', registry.status, registry.reason));
    if (v.connect) for (const id of ids) checks.push(...(await runtimeDoctor(service, id)));
    const native = [];
    if (v.native)
      for (const id of ids) {
        if (service.adapters[id].detect().state === 'DETECTED')
          native.push(
            await nativeDoctor(id, join(base, `../../../scripts/verify-${id}-daily.mjs`)),
          );
        else native.push({ cli: id, status: 'NOT_VERIFIED', reason: 'CLI_UNAVAILABLE' });
      }
    result = {
      schema_version: 1,
      checks,
      registry,
      native,
      model_invocations_authorized: !!v.native,
      protected_deployment: 'NOT_VERIFIED',
      behavioral_sandbox: 'NOT_VERIFIED',
      behavioral_capabilities: behavioralSandboxStatus(),
      release_boundaries: releaseBoundaryStatus(),
    };
    process.exitCode = checks.some((c) => c.status === 'FAIL')
      ? EXIT.verification
      : EXIT.incomplete;
  } else {
    if ((action === 'setup' || action === 'update') && (!v.cli || v.cli === 'all'))
      ids = ids.filter((id) => service.adapters[id].detect().state === 'DETECTED');
    if (!ids.length)
      throw new AgentMindError(
        'INSTALLER_DEPENDENCY_MISSING',
        'No supported installed CLI detected; install an official CLI and retry.',
      );
    if (
      !v.cli &&
      !v.json &&
      !v.apply &&
      !v['dry-run'] &&
      process.stdin.isTTY &&
      process.stdout.isTTY
    ) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await rl.question(
          `Select targets (${ids.join(', ')}; blank = all detected, cancel = stop): `,
        );
        if (answer === 'cancel') return;
        if (answer.trim()) {
          const selected = answer.split(',').map((s) => s.trim());
          if (selected.some((s) => !ids.includes(s as Provider)))
            throw new AgentMindError('INSTALLER_ARGUMENTS', 'Select only listed providers.');
          ids = [...new Set(selected)] as Provider[];
        }
      } finally {
        rl.close();
      }
    }
    const plans = service.plan(action as Action, ids);
    if (plans.some((p) => p.disposition === 'CONFLICT')) {
      result = { schema_version: 1, dry_run: true, plans };
      process.exitCode = plans.some((p) =>
        p.diagnostics.some((d) => d.message === 'INSTALLER_DEPENDENCY_MISSING'),
      )
        ? EXIT.dependency
        : EXIT.conflict;
    } else {
      let apply = v.apply ?? false;
      if (!apply && !v.json && !v['dry-run'] && process.stdin.isTTY && process.stdout.isTTY) {
        process.stderr.write(`${diagnosticText({ scope: service.context.scope, plans })}\n`);
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        try {
          apply =
            (await rl.question('Apply these integration changes? [y/N] ')).trim().toLowerCase() ===
            'y';
        } finally {
          rl.close();
        }
      }
      result = apply
        ? service.apply(plans)
        : { schema_version: 1, dry_run: true, apply_required: true, plans };
    }
  }
  process.stdout.write(
    `${v.json || v.verbose ? diagnosticText(result, !v.json) : renderSummary(action ?? '', result)}\n`,
  );
}
main().catch((e) => {
  const code =
    e instanceof AgentMindError
      ? e.code
      : (e as NodeJS.ErrnoException).code === 'EACCES' ||
          (e as NodeJS.ErrnoException).code === 'EPERM'
        ? 'INSTALLER_PERMISSION'
        : /^(?:ERR_PARSE_ARGS)/.test((e as NodeJS.ErrnoException).code ?? '')
          ? ((e as NodeJS.ErrnoException).code ?? 'INSTALLER_ARGUMENTS')
          : process.argv[2] === 'db'
            ? classifySqliteError(e)
            : 'INSTALLER_INTERNAL';
  const exit =
    code === 'INVALID_INPUT' ||
    code === 'INSTALLER_ARGUMENTS' ||
    code === 'DAILY_INVALID_INPUT' ||
    code === 'DAILY_SCOPE_UNSUPPORTED' ||
    code === 'REVIEW_INVALID_INPUT' ||
    code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ||
    code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' ||
    /PROJECT_INVALID|PATH_INVALID|ROUTER_INVALID|DATABASE_PATH|RESTORE_PATH|BACKUP_PATH/.test(
      code,
    ) ||
    e instanceof TypeError
      ? EXIT.invalid
      : /PERMISSION|EACCES|EPERM/.test(code)
        ? EXIT.permission
        : process.argv[2] === 'db' &&
            /CHECKSUM|DATABASE_UNHEALTHY|BACKUP_METADATA|BACKUP_SIDECAR|PACKAGE_INTEGRITY|MIGRATION_INTEGRITY/.test(
              code,
            )
          ? EXIT.verification
          : /DEPENDENCY/.test(code)
            ? EXIT.dependency
            : /CONFLICT|STALE|NOT_FOUND|UNAVAILABLE|PLAN|BUSY|CONCURRENT|PARTIAL|SCOPE/.test(code)
              ? EXIT.conflict
              : EXIT.internal;
  const json = process.argv.includes('--json');
  const out = {
    schema_version: 1,
    error: {
      code,
      message:
        process.argv[2] === 'db'
          ? 'Database maintenance refused or failed safely. Inspect db --help and db doctor; protected state and live restore are unavailable. No raw database content or driver message is displayed.'
          : process.argv[2] === 'evaluation'
            ? 'Evaluation unavailable or invalid. Refresh the exact candidate plan and inspect evaluation doctor; no candidate code, approval or promotion was executed.'
            : DAILY_DOMAINS.includes(process.argv[2] ?? '')
              ? 'Daily view/action unavailable or invalid. Use a full scoped ID, refresh a stale review snapshot, or inspect the existing registry with status/doctor. No approval or promotion was performed.'
              : 'Integration operation could not complete safely. Use --help or doctor; existing data/configuration was not force-overwritten.',
    },
  };
  (json ? process.stdout : process.stderr).write(`${diagnosticText(out)}\n`);
  process.exitCode = exit;
});

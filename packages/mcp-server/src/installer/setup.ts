import { existsSync } from 'node:fs';
import { AgentMindError } from '@agentmind/core';
import { runtimeDoctor } from './doctor.js';
import { diagnostic, EXIT, type InstallPlan, type Provider } from './model.js';
import { prepareRegistry, previewRegistry } from './registry.js';
import type { UnifiedInstaller } from './service.js';
import { verifySqliteDriver } from './sqlite-driver.js';

function setupCode(error: unknown) {
  if (error instanceof AgentMindError) return error.code;
  const code = (error as NodeJS.ErrnoException).code ?? '';
  if (/^(EACCES|EPERM|ENOENT|EEXIST|SQLITE_)/.test(code)) return code;
  return 'INSTALLER_INTERNAL';
}

export function setupExit(error: unknown) {
  const code = setupCode(error);
  if (code === 'INSTALLER_INTERNAL') return EXIT.internal;
  if (/PERMISSION|PERMISSIONS|EACCES|EPERM|SQLITE_READONLY|SQLITE_PERM/.test(code))
    return EXIT.permission;
  if (
    /DRIVER|BINDING|NATIVE_INCOMPATIBLE|PLATFORM_UNSUPPORTED|DEPENDENCY|FTS5_UNAVAILABLE/.test(code)
  )
    return EXIT.dependency;
  if (/PATH|ARGUMENT|INVALID_INPUT/.test(code)) return EXIT.invalid;
  if (
    /OWNER_REQUIRED|INITIALIZATION_REQUIRED|PROTECTED|CONFLICT|BUSY|LOCKED|PARTIAL|CONCURRENT|EXIST/.test(
      code,
    )
  )
    return EXIT.conflict;
  return EXIT.verification;
}

/** One setup orchestration over the existing planner/apply, core initializer and runtime doctor.
 * No flags authorize arbitrary SQL, old-schema migration, protected access or index rebuilds.
 */
export async function completeSetup(
  service: UnifiedInstaller,
  requested: readonly Provider[],
  apply: boolean,
) {
  const checks: ReturnType<typeof diagnostic>[] = [];
  let stage = 'preflight';
  const result = {
    schema_version: 1,
    mode: 'SUPERVISED_LOCAL',
    dry_run: !apply,
    applied: false,
    ready: false,
    exit_code: EXIT.success as number,
    registry: { path: service.context.database } as Record<string, unknown>,
    plans: [] as InstallPlan[],
    results: [] as { cli: Provider; action: string }[],
    providers: [] as { cli: Provider; status: string; reason: string }[],
    checks,
    native_model_execution: 'NOT_VERIFIED',
    protected_deployment: 'NOT_VERIFIED',
    behavioral_sandbox: 'NOT_VERIFIED',
    autonomous_activation: 'DISABLED',
    recovery:
      'Rerun setup --dry-run. Preserve the registry; inspect status/doctor and private installer journals. Existing schema changes require db migrate --dry-run and owner-approved --schema-digest; index rebuilds require explicit db index rebuild --apply.',
  };
  try {
    stage = 'sqlite-driver';
    const driver = await verifySqliteDriver();
    checks.push(diagnostic(stage, driver.status, driver.code));
    if (driver.status === 'FAIL')
      throw new AgentMindError(driver.code, 'SQLite runtime unavailable.');
    stage = 'registry-path';
    result.registry = {
      path: service.context.database,
      ...previewRegistry(service.context.database),
    };
    checks.push(
      diagnostic(
        stage,
        'PASS',
        'Receipt-bound registry and private location selected; no live SQLite connection in preview.',
      ),
    );
    const selected: Provider[] = [];
    for (const id of requested) {
      const detection = service.adapters[id].detect();
      if (detection.state === 'NOT_INSTALLED') {
        result.providers.push({ cli: id, status: 'SKIP', reason: 'NOT_INSTALLED' });
        checks.push(
          diagnostic(
            `${id}.integration`,
            'SKIP',
            'CLI not installed; no integration configured.',
            id,
          ),
        );
      } else selected.push(id);
    }
    if (!selected.length)
      throw new AgentMindError('INSTALLER_DEPENDENCY_MISSING', 'No installed supported CLI.');
    stage = 'configuration-plan';
    const inspected = service.status(selected);
    if (selected.some((id) => !inspected.mcp_build[id]))
      throw new AgentMindError(
        'INSTALLER_DEPENDENCY_MISSING',
        'Installed MCP adapter build is missing.',
      );
    if (inspected.recovery === 'LOCK_PRESENT')
      throw new AgentMindError('INSTALLER_BUSY', 'Existing installer lock must be inspected.');
    result.plans = service.plan('setup', selected);
    if (result.plans.some((plan) => plan.disposition === 'CONFLICT')) {
      for (const plan of result.plans) {
        if (plan.disposition === 'CONFLICT')
          result.providers.push({
            cli: plan.cli,
            status: 'FAIL',
            reason: 'CONFIGURATION_CONFLICT',
          });
      }
      throw new AgentMindError(
        result.plans.some((plan) =>
          plan.diagnostics.some((check) => check.message === 'INSTALLER_DEPENDENCY_MISSING'),
        )
          ? 'INSTALLER_DEPENDENCY_MISSING'
          : 'INSTALLER_CONFIGURATION_CONFLICT',
        'Resolve configuration conflicts before registry mutation.',
      );
    }
    if (!apply) {
      checks.push(
        diagnostic(
          'schema',
          'NOT_VERIFIED',
          'Apply creates a missing registry. Existing live schema/ledger checks are deferred; pending migrations require explicit owner-approved digest.',
        ),
      );
      checks.push(
        diagnostic(
          'fts',
          'NOT_VERIFIED',
          'Disposable driver FTS5 probe passed; actual index integrity and MCP startup are deferred to apply.',
        ),
      );
      checks.push(
        diagnostic(
          'mcp-health',
          'NOT_VERIFIED',
          'Apply will initialize/list tools, verify read-only status/project identity and close each installed adapter. No model calls.',
        ),
      );
      return result;
    }
    // Validate plan capabilities before any persistent mutation; underlying apply revalidates again.
    for (const plan of result.plans) service.adapters[plan.cli].validate(plan);
    const registry = prepareRegistry(service.context.database, (value) => {
      stage = value;
    });
    result.registry = registry;
    checks.push(
      diagnostic(
        'registry',
        'PASS',
        registry.created
          ? 'Created through the existing core initializer; migration ledger retained.'
          : 'Existing registry reused; no core schema migration performed.',
      ),
    );
    checks.push(
      diagnostic(
        'schema',
        'PASS',
        `Schema ${registry.schema}; core checksum ledger verified; database reopened.`,
      ),
    );
    checks.push(
      diagnostic(
        'fts',
        'PASS',
        'Engine FTS5 probe and all five actual index integrity checks passed. No rebuild or synthetic user records.',
      ),
    );
    stage = 'configuration';
    if (
      result.plans.every((plan) => plan.disposition === 'SKIP') &&
      service.status(selected).recovery === 'NOT_REQUIRED'
    ) {
      for (const plan of result.plans) service.adapters[plan.cli].validate(plan);
      result.results = result.plans.map((plan) => ({ cli: plan.cli, action: plan.disposition }));
    } else {
      result.results = service.apply(result.plans).results;
    }
    result.applied = true;
    for (const plan of result.plans) {
      result.providers.push({
        cli: plan.cli,
        status: 'PASS',
        reason: plan.disposition === 'SKIP' ? 'ALREADY_CONFIGURED' : 'CONFIGURED',
      });
      checks.push(
        diagnostic(
          `${plan.cli}.integration`,
          'PASS',
          plan.disposition === 'SKIP'
            ? 'Already configured correctly.'
            : 'Managed integration configured.',
          plan.cli,
        ),
      );
    }
    stage = 'mcp-health';
    for (const id of selected) {
      const health = await runtimeDoctor(service, id);
      checks.push(...health);
      if (health.some((check) => check.status !== 'PASS'))
        throw new AgentMindError('INSTALLER_MCP_HEALTH_FAILED', 'Installed MCP health failed.');
    }
    result.ready = true;
    result.exit_code = selected.length === requested.length ? EXIT.success : EXIT.incomplete;
  } catch (error) {
    const code = setupCode(error);
    result.registry = {
      ...result.registry,
      exists: existsSync(service.context.database),
      retained: true,
    };
    checks.push(diagnostic(stage, 'FAIL', code));
    result.exit_code = setupExit(error);
    Object.assign(result, {
      failed_stage: stage,
      error: {
        code,
        message:
          'Setup stopped safely. Preserve existing data and inspect the reported stage and recovery guidance; raw driver/configuration output is suppressed.',
      },
    });
  }
  return result;
}

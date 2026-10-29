import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentMindError } from '@agentmind/core';
import { readBounded, replaceFile } from '../codex/files.js';
import { projectScope, rejectLinks } from '../codex/project.js';
import { type Context, IntegrationAdapter } from './adapter.js';
import { integrationRegistry } from './context.js';
import { canonical } from './files.js';
import { type Action, diagnostic, type InstallPlan, PROVIDERS, type Provider } from './model.js';
export type InstallerOptions = Omit<Context, 'home' | 'database' | 'scope'> & {
  home?: string;
  database?: string;
  scope?: 'project' | 'user';
};
export class UnifiedInstaller {
  readonly context: Context;
  readonly adapters: Record<Provider, IntegrationAdapter>;
  readonly project;
  constructor(options: InstallerOptions) {
    this.project = projectScope(options.root);
    const root = this.project.root,
      home = canonical(options.home ?? homedir());
    const database = integrationRegistry(root, options.database, home);
    if (
      Buffer.byteLength(options.router) > 4096 ||
      !/^---\r?\nname: agentmind-router\r?\ndescription: [^\r\n]+\r?\n---/.test(options.router)
    )
      throw new AgentMindError(
        'INSTALLER_ROUTER_INVALID',
        'Build a valid bounded Router Skill before setup.',
      );
    this.context = Object.freeze({
      ...options,
      root,
      home,
      database,
      scope: options.scope ?? 'project',
      adapters: Object.freeze({ ...options.adapters }),
      executables: Object.freeze({ ...options.executables }),
      isolatedHome: options.home !== undefined,
    });
    this.adapters = Object.fromEntries(
      PROVIDERS.map((id) => [
        id,
        new IntegrationAdapter(
          id,
          id === 'gemini' && !options.home && process.env.GEMINI_CLI_HOME
            ? Object.freeze({ ...this.context, home: canonical(process.env.GEMINI_CLI_HOME) })
            : this.context,
        ),
      ]),
    ) as typeof this.adapters;
  }
  status(ids: readonly Provider[] = PROVIDERS) {
    const start = performance.now();
    const integrations = ids.map((id) => this.adapters[id].inspect());
    let recovery = 'NOT_REQUIRED';
    try {
      const text = readBounded(
        this.context.root,
        join(this.context.root, '.agentmind/installer/last-run.json'),
        1048576,
      );
      if (text && JSON.parse(text).phase !== 'complete') recovery = 'REQUIRED';
      if (existsSync(join(this.context.root, '.agentmind/installer/operation.lock')))
        recovery = 'LOCK_PRESENT';
    } catch {
      recovery = 'INVALID_PRIVATE_JOURNAL';
    }
    return {
      schema_version: 1,
      agentmind_version: '0.0.1',
      recovery,
      project_id: this.project.id,
      project_root: this.project.root,
      scope: this.context.scope,
      registry: {
        path: this.context.database,
        present: existsSync(this.context.database),
        connectivity: 'NOT_VERIFIED_READ_ONLY_INSPECTION',
      },
      mcp_build: Object.fromEntries(ids.map((id) => [id, existsSync(this.context.adapters[id])])),
      integrations,
      protected_deployment: 'NOT_VERIFIED',
      behavioral_sandbox: 'NOT_VERIFIED',
      autonomous_activation: 'DISABLED',
      authentication: 'NOT_VERIFIED_NO_AUTH_PROBES',
      elapsed_ms: performance.now() - start,
      next_steps: [
        'Use doctor for installation checks; --connect explicitly starts an enrolled MCP runtime.',
        'Use setup/repair/uninstall --dry-run before --apply.',
      ],
    };
  }
  plan(action: Action, ids: readonly Provider[] = PROVIDERS) {
    const plans: InstallPlan[] = [];
    this.adapters.gemini.expectSharedRouter(false);
    this.adapters.antigravity.expectSharedRouter(false);
    for (const id of [...ids].sort((a, b) => PROVIDERS.indexOf(a) - PROVIDERS.indexOf(b))) {
      if (
        (id === 'gemini' || (id === 'antigravity' && this.context.scope === 'project')) &&
        action !== 'uninstall' &&
        plans.some((p) => p.cli === 'codex' && ['INSTALL', 'REPAIR'].includes(p.disposition))
      )
        this.adapters[id].expectSharedRouter();
      plans.push(this.adapters[id].plan(action, ids.length > 1));
    }
    // Shared files keep one owner; dependents must leave before their owner changes.
    for (const owner of plans.filter((p) => p.cli === 'codex' || p.cli === 'antigravity')) {
      if (
        owner.disposition === 'SKIP' ||
        owner.disposition === 'CONFLICT' ||
        !(action === 'uninstall' || owner.disposition === 'UPDATE')
      )
        continue;
      for (const dependent of ['gemini', 'antigravity'] as const) {
        if (dependent === owner.cli) continue;
        const raw = readBounded(
          this.context.root,
          join(this.context.root, `.agentmind/${dependent}/installation.json`),
          1048576,
        );
        if (!raw) continue;
        const r = JSON.parse(raw);
        if (
          r.phase !== 'removed' &&
          r.router?.owned === false &&
          owner.operations.some(
            (o) => o.path === r.router.path && o.operation !== 'VERIFY_REUSED',
          ) &&
          !(action === 'uninstall' && ids.includes(dependent))
        ) {
          owner.disposition = 'CONFLICT';
          owner.diagnostics.push(
            diagnostic(
              `${owner.cli}.shared-router`,
              'FAIL',
              `Uninstall ${dependent} before updating/removing its shared router owner; then set it up again.`,
              owner.cli,
            ),
          );
        }
      }
    }
    return plans;
  }
  apply(plans: InstallPlan[]) {
    if (
      !plans.length ||
      plans.length > PROVIDERS.length ||
      new Set(plans.map((p) => p.cli)).size !== plans.length
    )
      throw new AgentMindError('INSTALLER_PLAN_INVALID', 'Select each CLI at most once.');
    for (const p of plans) this.adapters[p.cli].validate(p);
    const root = this.context.root,
      dir = rejectLinks(root, '.agentmind/installer');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ds = lstatSync(dir);
    if ((ds.mode & 0o077) !== 0 || (process.getuid && ds.uid !== process.getuid()))
      throw new AgentMindError(
        'INSTALLER_PERMISSION',
        'Installer state must be private and current-user owned.',
      );
    const lock = join(dir, 'operation.lock');
    let fd: number;
    try {
      fd = openSync(lock, 'wx', 0o600);
    } catch {
      throw new AgentMindError(
        'INSTALLER_BUSY',
        'Another unified operation owns the lock; inspect interrupted work before removing a stale lock.',
      );
    }
    const path = join(dir, 'last-run.json');
    const journal = {
      schema_version: 1,
      id: randomUUID(),
      phase: 'applying',
      plan_ids: plans.map((p) => p.id),
      completed: [] as Provider[],
      compensated: [] as Provider[],
      failed: null as Provider | null,
      failure_code: null as string | null,
    };
    const save = () =>
      replaceFile(root, path, readBounded(root, path, 1048576), JSON.stringify(journal), 1048576);
    try {
      for (const p of plans) this.adapters[p.cli].validate(p);
      save();
      const ordered = plans.every((p) => p.action === 'uninstall')
        ? [...plans].sort((a, b) => {
            const depends = (x: InstallPlan, y: InstallPlan) =>
              x.operations.some(
                (o) =>
                  o.operation === 'VERIFY_REUSED' &&
                  y.operations.some((p) => p.path === o.path && p.operation === 'REMOVE_MANAGED'),
              );
            return depends(a, b)
              ? -1
              : depends(b, a)
                ? 1
                : PROVIDERS.indexOf(b.cli) - PROVIDERS.indexOf(a.cli);
          })
        : plans;
      for (const p of ordered) {
        try {
          this.adapters[p.cli].apply(p);
          journal.completed.push(p.cli);
          if (p.cli === 'codex') {
            this.adapters.gemini.sharedRouterReady();
            this.adapters.antigravity.sharedRouterReady();
          }
          save();
        } catch (error) {
          journal.failure_code =
            error instanceof AgentMindError ? error.code : 'INSTALLER_OPERATION_FAILED';
          journal.failed = p.cli;
          journal.phase = 'recovery-required';
          for (const id of [...journal.completed].reverse()) {
            const prior = plans.find((p) => p.cli === id);
            if (prior?.disposition === 'INSTALL') {
              const sharedDependents = ['gemini', 'antigravity'].some((dependent) => {
                if (dependent === id) return false;
                const text = readBounded(
                  root,
                  join(root, `.agentmind/${dependent}/installation.json`),
                  1048576,
                );
                if (!text) return false;
                const dep = JSON.parse(text);
                return (
                  dep.phase !== 'removed' &&
                  dep.router?.owned === false &&
                  prior.operations.some(
                    (o) => o.path === dep.router.path && o.operation !== 'VERIFY_REUSED',
                  )
                );
              });
              if (sharedDependents) continue;
              try {
                const undo = this.adapters[id].plan('uninstall');
                this.adapters[id].apply(undo);
                journal.compensated.push(id);
              } catch {
                /* Preserve the adapter recovery journal, never force remove. */
              }
            }
          }
          save();
          throw new AgentMindError(
            'INSTALLER_PARTIAL_FAILURE',
            'Operation stopped. Inspect the private installer/provider journals; completed new installs were compensated where safe, other changes were preserved.',
          );
        }
      }
      journal.phase = 'complete';
      save();
      return {
        schema_version: 1,
        applied: true,
        results: plans.map((p) => ({ cli: p.cli, action: p.disposition })),
        journal: join('.agentmind/installer', 'last-run.json'),
        database_retained: true,
        backups_retained: true,
      };
    } finally {
      closeSync(fd);
      unlinkSync(lock);
    }
  }
  diagnostics(ids: readonly Provider[] = PROVIDERS) {
    for (const id of ids) this.adapters[id].detect(true);
    const s = this.status(ids);
    return [
      ...s.integrations.flatMap((i) => [
        diagnostic(
          `${i.cli}.executable`,
          i.detection.state === 'DETECTED'
            ? 'PASS'
            : i.detection.state === 'NOT_INSTALLED'
              ? 'NOT_APPLICABLE'
              : 'FAIL',
          i.detection.state,
          i.cli,
        ),
        Object.assign(
          diagnostic(
            `${i.cli}.installation`,
            i.state === 'CONFIGURED'
              ? 'PASS'
              : i.state === 'CONFIG_ERROR' || i.state === 'POLICY_BLOCKED'
                ? 'FAIL'
                : 'WARNING',
            i.state,
            i.cli,
          ),
          {
            auto_repair:
              i.managed &&
              i.state === 'PARTIALLY_CONFIGURED' &&
              ['MISSING', 'MANAGED_OUTDATED'].includes(i.router),
          },
        ),
        ...i.diagnostics,
        diagnostic(
          `${i.cli}.native`,
          'NOT_VERIFIED',
          'Installed/configured is not authenticated native discovery or Router use.',
          i.cli,
        ),
      ]),
      diagnostic(
        'installer.recovery',
        s.recovery === 'NOT_REQUIRED' ? 'PASS' : 'WARNING',
        s.recovery === 'NOT_REQUIRED'
          ? 'No incomplete unified operation recorded.'
          : 'Inspect private journals and stale locks before recovery; no automatic lock deletion.',
      ),
      Object.assign(
        diagnostic(
          'sec01.protected',
          'NOT_VERIFIED',
          'OS-separated protected deployment is not established by setup. Autonomous activation remains disabled.',
        ),
        {
          privileged_authorization_required: true,
          remediation:
            'Administrator-reviewed protected deployment and independent OS verification are required; the installer cannot provision this.',
        },
      ),
      diagnostic(
        'be001.sandbox',
        'NOT_VERIFIED',
        'No verified executable sandbox is established; static validation availability is not behavioral PASS.',
      ),
    ];
  }
}

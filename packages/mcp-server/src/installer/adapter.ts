import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AgentMindError } from '@agentmind/core';
import { AntigravitySetup } from '../antigravity/setup.js';
import { mcpDocument } from '../claude/configuration.js';
import { ClaudeSetup } from '../claude/setup.js';
import { configBlock } from '../codex/configuration.js';
import { digest, readBounded } from '../codex/files.js';
import { CodexSetup } from '../codex/setup.js';
import { GeminiSetup } from '../gemini/setup.js';
import { detectCli } from './detection.js';
import { canonical, snapshots, validateSnapshot, type Watch } from './files.js';
import {
  type Action,
  type CliIntegrationAdapter,
  type Detection,
  diagnostic,
  type FileOperation,
  type Inspection,
  type InstallPlan,
  type Provider,
} from './model.js';
export type Context = {
  root: string;
  home: string;
  database: string;
  scope: 'project' | 'user';
  router: string;
  adapters: Record<Provider, string>;
  executables?: Partial<Record<Provider, string>>;
  systemDefaults?: string;
  systemSettings?: string;
  isolatedHome?: boolean;
};
type Setup = CodexSetup | ClaudeSetup | GeminiSetup | AntigravitySetup;
type Pending = {
  plan: InstallPlan;
  originalId: string;
  setup: Setup;
  files: ReturnType<typeof snapshots>;
  installationId: string;
  oldRouter: string;
  sharedDependency: boolean;
  uninstall: boolean;
};
export class IntegrationAdapter implements CliIntegrationAdapter {
  #detection?: Detection;
  #fullDetection?: Detection;
  #shared = false;
  #sharedReady = false;
  expectSharedRouter(shared = true) {
    this.#shared = shared;
  }
  sharedRouterReady() {
    this.#sharedReady = true;
  }
  #pending = new WeakMap<InstallPlan, Pending>();
  constructor(
    readonly id: Provider,
    readonly context: Context,
  ) {}
  detect(deep = false) {
    if (deep && !this.#fullDetection)
      this.#fullDetection = detectCli(this.id, this.context.executables?.[this.id], true);
    if (this.#fullDetection) return this.#fullDetection;
    if (!this.#detection)
      this.#detection = detectCli(this.id, this.context.executables?.[this.id], false);
    return this.#detection;
  }
  private paths() {
    const c = this.context;
    return {
      state: join(c.root, `.agentmind/${this.id}/installation.json`),
      enrollment: join(c.root, `.agentmind/${this.id}/enrollment.json`),
      config:
        this.id === 'codex'
          ? join(c.root, '.codex/config.toml')
          : this.id === 'claude'
            ? join(c.root, '.mcp.json')
            : this.id === 'antigravity'
              ? join(
                  c.scope === 'user' ? c.home : c.root,
                  c.scope === 'user' ? '.gemini/config/mcp_config.json' : '.agents/mcp_config.json',
                )
              : join(c.scope === 'user' ? c.home : c.root, '.gemini/settings.json'),
      router: join(
        this.id === 'codex' || c.scope === 'project' ? c.root : c.home,
        this.id === 'antigravity'
          ? c.scope === 'project'
            ? '.agents/skills/agentmind-router/SKILL.md'
            : '.gemini/antigravity-cli/skills/agentmind-router/SKILL.md'
          : this.id === 'codex'
            ? '.agents/skills/agentmind-router/SKILL.md'
            : `.${this.id}/skills/agentmind-router/SKILL.md`,
      ),
    };
  }
  private receipt() {
    const p = this.paths();
    const text = readBounded(this.context.root, p.state, 1048576);
    if (text === null) return null;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new AgentMindError(
        'INSTALLER_RECEIPT_CONFLICT',
        'Malformed integration receipt; preserve and inspect it.',
      );
    }
  }
  private oldRouter() {
    const r = this.receipt();
    const s =
      r && !['removed', 'uninstalled'].includes(String(r.phase))
        ? this.id === 'gemini' || this.id === 'antigravity'
          ? r.router_content
          : r.router
        : undefined;
    return typeof s === 'string' && Buffer.byteLength(s) <= 4096 ? s : this.context.router;
  }
  private setup(router = this.oldRouter()): Setup {
    const c = this.context,
      d = this.detect(),
      base = { root: c.root, database: c.database, adapter: c.adapters[this.id], router };
    if (this.id === 'codex') {
      if (c.scope !== 'project')
        throw new AgentMindError(
          'INSTALLER_SCOPE_UNSUPPORTED',
          'Codex user scope is not supported; no fallback to global configuration.',
        );
      return new CodexSetup({ ...base, codex: d.executable ?? process.execPath });
    }
    if (this.id === 'claude')
      return new ClaudeSetup({
        ...base,
        scope: c.scope,
        home: c.isolatedHome ? c.home : undefined,
        claude: d.executable ?? process.execPath,
      });
    if (this.id === 'antigravity')
      return new AntigravitySetup({
        ...base,
        home: c.home,
        scope: c.scope,
        plannedSharedRouter: c.scope === 'project' && this.#shared,
      });
    return new GeminiSetup({
      ...base,
      scope: c.scope,
      home: c.home,
      gemini: d.executable ?? '/agentmind-missing-gemini',
      systemDefaults: c.systemDefaults,
      systemSettings: c.systemSettings,
      plannedSharedRouter: this.#shared
        ? { root: c.root, path: join(c.root, '.agents/skills/agentmind-router/SKILL.md') }
        : undefined,
    });
  }
  inspect(): Inspection {
    const d = this.detect();
    const result: Inspection = {
      cli: this.id,
      detection: d,
      config_path: this.paths().config,
      registry_path: this.context.database,
      state: d.state,
      scope: this.context.scope,
      managed: false,
      router: 'MISSING',
      mcp: 'MISSING',
      hooks: 'NOT_MANAGED_PRESERVED',
      hooks_present: false,
      router_candidates: 0,
      hook_validation: this.id === 'codex' ? 'NOT_APPLICABLE' : 'NOT_VERIFIED',
      diagnostics: [],
    };
    if (this.id === 'antigravity' && this.context.scope === 'project') {
      result.state = 'UNSUPPORTED_SCOPE';
      result.mcp = 'NOT_VERIFIED';
      result.diagnostics.push(
        diagnostic(
          'antigravity.scope',
          'WARNING',
          'Standalone project MCP discovery is unsupported. Use --cli antigravity --scope user explicitly; enrollment remains project-bound.',
          this.id,
        ),
      );
      return result;
    }
    try {
      const s = this.setup(),
        r = this.receipt(),
        st = s.status();
      const recordActive = r && !['removed', 'uninstalled'].includes(String(r.phase));
      result.managed = !!recordActive;
      const path =
        this.id === 'codex'
          ? this.paths().router
          : this.id === 'claude'
            ? (s as ClaudeSetup).routerPath
            : ((s as GeminiSetup | AntigravitySetup).state()?.router.path ?? this.paths().router);
      const router = readBounded(
        this.context.scope === 'user' && this.id !== 'codex'
          ? this.context.home
          : this.context.root,
        path,
      );
      const installed = st.installed;
      if ('migration_pending' in st && st.migration_pending)
        result.diagnostics.push(
          diagnostic(
            'antigravity.migration',
            'WARNING',
            'Migration is staged; rerun setup --cli antigravity --scope user --apply to verify before legacy cleanup. Uninstall rolls back the pending registration.',
            this.id,
          ),
        );
      result.router_candidates = [this.context.root, this.context.home]
        .flatMap((root) =>
          (this.id === 'gemini'
            ? ['.agents', '.gemini']
            : this.id === 'antigravity'
              ? ['.agents', '.gemini/antigravity-cli']
              : this.id === 'codex'
                ? ['.agents']
                : ['.claude']
          ).map((dir) => join(root, dir, 'skills/agentmind-router/SKILL.md')),
        )
        .filter((path) => existsSync(path)).length;
      if (result.router_candidates > 1)
        result.diagnostics.push(
          diagnostic(
            `${this.id}.router-precedence`,
            'WARNING',
            'Multiple native router copies exist. Inspect CLI precedence; user-owned files are preserved.',
            this.id,
          ),
        );
      if (this.id !== 'codex') {
        const paths =
          this.id === 'claude'
            ? [
                join(this.context.root, '.claude/settings.json'),
                join(this.context.root, '.claude/settings.local.json'),
                join(
                  process.env.CLAUDE_CONFIG_DIR && !this.context.isolatedHome
                    ? process.env.CLAUDE_CONFIG_DIR
                    : join(this.context.home, '.claude'),
                  'settings.json',
                ),
              ]
            : (s as GeminiSetup | AntigravitySetup).layers.map((l) => l.path);
        for (const path of paths) {
          if (!existsSync(path)) continue;
          try {
            const d = mcpDocument(readBounded(canonical(dirname(path)), path));
            if (d.hooks && typeof d.hooks === 'object' && Object.keys(d.hooks).length)
              result.hooks_present = true;
          } catch {
            result.diagnostics.push(
              diagnostic(
                `${this.id}.hooks-inspection`,
                'WARNING',
                'Native hook settings are malformed or inaccessible; they are preserved, never executed or repaired.',
                this.id,
              ),
            );
          }
        }
      }
      result.router =
        router === null
          ? 'MISSING'
          : router !== this.oldRouter()
            ? 'UNOWNED_OR_CONFLICT'
            : !recordActive
              ? 'UNOWNED_OR_CONFLICT'
              : router !== this.context.router
                ? 'MANAGED_OUTDATED'
                : (s instanceof GeminiSetup || s instanceof AntigravitySetup) &&
                    s.state()?.router.owned === false
                  ? 'REUSED_READ_ONLY'
                  : 'MANAGED_CURRENT';
      result.mcp =
        this.context.scope === 'user' && this.id === 'claude'
          ? 'NOT_VERIFIED'
          : installed
            ? 'REGISTERED'
            : recordActive
              ? 'CONFLICT'
              : 'MISSING';
      result.state =
        'policy_blocked' in st && st.policy_blocked
          ? 'POLICY_BLOCKED'
          : ('conflict' in st && st.conflict) || result.router === 'UNOWNED_OR_CONFLICT'
            ? 'CONFIG_ERROR'
            : installed && router === this.context.router
              ? 'CONFIGURED'
              : recordActive
                ? 'PARTIALLY_CONFIGURED'
                : d.state;
      if (d.state === 'NOT_INSTALLED')
        result.state = recordActive ? 'PARTIALLY_CONFIGURED' : 'NOT_INSTALLED';
      if (d.state === 'UNSUPPORTED_VERSION') result.state = 'UNSUPPORTED_VERSION';
      if (
        this.id === 'claude' &&
        this.context.scope === 'user' &&
        recordActive &&
        installed &&
        result.router === 'MANAGED_CURRENT'
      )
        result.state = 'PARTIALLY_CONFIGURED';
      result.diagnostics.push(
        diagnostic(
          `${this.id}.ownership`,
          result.state === 'CONFIG_ERROR' ? 'FAIL' : recordActive ? 'PASS' : 'NOT_APPLICABLE',
          recordActive
            ? 'Existing receipt and native adapter inspect operational ownership.'
            : 'No managed installation; user entries are never adopted.',
          this.id,
        ),
      );
    } catch (e) {
      result.state = 'CONFIG_ERROR';
      result.diagnostics.push(
        diagnostic(
          `${this.id}.configuration`,
          'FAIL',
          this.code(e) === 'ANTIGRAVITY_SCOPE_UNSUPPORTED'
            ? 'ANTIGRAVITY_SCOPE_UNSUPPORTED: Use --cli antigravity --scope user; project authorization remains enforced.'
            : this.code(e),
          this.id,
        ),
      );
    }
    return result;
  }
  private code(e: unknown) {
    return e instanceof AgentMindError && /^[A-Z0-9_]+$/.test(e.code)
      ? e.code
      : 'INSTALLER_INSPECTION_FAILED';
  }
  private watches(s: Setup): Watch[] {
    const c = this.context,
      p = this.paths(),
      root = c.root;
    const files: Watch[] = [
      { root, path: p.state },
      { root, path: p.enrollment },
      {
        root:
          (this.id === 'gemini' || this.id === 'antigravity') && c.scope === 'user' ? c.home : root,
        path: p.config,
      },
      { root: this.id !== 'codex' && c.scope === 'user' ? c.home : root, path: p.router },
      { root: root, path: join(root, `.agentmind/${this.id}/.gitignore`) },
    ];
    for (const home of [root, c.home])
      for (const dir of this.id === 'gemini'
        ? ['.agents', '.gemini']
        : this.id === 'antigravity'
          ? ['.agents', '.gemini/antigravity-cli']
          : this.id === 'codex'
            ? ['.agents']
            : ['.claude']) {
        const path = join(home, dir, 'skills/agentmind-router/SKILL.md');
        if (!files.some((w) => w.path === path)) files.push({ root: home, path });
      }
    if (s instanceof GeminiSetup || s instanceof AntigravitySetup)
      for (const l of s.layers) {
        const path = l.path;
        if (!files.some((w) => w.path === path)) {
          let parent = join(path, '..');
          while (!existsSync(parent)) parent = join(parent, '..');
          files.push({ root: l.root ?? parent, path });
        }
      }
    if (this.id === 'claude' && c.scope === 'user')
      files.push({ root: c.home, path: join(c.home, '.claude.json'), opaque: true });
    // Build/executable identities are part of consent. No directory or arbitrary paths come from proposals.
    for (const path of [c.adapters[this.id], this.detect().executable, process.execPath])
      if (path) files.push({ root: join(path, '..'), path, opaque: path !== c.adapters[this.id] });
    return [...new Map(files.map((f) => [f.path, f])).values()];
  }
  plan(action: Action, skipUnsupported = false): InstallPlan {
    const c = this.context,
      p = this.paths(),
      d = this.detect();
    const plan: InstallPlan = {
      schema_version: 1,
      id: '',
      cli: this.id,
      scope: c.scope,
      action,
      disposition: 'CONFLICT',
      operations: [],
      preconditions_digest: '',
      native_operations: [],
      journal_paths: [
        p.state,
        join(c.root, `.agentmind/${this.id}/.gitignore`),
        join(c.root, `.agentmind/${this.id}/setup.lock`),
        join(c.root, '.agentmind/installer/last-run.json'),
        join(c.root, '.agentmind/installer/operation.lock'),
      ],
      backup: 'Existing adapter private receipt/backups; never stdout.',
      rollback:
        'Adapter phase journal recovery; completed new installs can be compensated with owned uninstall. No filesystem ACID guarantee.',
      postcondition:
        action === 'uninstall'
          ? 'Managed registration removed; database and unrelated artifacts preserved.'
          : 'Adapter installed status and exact router/version binding.',
      risks: [
        'Supervised same-UID configuration ownership is not OS authorization.',
        'Native trust/authentication and model discovery are NOT VERIFIED.',
      ],
      diagnostics: [],
    };
    try {
      const existing = this.receipt();
      const managed = existing && !['removed', 'uninstalled'].includes(String(existing.phase));
      if (
        action !== 'uninstall' &&
        !(['repair', 'update'].includes(action) && !managed) &&
        d.state !== 'DETECTED'
      )
        throw new AgentMindError(
          'INSTALLER_DEPENDENCY_MISSING',
          'Install a compatible official CLI before setup; status never starts a model.',
        );
      const s = this.setup(),
        files = snapshots(this.watches(s));
      const seed = digest(
        JSON.stringify([this.id, c.root, c.database, c.scope, action, files, c.router]),
      );
      const installationId = `${seed.slice(0, 8)}-${seed.slice(8, 12)}-4${seed.slice(13, 16)}-a${seed.slice(17, 20)}-${seed.slice(20, 32)}`;
      let nativePlan: ReturnType<Setup['plan']> | undefined;
      plan.journal_paths.push(
        this.id === 'codex'
          ? join(c.root, `.agentmind/codex/backups/${installationId}.json`)
          : join(c.root, `.agentmind/${this.id}/backup-${installationId}.json`),
      );
      if (c.scope === 'user' && this.id !== 'codex')
        plan.journal_paths.push(
          join(
            c.home,
            this.id === 'antigravity'
              ? '.gemini/antigravity-cli/agentmind-integration/setup.lock'
              : `.${this.id}/agentmind-integration/setup.lock`,
          ),
        );
      const r = this.receipt();
      const old = this.oldRouter();
      const active = !!r && !['removed', 'uninstalled'].includes(String(r.phase));
      if (
        skipUnsupported &&
        this.id === 'antigravity' &&
        c.scope === 'project' &&
        action !== 'uninstall'
      ) {
        plan.disposition = 'SKIP';
        plan.diagnostics.push(
          diagnostic(
            'antigravity.scope',
            'WARNING',
            'USER_SCOPE_REQUIRED: Antigravity was skipped; use --cli antigravity --scope user explicitly.',
            this.id,
          ),
        );
      } else if ((action === 'repair' || action === 'update') && !active) {
        plan.disposition = 'SKIP';
        plan.diagnostics.push(
          diagnostic(
            `${this.id}.repair`,
            'NOT_APPLICABLE',
            'No managed receipt; repair/update does not adopt or install user artifacts.',
            this.id,
          ),
        );
      } else if (action === 'uninstall') {
        const out = s.uninstall(false);
        plan.disposition = out.action === 'SKIP' ? 'SKIP' : 'REMOVE';
      } else {
        nativePlan = s.plan(installationId);
        const raw = nativePlan;
        if (active && old !== c.router && s instanceof AntigravitySetup)
          s.validateRouterUpdate(c.router);
        plan.disposition =
          raw.action === 'MIGRATE'
            ? 'MIGRATE'
            : active &&
                (old !== c.router ||
                  (s instanceof AntigravitySetup &&
                    JSON.stringify(s.state()?.entry) !== JSON.stringify(s.entry())))
              ? 'UPDATE'
              : raw.action === 'INSTALL'
                ? 'INSTALL'
                : raw.action === 'SKIP'
                  ? s.status().installed
                    ? 'SKIP'
                    : 'REPAIR'
                  : raw.action === 'REPAIR'
                    ? 'REPAIR'
                    : 'REPAIR';
      }
      const operations: FileOperation[] = [];
      if (plan.disposition !== 'SKIP') {
        if (s instanceof CodexSetup) {
          const record =
            action === 'uninstall'
              ? s.state()
              : nativePlan && 'record' in nativePlan
                ? nativePlan.record
                : null;
          if (!record) throw Error();
          for (const x of record.changes) {
            const path = join(c.root, x.path),
              before = readBounded(c.root, path);
            const after =
              action === 'uninstall'
                ? x.path === '.codex/config.toml'
                  ? (before ?? '').replace(configBlock(record), '') ||
                    (record.changes[0]?.before === null ? null : '')
                  : null
                : x.path.includes('SKILL.md')
                  ? c.router
                  : plan.disposition === 'UPDATE' && x.path.includes('enrollment.json')
                    ? `${JSON.stringify(
                        { ...JSON.parse(x.after ?? '{}'), installation_id: installationId },
                        null,
                        2,
                      )}\n`
                    : plan.disposition === 'UPDATE' && x.path === '.codex/config.toml'
                      ? (before ?? '').replace(configBlock(record), '') +
                        configBlock({ ...record, installation_id: installationId })
                      : x.after;
            operations.push(this.operation(path, before, after, active));
          }
        } else {
          const raw =
            action === 'uninstall'
              ? s.state()
              : nativePlan && 'state' in nativePlan
                ? nativePlan.state
                : nativePlan && 'receipt' in nativePlan
                  ? nativePlan.receipt
                  : null;
          if (!raw) throw Error();
          const entry =
              s instanceof AntigravitySetup && plan.disposition === 'UPDATE'
                ? s.entry()
                : raw.entry,
            doc = mcpDocument(
              readBounded(
                (s instanceof GeminiSetup || s instanceof AntigravitySetup) && c.scope === 'user'
                  ? c.home
                  : rootOf(c),
                p.config,
              ),
            );
          if (action === 'uninstall' || plan.disposition === 'UPDATE')
            delete doc.mcpServers[s.serverName];
          if (action !== 'uninstall') doc.mcpServers[s.serverName] = entry;
          const configBefore = readBounded(
            (s instanceof GeminiSetup || s instanceof AntigravitySetup) && c.scope === 'user'
              ? c.home
              : c.root,
            p.config,
          );
          const originalText = 'config_before' in raw ? raw.config_before : raw.before;
          const configAfter =
            action === 'uninstall' &&
            JSON.stringify(doc) === JSON.stringify(mcpDocument(originalText))
              ? originalText
              : `${JSON.stringify(doc, null, 2)}\n`;
          if (!(s instanceof ClaudeSetup && c.scope === 'user'))
            operations.push(this.operation(p.config, configBefore, configAfter, active, true));
          const routerPath =
            s instanceof GeminiSetup || s instanceof AntigravitySetup
              ? rawRouter(raw, p.router)
              : s.routerPath;
          const own =
            s instanceof GeminiSetup || s instanceof AntigravitySetup
              ? (raw as ReturnType<GeminiSetup['plan']>['receipt']).router.owned
              : true;
          const routerRoot = routerPath.startsWith(`${c.root}/`) ? c.root : c.home;
          const routerBefore = readBounded(routerRoot, routerPath);
          const routerOperation = this.operation(
            routerPath,
            routerBefore,
            action === 'uninstall' ? (own ? null : routerBefore) : c.router,
            active,
          );
          operations.push({
            ...routerOperation,
            operation: own ? routerOperation.operation : 'VERIFY_REUSED',
            ownership: own ? (active ? 'MANAGED' : 'UNOWNED_ABSENT') : 'REUSED_READ_ONLY',
          });
          operations.push(
            this.operation(
              p.enrollment,
              readBounded(c.root, p.enrollment),
              action === 'uninstall'
                ? s instanceof AntigravitySetup &&
                  'migration' in raw &&
                  raw.migration &&
                  !raw.migration.completed
                  ? raw.migration.legacy.enrollment
                  : null
                : plan.disposition === 'UPDATE'
                  ? JSON.stringify({
                      ...JSON.parse(raw.enrollment),
                      installation_id: installationId,
                    })
                  : raw.enrollment,
              active,
            ),
          );
        }
      }
      if (this.id === 'claude' && c.scope === 'user' && plan.disposition !== 'SKIP') {
        const receipt = (s as ClaudeSetup).state();
        const entry = receipt?.entry ?? {
          type: 'stdio',
          command: process.execPath,
          args: [c.adapters.claude, '--enrollment', p.enrollment],
        };
        plan.native_operations.push({
          kind: action === 'uninstall' ? 'OFFICIAL_CLI_REMOVE' : 'OFFICIAL_CLI_UPSERT',
          server_name: s.serverName,
          scope: 'user',
          entry_digest: digest(JSON.stringify(entry)),
          before_state: 'OPAQUE_IDENTITY_AND_AT_APPLY_CHECK',
        });
      }
      plan.operations = operations;
      if (s instanceof AntigravitySetup && c.scope === 'user' && action !== 'uninstall') {
        const removal = s.legacyRemoval();
        if (removal)
          plan.post_health_operations = [
            this.operation(removal.path, removal.before, removal.after, true, true),
          ];
      }
      plan.preconditions_digest = digest(JSON.stringify(files));
      plan.id = digest(JSON.stringify(plan));
      this.#pending.set(plan, {
        plan,
        originalId: plan.id,
        setup: s,
        files,
        installationId,
        oldRouter: old,
        sharedDependency: this.#shared,
        uninstall: action === 'uninstall',
      });
    } catch (e) {
      plan.diagnostics.push(
        diagnostic(
          `${this.id}.plan`,
          'FAIL',
          this.code(e) === 'ANTIGRAVITY_SCOPE_UNSUPPORTED'
            ? 'ANTIGRAVITY_SCOPE_UNSUPPORTED: Use --cli antigravity --scope user; project authorization remains enforced.'
            : this.code(e),
          this.id,
        ),
      );
      plan.id = digest(JSON.stringify(plan));
    }
    return plan;
  }
  private operation(
    path: string,
    before: string | null,
    after: string | null,
    active: boolean,
    merge = false,
  ): FileOperation {
    return {
      path,
      operation:
        before === after
          ? 'SKIP'
          : after === null
            ? 'REMOVE_MANAGED'
            : before === null
              ? 'CREATE'
              : merge
                ? 'MERGE_MANAGED_ENTRY'
                : 'REPLACE_MANAGED',
      ownership: merge
        ? 'USER_CONTENT_PRESERVED'
        : active
          ? 'MANAGED'
          : before === null
            ? 'UNOWNED_ABSENT'
            : 'REUSED_READ_ONLY',
      before_digest: before === null ? null : digest(before),
      after_digest: after === null ? null : digest(after),
    };
  }
  validate(plan: InstallPlan) {
    const p = this.#pending.get(plan);
    if (
      !p ||
      plan.id !== p.originalId ||
      plan.disposition === 'CONFLICT' ||
      digest(JSON.stringify({ ...plan, id: '' })) !== plan.id
    )
      throw new AgentMindError(
        'INSTALLER_PLAN_INVALID',
        'Plan is altered, foreign or conflicting; no write authorized.',
      );
    const allowed = new Map<string, string>();
    if (this.id === 'codex')
      allowed.set(join(this.context.root, '.agentmind/codex/.gitignore'), digest('*\n'));
    if (p.sharedDependency && this.#sharedReady)
      allowed.set(
        join(this.context.root, '.agents/skills/agentmind-router/SKILL.md'),
        digest(this.context.router),
      );
    validateSnapshot(p.files, allowed);
  }
  private verifyPostimages(plan: InstallPlan) {
    for (const o of plan.operations) {
      const root = o.path.startsWith(`${this.context.root}/`)
        ? this.context.root
        : this.context.home;
      const value = readBounded(root, o.path);
      if ((value === null ? null : digest(value)) !== o.after_digest)
        throw new AgentMindError(
          'INSTALLER_VERIFY_FAILED',
          'Published integration differs from its planned digest; recovery journal retained.',
        );
    }
  }
  apply(plan: InstallPlan) {
    this.validate(plan);
    if (plan.disposition === 'SKIP') return;
    const p = this.#pending.get(plan);
    if (!p) throw Error();
    const guard = () => this.validate(plan);
    if (p.uninstall) {
      p.setup.uninstall(true, guard);
      this.verifyPostimages(plan);
      return;
    }
    if (plan.disposition === 'UPDATE') {
      p.setup.uninstall(true, guard);
      const next = this.setup(this.context.router);
      next.setup({ installationId: p.installationId });
      if (!next.status().installed)
        throw new AgentMindError(
          'INSTALLER_VERIFY_FAILED',
          'Router update did not reach installed state; receipts retained.',
        );
    } else {
      p.setup.setup({ beforeWrite: guard, installationId: p.installationId });
      if (
        p.setup instanceof ClaudeSetup &&
        p.setup.scope === 'user' &&
        !p.setup.verifyUserRegistration()
      )
        throw new AgentMindError(
          'INSTALLER_VERIFY_FAILED',
          'Official CLI registration could not be verified after apply.',
        );
      if (!p.setup.status().installed)
        throw new AgentMindError(
          'INSTALLER_VERIFY_FAILED',
          'Installation did not reach verified installed state.',
        );
    }
    this.verifyPostimages(plan);
  }
}
const rootOf = (c: Context) => c.root;
function rawRouter(r: unknown, fallback: string) {
  return (r as { router?: { path?: string } }).router?.path ?? fallback;
}

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { AgentMindError, enrollmentSchema } from '@agentmind/core';
import { DAILY_TOOLS } from '../codex/configuration.js';
import { readBounded, replaceFile } from '../codex/files.js';
import { projectScope, rejectLinks } from '../codex/project.js';
import { geminiCapabilities, settingsDocument } from './configuration.js';
import { inspectPolicy, type SettingsLayer } from './policy.js';

type Scope = 'project' | 'user';
type Router = { root: string; path: string; owned: boolean };
type Receipt = {
  schema: 1;
  id: string;
  root: string;
  database: string;
  scope: Scope;
  phase: 'installing' | 'installed' | 'removing' | 'removed';
  entry: ReturnType<GeminiSetup['entry']>;
  enrollment: string;
  router: Router;
  router_content: string;
  before: string | null;
};
export type GeminiOptions = {
  root: string;
  database: string;
  adapter: string;
  router: string;
  scope?: Scope;
  home?: string;
  systemDefaults?: string;
  systemSettings?: string;
  gemini?: string;
};
export class GeminiSetup {
  readonly root: string;
  readonly database: string;
  readonly adapter: string;
  readonly home: string;
  readonly scope: Scope;
  readonly node = realpathSync(process.execPath);
  readonly serverName = 'agentmind';
  readonly enrollment: string;
  readonly statePath: string;
  readonly config: string;
  readonly layers: SettingsLayer[];
  constructor(readonly options: GeminiOptions) {
    this.root = projectScope(options.root).root;
    this.database = options.database;
    if (!isAbsolute(this.database) || !isAbsolute(options.adapter))
      throw new AgentMindError('GEMINI_SETUP_INVALID', 'Use absolute registry and adapter paths.');
    this.adapter = realpathSync(options.adapter);
    if (!readFileSync(this.adapter, 'utf8').includes('loadGeminiEnrollment'))
      throw new AgentMindError('GEMINI_BUILD_MISSING', 'Build the Gemini adapter first.');
    this.home = realpathSync(options.home ?? process.env.GEMINI_CLI_HOME ?? homedir());
    this.scope = options.scope ?? 'project';
    if (!['project', 'user'].includes(this.scope))
      throw new AgentMindError('GEMINI_SETUP_INVALID', 'Use project or user scope.');
    for (const path of [this.root, this.home, this.database, this.adapter, this.node])
      if (/[\r\n\t$]/.test(path))
        throw new AgentMindError(
          'GEMINI_PATH_UNSUPPORTED',
          'Control characters and dollar expansion syntax are unsupported in literal Gemini configuration paths.',
        );
    this.enrollment = join(this.root, '.agentmind/gemini/enrollment.json');
    this.statePath = join(this.root, '.agentmind/gemini/installation.json');
    this.config = join(this.scope === 'project' ? this.root : this.home, '.gemini/settings.json');
    const system =
      process.platform === 'darwin' ? '/Library/Application Support/GeminiCli' : '/etc/gemini-cli';
    this.layers = [
      {
        label: 'system-defaults',
        path:
          options.systemDefaults ??
          process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH ??
          join(system, 'system-defaults.json'),
      },
      { label: 'user', path: join(this.home, '.gemini/settings.json'), root: this.home },
      { label: 'project', path: join(this.root, '.gemini/settings.json'), root: this.root },
      {
        label: 'system',
        path:
          options.systemSettings ??
          process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH ??
          join(system, 'settings.json'),
      },
    ];
  }
  entry() {
    return {
      command: this.node,
      args: [this.adapter, '--enrollment', this.enrollment],
      timeout: 30000,
      trust: false,
      includeTools: [...DAILY_TOOLS],
    };
  }
  private settingsRoot() {
    return this.scope === 'project' ? this.root : this.home;
  }
  private text() {
    return readBounded(this.settingsRoot(), this.config);
  }
  private slots(): Router[] {
    return [this.root, this.home].flatMap((root) =>
      ['.agents', '.gemini'].map((dir) => ({
        root,
        path: join(root, dir, 'skills/agentmind-router/SKILL.md'),
        owned: false,
      })),
    );
  }
  private routerRead(r: Router) {
    return readBounded(r.root, r.path);
  }
  private routerChoice(): Router {
    const existing = this.slots().filter((r) => this.routerRead(r) !== null);
    if (existing.some((r) => this.routerRead(r) !== this.options.router))
      throw new AgentMindError(
        'GEMINI_ROUTER_CONFLICT',
        'An existing router differs; inspect discovery precedence instead of overwriting or duplicating it.',
      );
    if (existing[0]) return existing[0];
    const root = this.settingsRoot();
    return { root, path: join(root, '.gemini/skills/agentmind-router/SKILL.md'), owned: true };
  }
  state(): Receipt | null {
    const text = readBounded(this.root, this.statePath, 524288);
    if (text === null) return null;
    let r: Receipt;
    try {
      r = JSON.parse(text);
    } catch {
      throw new AgentMindError('GEMINI_RECEIPT_INVALID', 'Malformed receipt.');
    }
    if (
      r?.schema !== 1 ||
      !/^[-a-f0-9]{36}$/.test(r.id) ||
      r.root !== this.root ||
      r.scope !== this.scope ||
      r.database !== this.database ||
      r.router_content !== this.options.router ||
      !['installing', 'installed', 'removing', 'removed'].includes(r.phase) ||
      JSON.stringify(r.entry) !== JSON.stringify(this.entry()) ||
      !(r.before === null || typeof r.before === 'string') ||
      !this.slots().some((s) => s.root === r.router?.root && s.path === r.router?.path) ||
      typeof r.router?.owned !== 'boolean'
    )
      throw new AgentMindError(
        'GEMINI_RECEIPT_CONFLICT',
        'Receipt differs from this scope/build; no force adoption is supported.',
      );
    if (
      r.router.owned &&
      (r.router.root !== this.settingsRoot() ||
        r.router.path !== join(this.settingsRoot(), '.gemini/skills/agentmind-router/SKILL.md'))
    )
      throw new AgentMindError('GEMINI_RECEIPT_INVALID', 'Unexpected managed router location.');
    const raw = JSON.parse(r.enrollment);
    if (raw.integration !== 'agentmind-gemini-v1')
      throw new AgentMindError('GEMINI_RECEIPT_INVALID', 'Wrong integration.');
    const e = enrollmentSchema.parse({ ...raw, integration: 'agentmind-codex-v1' });
    if (
      e.project_root !== this.root ||
      e.project_id !== projectScope(this.root).id ||
      e.database !== this.database ||
      e.installation_id !== r.id
    )
      throw new AgentMindError('GEMINI_RECEIPT_INVALID', 'Enrollment mismatch.');
    return r;
  }
  policy(r?: Receipt | null) {
    return inspectPolicy(
      this.layers,
      this.config,
      r && r.phase !== 'removed' ? r.entry : undefined,
    );
  }
  private check(r: Receipt) {
    const entry = settingsDocument(this.text()).mcpServers.agentmind;
    if (entry !== undefined && JSON.stringify(entry) !== JSON.stringify(r.entry))
      throw new AgentMindError('GEMINI_SETUP_CONFLICT', 'Managed entry changed; preserving it.');
    const enrollment = readBounded(this.root, this.enrollment),
      router = this.routerRead(r.router);
    if (enrollment !== null && enrollment !== r.enrollment)
      throw new AgentMindError('GEMINI_SETUP_CONFLICT', 'Enrollment changed.');
    if ((router !== null && router !== r.router_content) || (!r.router.owned && router === null))
      throw new AgentMindError(
        'GEMINI_ROUTER_CONFLICT',
        'Managed or reused router changed/missing; refresh explicitly.',
      );
    if (
      this.slots().some((s) => {
        const text = this.routerRead(s);
        return text !== null && text !== r.router_content;
      })
    )
      throw new AgentMindError('GEMINI_ROUTER_CONFLICT', 'A conflicting discovery tier appeared.');
  }
  plan() {
    const r = this.state(),
      capabilities = geminiCapabilities(this.options.gemini);
    if (capabilities.compatibility === 'FAIL')
      throw new AgentMindError(
        'GEMINI_UNSUPPORTED',
        'Installed CLI lacks required public MCP/Skills interfaces.',
      );
    const policy = this.policy(r);
    if (policy.blockers.length || policy.collisions.length)
      throw new AgentMindError(
        'GEMINI_POLICY_BLOCKED',
        `Existing settings prevent setup (${[...policy.blockers, ...policy.collisions].join(', ')}); policy is never rewritten.`,
      );
    if (r && r.phase !== 'removed') {
      this.check(r);
      return {
        action:
          r.phase !== 'installed'
            ? 'RECOVER'
            : readBounded(this.root, this.enrollment) === r.enrollment &&
                this.routerRead(r.router) === r.router_content &&
                JSON.stringify(settingsDocument(this.text()).mcpServers.agentmind) ===
                  JSON.stringify(r.entry)
              ? 'SKIP'
              : 'REPAIR',
        receipt: r,
        capabilities,
        policy,
      };
    }
    if (readBounded(this.root, this.enrollment) !== null)
      throw new AgentMindError('GEMINI_SETUP_CONFLICT', 'Unowned enrollment exists.');
    const id = randomUUID(),
      router = this.routerChoice();
    const receipt: Receipt = {
      schema: 1,
      id,
      root: this.root,
      database: this.database,
      scope: this.scope,
      phase: 'installing',
      entry: this.entry(),
      router,
      router_content: this.options.router,
      before: this.text(),
      enrollment: JSON.stringify({
        schema_version: 1,
        integration: 'agentmind-gemini-v1',
        installation_id: id,
        project_root: this.root,
        project_id: projectScope(this.root).id,
        database: this.database,
        mode: 'supervised-local',
      }),
    };
    if (Buffer.byteLength(receipt.enrollment) > 4096)
      throw new AgentMindError('GEMINI_SETUP_INVALID', 'Enrollment exceeds bounds.');
    return { action: 'INSTALL', receipt, capabilities, policy };
  }
  private lock<T>(f: () => T) {
    const parents = [
      { root: this.root, path: '.agentmind/gemini' },
      { root: this.settingsRoot(), path: '.gemini/agentmind-integration' },
    ];
    const held: { fd: number; path: string }[] = [];
    try {
      for (const p of parents) {
        const dir = rejectLinks(p.root, p.path);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const s = lstatSync(dir);
        if ((s.mode & 0o077) !== 0 || (process.getuid && s.uid !== process.getuid()))
          throw new AgentMindError(
            'GEMINI_PRIVATE_STATE_UNSAFE',
            'State directory must be owned by this user, mode 0700.',
          );
        const path = join(dir, 'setup.lock');
        let fd: number;
        try {
          fd = openSync(path, 'wx', 0o600);
        } catch {
          throw new AgentMindError(
            'GEMINI_SETUP_BUSY',
            'Integration is locked; inspect interrupted operations before removing a stale lock.',
          );
        }
        held.push({ fd, path });
      }
      return f();
    } finally {
      for (const h of held.reverse()) {
        closeSync(h.fd);
        unlinkSync(h.path);
      }
    }
  }
  private save(r: Receipt) {
    replaceFile(
      this.root,
      this.statePath,
      readBounded(this.root, this.statePath, 524288),
      JSON.stringify(r),
      524288,
    );
  }
  private registration(r: Receipt, remove: boolean) {
    const before = this.text(),
      d = settingsDocument(before);
    if (
      Object.hasOwn(d.mcpServers, 'agentmind') &&
      JSON.stringify(d.mcpServers.agentmind) !== JSON.stringify(r.entry)
    )
      throw new AgentMindError('GEMINI_SETUP_CONFLICT', 'Entry changed before publication.');
    if (remove) delete d.mcpServers.agentmind;
    else d.mcpServers.agentmind = r.entry;
    const original = settingsDocument(r.before),
      after =
        JSON.stringify(d) === JSON.stringify(original)
          ? r.before
          : `${JSON.stringify(d, null, 2)}\n`;
    if (after !== null && Buffer.byteLength(after) > 131072)
      throw new AgentMindError(
        'GEMINI_SETTINGS_OVERSIZED',
        'Settings plus integration exceeds 128KiB.',
      );
    replaceFile(this.settingsRoot(), this.config, before, after);
  }
  setup() {
    return this.lock(() => {
      const p = this.plan(),
        r = p.receipt;
      if (p.action === 'SKIP') return this.status();
      if (r.phase === 'removing')
        throw new AgentMindError('GEMINI_RECOVERY_REQUIRED', 'Finish uninstall first.');
      if (p.action === 'INSTALL') {
        const backup = join(this.root, `.agentmind/gemini/backup-${r.id}.json`);
        replaceFile(this.root, backup, null, JSON.stringify({ settings_before: r.before }), 524288);
        const ignore = join(this.root, '.agentmind/gemini/.gitignore');
        if (!existsSync(ignore)) replaceFile(this.root, ignore, null, '*\n');
        this.save(r);
      }
      this.check(r);
      replaceFile(
        this.root,
        this.enrollment,
        readBounded(this.root, this.enrollment),
        r.enrollment,
      );
      if (r.router.owned)
        replaceFile(r.router.root, r.router.path, this.routerRead(r.router), r.router_content);
      this.registration(r, false);
      r.phase = 'installed';
      this.save(r);
      return this.status();
    });
  }
  uninstall(apply = false) {
    const r = this.state();
    if (!r || r.phase === 'removed') return { action: 'SKIP', installed: false };
    this.check(r);
    if (!apply)
      return {
        action: 'REMOVE',
        dry_run: true,
        router_action: r.router.owned ? 'REMOVE_MANAGED' : 'PRESERVE_REUSED',
      };
    return this.lock(() => {
      const current = this.state();
      if (!current) throw new AgentMindError('GEMINI_SETUP_CONFLICT', 'Receipt disappeared.');
      this.check(current);
      current.phase = 'removing';
      this.save(current);
      this.registration(current, true);
      if (current.router.owned)
        replaceFile(
          current.router.root,
          current.router.path,
          this.routerRead(current.router),
          null,
        );
      replaceFile(this.root, this.enrollment, readBounded(this.root, this.enrollment), null);
      current.phase = 'removed';
      this.save(current);
      return {
        action: 'REMOVED',
        database_retained: true,
        backups_retained: true,
        reused_router_preserved: !current.router.owned,
      };
    });
  }
  status() {
    const r = this.state();
    let conflict = false;
    try {
      if (r && r.phase !== 'removed') this.check(r);
    } catch {
      conflict = true;
    }
    const policy = this.policy(r);
    return {
      server_name: 'agentmind',
      scope: this.scope,
      project_id: projectScope(this.root).id,
      phase: r?.phase ?? 'not-enrolled',
      installed:
        !!r &&
        r.phase === 'installed' &&
        !conflict &&
        JSON.stringify(settingsDocument(this.text()).mcpServers.agentmind) ===
          JSON.stringify(r.entry) &&
        readBounded(this.root, this.enrollment) === r.enrollment &&
        this.routerRead(r.router) === r.router_content,
      conflict,
      policy,
      policy_blocked: policy.blockers.length > 0 || policy.collisions.length > 0,
      router: r
        ? { path: r.router.path, ownership: r.router.owned ? 'MANAGED' : 'REUSED_READ_ONLY' }
        : null,
      gemini_md: 'UNCHANGED',
      hooks_installed: false,
      mode: 'supervised-local',
      protected_deployment: 'NOT VERIFIED',
      autonomous_activation: 'NO-GO',
      native_discovery: 'NOT VERIFIED',
      native_activation: 'NOT VERIFIED',
    };
  }
}

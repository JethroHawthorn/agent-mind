import { spawnSync } from 'node:child_process';
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
import { digest, readBounded, replaceFile } from '../codex/files.js';
import { projectScope, rejectLinks } from '../codex/project.js';
import { capabilities, claudeExecutable, mcpDocument } from './configuration.js';

type Scope = 'project' | 'user';
type Receipt = {
  schema: 1;
  installation_id: string;
  root: string;
  database: string;
  scope: Scope;
  phase: 'installing' | 'installed' | 'removing' | 'removed';
  router: string;
  entry: { type: 'stdio'; command: string; args: string[] };
  enrollment: string;
  config_before: string | null;
};
export type ClaudeOptions = {
  root: string;
  database: string;
  adapter: string;
  router: string;
  scope?: Scope;
  claude?: string;
  home?: string;
};
/** Integration receipts establish operational ownership only, never operator authorization. */
export class ClaudeSetup {
  readonly root: string;
  readonly database: string;
  readonly adapter: string;
  readonly node = realpathSync(process.execPath);
  readonly claude: string;
  readonly scope: Scope;
  readonly home: string;
  readonly serverName: string;
  readonly enrollment: string;
  readonly statePath: string;
  readonly config: string;
  readonly routerPath: string;
  constructor(readonly options: ClaudeOptions) {
    this.root = projectScope(options.root).root;
    if (!isAbsolute(options.database) || !isAbsolute(options.adapter))
      throw new AgentMindError('CLAUDE_SETUP_INVALID', 'Use absolute database and adapter paths.');
    this.database = options.database;
    this.adapter = realpathSync(options.adapter);
    for (const p of [this.root, this.database, this.adapter, this.node])
      if (/[\r\n\t]|\$\{/.test(p))
        throw new AgentMindError(
          'CLAUDE_PATH_UNSUPPORTED',
          'Claude configuration paths cannot contain control characters or environment expansion syntax.',
        );
    if (!readFileSync(this.adapter, 'utf8').includes('loadClaudeEnrollment'))
      throw new AgentMindError('CLAUDE_BUILD_MISSING', 'Build the Claude adapter first.');
    this.claude = claudeExecutable(options.claude);
    this.scope = options.scope ?? 'project';
    if (!['project', 'user'].includes(this.scope))
      throw new AgentMindError('CLAUDE_SETUP_INVALID', 'Use scope project or user.');
    this.home = realpathSync(options.home ?? homedir());
    if (
      this.scope === 'user' &&
      !options.home &&
      process.env.CLAUDE_CONFIG_DIR &&
      process.env.CLAUDE_CONFIG_DIR !== join(this.home, '.claude')
    )
      throw new AgentMindError(
        'CLAUDE_USER_DIRECTORY_UNSUPPORTED',
        'Custom CLAUDE_CONFIG_DIR is supported through project setup; user router installation requires the standard directory. No auth configuration was changed.',
      );
    this.serverName = `agentmind_${digest(this.root).slice(0, 16)}`;
    this.enrollment = join(this.root, '.agentmind/claude/enrollment.json');
    this.statePath = join(this.root, '.agentmind/claude/installation.json');
    this.config = join(this.root, '.mcp.json');
    this.routerPath = join(
      this.scope === 'project' ? this.root : this.home,
      '.claude/skills/agentmind-router/SKILL.md',
    );
  }
  private user(args: string[]) {
    // The official CLI owns ~/.claude.json parsing/locking; AgentMind never opens it.
    const env = this.options.home
      ? { PATH: process.env.PATH, HOME: this.home, CLAUDE_CONFIG_DIR: join(this.home, '.claude') }
      : process.env;
    return spawnSync(this.claude, args, {
      cwd: this.root,
      env,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 65536,
    });
  }
  private userEntry(name = this.serverName) {
    const r = this.user(['mcp', 'get', name]);
    if (r.status === 1 && r.stderr.includes(`No MCP server named "${name}"`)) return null;
    if (r.status !== 0)
      throw new AgentMindError(
        'CLAUDE_USER_CONFIG_UNAVAILABLE',
        'Official Claude MCP inspection failed; no registration was changed.',
      );
    return r.stdout;
  }
  private expectedEntry() {
    return {
      type: 'stdio' as const,
      command: this.node,
      args: [this.adapter, '--enrollment', this.enrollment],
    };
  }
  private matchesUser(text: string, r: Receipt) {
    // Reject unknown/changed registrations rather than removing them. No user output is returned.
    return (
      text.includes('Scope: User config') &&
      text.includes(`\n  Command: ${r.entry.command}\n`) &&
      text.includes(`\n  Args: ${r.entry.args.join(' ')}\n`) &&
      !text.includes('\n  Environment:')
    );
  }
  state(): Receipt | null {
    const text = readBounded(this.root, this.statePath, 524288);
    if (text === null) return null;
    let r: Receipt;
    try {
      r = JSON.parse(text);
    } catch {
      throw new AgentMindError('CLAUDE_RECEIPT_INVALID', 'Malformed integration receipt.');
    }
    if (
      r.schema !== 1 ||
      r.root !== this.root ||
      r.scope !== this.scope ||
      r.database !== this.database ||
      !/^[a-f0-9-]{36}$/.test(r.installation_id) ||
      !['installing', 'installed', 'removing', 'removed'].includes(r.phase) ||
      (r.router !== this.options.router && r.phase !== 'removed') ||
      JSON.stringify(r.entry) !== JSON.stringify(this.expectedEntry()) ||
      !(r.config_before === null || typeof r.config_before === 'string')
    )
      throw new AgentMindError(
        'CLAUDE_RECEIPT_CONFLICT',
        'Receipt belongs to another scope/build or was modified; inspect backups, never force overwrite.',
      );
    const parsed = JSON.parse(r.enrollment);
    if (parsed.integration !== 'agentmind-claude-v1')
      throw new AgentMindError('CLAUDE_RECEIPT_INVALID', 'Invalid enrollment.');
    const e = enrollmentSchema.parse({ ...parsed, integration: 'agentmind-codex-v1' });
    if (
      e.project_root !== this.root ||
      e.project_id !== projectScope(this.root).id ||
      e.database !== this.database ||
      e.installation_id !== r.installation_id
    )
      throw new AgentMindError('CLAUDE_RECEIPT_INVALID', 'Enrollment mismatch.');
    return r;
  }
  private routerRead() {
    return readBounded(this.scope === 'project' ? this.root : this.home, this.routerPath);
  }
  private projectEntry() {
    return mcpDocument(readBounded(this.root, this.config)).mcpServers[this.serverName];
  }
  private entryMatches(value: unknown, r: Receipt) {
    return JSON.stringify(value) === JSON.stringify(r.entry);
  }
  plan(installationId?: string) {
    if (
      installationId !== undefined &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(installationId)
    )
      throw new AgentMindError(
        'CLAUDE_SETUP_INVALID',
        'Installation identity must be a UUID; no caller path fragments are accepted.',
      );
    capabilities(this.claude);
    const state = this.state();
    if (state && state.phase !== 'removed') {
      this.check(state, false);
      return { action: state.phase === 'installed' ? 'SKIP' : 'RECOVER', state };
    }
    const old = readBounded(this.root, this.config);
    const document = mcpDocument(old);
    if (
      Object.hasOwn(document.mcpServers, this.serverName) ||
      Object.keys(document.mcpServers).some((n) => /agentmind/i.test(n)) ||
      this.routerRead() !== null ||
      readBounded(this.root, this.enrollment) !== null
    )
      throw new AgentMindError(
        'CLAUDE_SETUP_CONFLICT',
        'Existing AgentMind registration/router/enrollment is user-owned or registered in another scope. Inspect it with Claude; no duplicate or adoption was created.',
      );
    const id = installationId ?? randomUUID();
    const stateNew: Receipt = {
      schema: 1,
      installation_id: id,
      root: this.root,
      database: this.database,
      scope: this.scope,
      phase: 'installing',
      router: this.options.router,
      entry: this.expectedEntry(),
      config_before: old,
      enrollment: JSON.stringify({
        schema_version: 1,
        integration: 'agentmind-claude-v1',
        installation_id: id,
        project_root: this.root,
        project_id: projectScope(this.root).id,
        database: this.database,
        mode: 'supervised-local',
      }),
    };
    return { action: 'INSTALL', state: stateNew };
  }
  private check(r: Receipt, probeUser = true) {
    const router = this.routerRead(),
      enrollment = readBounded(this.root, this.enrollment);
    if (
      (router !== null && router !== r.router) ||
      (enrollment !== null && enrollment !== r.enrollment)
    )
      throw new AgentMindError('CLAUDE_SETUP_CONFLICT', 'Managed content changed; preserving it.');
    const entry =
      this.scope === 'project' ? this.projectEntry() : probeUser ? this.userEntry() : null;
    if (
      entry !== undefined &&
      entry !== null &&
      !(this.scope === 'project' ? this.entryMatches(entry, r) : this.matchesUser(String(entry), r))
    )
      throw new AgentMindError('CLAUDE_SETUP_CONFLICT', 'MCP registration changed; preserving it.');
  }
  private lock<T>(f: () => T) {
    const parents = [rejectLinks(this.root, '.agentmind/claude')];
    if (this.scope === 'user')
      parents.push(rejectLinks(this.home, '.claude/agentmind-integration'));
    const held: { fd: number; path: string }[] = [];
    try {
      for (const parent of parents) {
        mkdirSync(parent, { recursive: true, mode: 0o700 });
        const st = lstatSync(parent);
        if ((st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid()))
          throw new AgentMindError(
            'CLAUDE_PRIVATE_STATE_UNSAFE',
            'Integration state must be current-user owned, mode 0700.',
          );
        const path = join(parent, 'setup.lock');
        let fd: number;
        try {
          fd = openSync(path, 'wx', 0o600);
        } catch {
          throw new AgentMindError(
            'CLAUDE_SETUP_BUSY',
            'Setup is locked; inspect interrupted operations before removing a stale lock.',
          );
        }
        held.push({ fd, path });
      }
      return f();
    } finally {
      for (const lock of held.reverse()) {
        closeSync(lock.fd);
        unlinkSync(lock.path);
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
    if (this.scope === 'project') {
      const before = readBounded(this.root, this.config),
        d = mcpDocument(before);
      if (
        Object.hasOwn(d.mcpServers, this.serverName) &&
        !this.entryMatches(d.mcpServers[this.serverName], r)
      )
        throw new AgentMindError('CLAUDE_SETUP_CONFLICT', 'Registration changed during operation.');
      if (remove) delete d.mcpServers[this.serverName];
      else d.mcpServers[this.serverName] = r.entry;
      const original = mcpDocument(r.config_before);
      const same = JSON.stringify(d) === JSON.stringify(original);
      const after = same ? r.config_before : `${JSON.stringify(d, null, 2)}\n`;
      if (after !== null && Buffer.byteLength(after) > 131072)
        throw new AgentMindError('CLAUDE_CONFIG_TOO_LARGE', 'MCP config exceeds 128KiB.');
      replaceFile(this.root, this.config, before, after);
    } else {
      const current = this.userEntry();
      if (remove && current === null) return;
      if (remove && current !== null && !this.matchesUser(current, r))
        throw new AgentMindError('CLAUDE_SETUP_CONFLICT', 'Changed user entry.');
      if (!remove && current !== null) {
        if (!this.matchesUser(current, r))
          throw new AgentMindError('CLAUDE_SETUP_CONFLICT', 'Changed user entry.');
        return;
      }
      const result = this.user(
        remove
          ? ['mcp', 'remove', '--scope', 'user', this.serverName]
          : ['mcp', 'add-json', '--scope', 'user', this.serverName, JSON.stringify(r.entry)],
      );
      if (result.status !== 0)
        throw new AgentMindError(
          'CLAUDE_REGISTRATION_FAILED',
          'Official Claude registration failed; journal retained for recovery. No authentication was changed.',
        );
    }
  }
  setup(options: { beforeWrite?: () => void; installationId?: string } = {}) {
    return this.lock(() => {
      options.beforeWrite?.();
      const p = this.plan(options.installationId),
        r = p.state;
      if (r.phase === 'removing')
        throw new AgentMindError('CLAUDE_SETUP_RECOVERY', 'Finish uninstall before setup.');
      const beforeState = readBounded(this.root, this.statePath, 524288);
      if (p.action === 'INSTALL') {
        if (this.userEntry() !== null || this.userEntry('agentmind') !== null)
          throw new AgentMindError(
            'CLAUDE_SETUP_CONFLICT',
            'An existing AgentMind CLI registration is present; inspect it instead of creating a duplicate.',
          );
        const backup = join(this.root, `.agentmind/claude/backup-${r.installation_id}.json`);
        replaceFile(
          this.root,
          backup,
          null,
          JSON.stringify({ schema: 1, config_before: r.config_before }),
          524288,
        );
        const ignore = join(this.root, '.agentmind/claude/.gitignore');
        if (!existsSync(ignore)) replaceFile(this.root, ignore, null, '*\n');
        replaceFile(this.root, this.statePath, beforeState, JSON.stringify(r), 524288);
      }
      this.check(r);
      replaceFile(
        this.root,
        this.enrollment,
        readBounded(this.root, this.enrollment),
        r.enrollment,
      );
      replaceFile(
        this.scope === 'project' ? this.root : this.home,
        this.routerPath,
        this.routerRead(),
        r.router,
      );
      this.registration(r, false);
      r.phase = 'installed';
      this.save(r);
      return this.status();
    });
  }
  uninstall(apply = false, beforeWrite?: () => void) {
    const r = this.state();
    if (!r || r.phase === 'removed') return { action: 'SKIP', installed: false };
    this.check(r);
    if (!apply)
      return { action: 'REMOVE', dry_run: true, server_name: this.serverName, scope: this.scope };
    return this.lock(() => {
      beforeWrite?.();
      const fresh = this.state();
      if (!fresh) throw new AgentMindError('CLAUDE_SETUP_CONFLICT', 'Receipt disappeared.');
      this.check(fresh);
      fresh.phase = 'removing';
      this.save(fresh);
      this.registration(fresh, true);
      replaceFile(
        this.scope === 'project' ? this.root : this.home,
        this.routerPath,
        this.routerRead(),
        null,
      );
      replaceFile(this.root, this.enrollment, readBounded(this.root, this.enrollment), null);
      fresh.phase = 'removed';
      this.save(fresh);
      return {
        action: 'REMOVED',
        installed: false,
        database_retained: true,
        backups_retained: true,
      };
    });
  }
  /** Explicit apply/diagnostic only: official CLI inspection can start the registered MCP. */
  verifyUserRegistration() {
    if (this.scope !== 'user') return true;
    const r = this.state(),
      value = this.userEntry();
    return !!r && value !== null && this.matchesUser(value, r);
  }
  status() {
    const r = this.state();
    let conflict = false;
    try {
      if (r && r.phase !== 'removed') this.check(r, false);
    } catch {
      conflict = true;
    }
    // User get is an explicit official CLI health probe and may start the registered server.
    const entry = this.scope === 'project' ? this.projectEntry() : null;
    return {
      server_name: this.serverName,
      scope: this.scope,
      project_id: projectScope(this.root).id,
      mode: 'supervised-local',
      protected_deployment: 'NOT VERIFIED',
      autonomous_activation: 'NO-GO',
      phase: r?.phase ?? 'not-enrolled',
      installed:
        !!r &&
        r.phase === 'installed' &&
        !conflict &&
        this.routerRead() === r.router &&
        readBounded(this.root, this.enrollment) === r.enrollment &&
        (this.scope === 'user' || this.entryMatches(entry, r)),
      conflict,
      router_present: this.routerRead() !== null,
      claude_md: 'UNCHANGED',
      user_registration_verification:
        this.scope === 'user' ? 'NOT CHECKED; explicit apply uses official CLI' : 'PROJECT_FILE',
      user_config_access:
        this.scope === 'user' ? 'OFFICIAL_CLI_ONLY; get may start server' : 'NOT_EDITED',
      hooks_installed: false,
    };
  }
}

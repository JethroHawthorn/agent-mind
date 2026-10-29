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
import { isAbsolute, join } from 'node:path';
import { AgentMindError, enrollmentSchema } from '@agentmind/core';
import { mcpDocument } from '../claude/configuration.js';
import { DAILY_TOOLS } from '../codex/configuration.js';
import { readBounded, replaceFile } from '../codex/files.js';
import { projectScope, rejectLinks } from '../codex/project.js';

type Router = { root: string; path: string; owned: boolean };
type Options = {
  root: string;
  home: string;
  database: string;
  adapter: string;
  router: string;
  scope: 'project' | 'user';
  plannedSharedRouter?: boolean;
};
type Receipt = {
  schema: 1;
  id: string;
  root: string;
  database: string;
  scope: Options['scope'];
  phase: 'installing' | 'installed' | 'removing' | 'removed';
  entry: ReturnType<AntigravitySetup['entry']>;
  enrollment: string;
  router: Router;
  router_content: string;
  before: string | null;
  migration?: { legacy: Receipt; completed: boolean; router_retained?: boolean };
};
/** Dedicated Antigravity JSON/skill layout. No Gemini policy, migration or native commands. */
export class AntigravitySetup {
  readonly root: string;
  readonly home: string;
  readonly adapter: string;
  readonly node = realpathSync(process.execPath);
  readonly serverName = 'agentmind';
  readonly scope;
  readonly config: string;
  readonly enrollment: string;
  readonly statePath: string;
  readonly layers;
  readonly routerPath: string;
  constructor(readonly options: Options) {
    this.root = projectScope(options.root).root;
    this.home = realpathSync(options.home);
    this.scope = options.scope;
    if (
      !['project', 'user'].includes(this.scope) ||
      !isAbsolute(options.database) ||
      !isAbsolute(options.adapter)
    )
      this.fail('SETUP_INVALID');
    this.adapter = realpathSync(options.adapter);
    if (!readFileSync(this.adapter, 'utf8').includes('loadAntigravityEnrollment'))
      this.fail('BUILD_MISSING');
    for (const path of [this.root, this.home, this.adapter, this.node, options.database])
      if ([...path].some((c) => c.charCodeAt(0) < 32 || c === '$')) this.fail('PATH_UNSUPPORTED');
    this.enrollment = join(this.root, '.agentmind/antigravity/enrollment.json');
    this.statePath = join(this.root, '.agentmind/antigravity/installation.json');
    this.layers = [
      { root: this.root, path: join(this.root, '.agents/mcp_config.json') },
      { root: this.home, path: join(this.home, '.gemini/config/mcp_config.json') },
    ];
    this.config = join(
      this.settingsRoot(),
      this.scope === 'project' ? '.agents/mcp_config.json' : '.gemini/config/mcp_config.json',
    );
    this.routerPath = join(
      this.settingsRoot(),
      this.scope === 'project'
        ? '.agents/skills/agentmind-router/SKILL.md'
        : '.gemini/antigravity-cli/skills/agentmind-router/SKILL.md',
    );
  }
  private fail(code: string): never {
    throw new AgentMindError(
      `ANTIGRAVITY_${code}`,
      'Antigravity integration refused; inspect scope, owned receipts and configuration. Existing data is preserved.',
    );
  }
  private settingsRoot() {
    return this.scope === 'project' ? this.root : this.home;
  }
  entry() {
    return {
      command: this.node,
      args: [this.adapter, '--enrollment', this.enrollment],
      enabledTools: [...DAILY_TOOLS],
      timeoutSeconds: 30,
    };
  }
  private text() {
    return readBounded(this.settingsRoot(), this.config);
  }
  private routerRead() {
    return readBounded(this.settingsRoot(), this.routerPath);
  }
  private legacy(): Receipt | null {
    if (this.scope !== 'user') return null;
    const text = readBounded(this.root, this.statePath, 524288);
    if (!text) return null;
    const raw = JSON.parse(text) as Receipt;
    if (raw.scope !== 'project' || raw.phase === 'removed') return null;
    const old = new AntigravitySetup({ ...this.options, scope: 'project' });
    const r = old.state();
    if (r?.phase !== 'installed') this.fail('LEGACY_RECOVERY_REQUIRED');
    old.check(r);
    return r;
  }
  private collisions(owned = false, legacy: Receipt | null = this.legacy()) {
    for (const [root, path] of [
      [this.root, '.agents/plugins/agentmind'],
      [this.home, '.gemini/config/plugins/agentmind'],
      [this.home, '.gemini/antigravity-cli/plugins/agentmind'],
    ] as const) {
      const directory = rejectLinks(root, path);
      if (existsSync(directory)) this.fail('PLUGIN_CONFLICT');
    }
    for (const layer of this.layers) {
      const d = mcpDocument(readBounded(layer.root, layer.path));
      if (
        Object.keys(d.mcpServers).some(
          (name) =>
            /agentmind/i.test(name) &&
            !(owned && layer.path === this.config && name === this.serverName) &&
            !(
              legacy &&
              layer.path === join(this.root, '.agents/mcp_config.json') &&
              name === this.serverName &&
              JSON.stringify(d.mcpServers[name]) === JSON.stringify(legacy.entry)
            ),
        )
      )
        this.fail('CONFIG_CONFLICT');
    }
    // A second discoverable router must never silently override this enrollment's router.
    const otherRoot = this.scope === 'project' ? this.home : this.root;
    const otherPath = join(
      otherRoot,
      this.scope === 'project'
        ? '.gemini/antigravity-cli/skills/agentmind-router/SKILL.md'
        : '.agents/skills/agentmind-router/SKILL.md',
    );
    const other = readBounded(otherRoot, otherPath);
    if (other !== null && other !== this.options.router) this.fail('ROUTER_CONFLICT');
  }
  state(): Receipt | null {
    const text = readBounded(this.root, this.statePath, 524288);
    if (text === null) return null;
    let r: Receipt;
    try {
      r = JSON.parse(text);
    } catch {
      this.fail('RECEIPT_INVALID');
    }
    if (this.scope === 'user' && r.scope === 'project') {
      if (r.phase === 'removed')
        new AntigravitySetup({ ...this.options, scope: 'project' }).validateReceipt(r);
      else this.legacy();
      return null;
    }
    this.validateReceipt(r);
    return r;
  }
  private validateReceipt(r: Receipt) {
    if (
      r.schema !== 1 ||
      !/^[a-f0-9-]{36}$/.test(r.id) ||
      r.root !== this.root ||
      r.database !== this.options.database ||
      r.scope !== this.scope ||
      !['installing', 'installed', 'removing', 'removed'].includes(r.phase) ||
      !this.validReceiptEntry(r.entry) ||
      (r.phase !== 'removed' && r.router_content !== this.options.router) ||
      r.router?.root !== this.settingsRoot() ||
      r.router?.path !== this.routerPath ||
      typeof r.router?.owned !== 'boolean' ||
      !(r.before === null || typeof r.before === 'string')
    )
      this.fail('RECEIPT_CONFLICT');
    const raw = JSON.parse(r.enrollment);
    if (raw.integration !== 'agentmind-antigravity-v1') this.fail('RECEIPT_INVALID');
    const e = enrollmentSchema.parse({ ...raw, integration: 'agentmind-codex-v1' });
    if (
      e.project_root !== this.root ||
      e.project_id !== projectScope(this.root).id ||
      e.database !== this.options.database ||
      e.installation_id !== r.id
    )
      this.fail('RECEIPT_CONFLICT');
    if (r.migration) {
      if (
        this.scope !== 'user' ||
        typeof r.migration.completed !== 'boolean' ||
        r.migration.legacy?.scope !== 'project' ||
        r.migration.legacy.migration ||
        r.migration.legacy.phase !== 'installed'
      )
        this.fail('RECEIPT_CONFLICT');
      new AntigravitySetup({
        ...this.options,
        scope: 'project',
        router: r.migration.legacy.router_content,
      }).validateReceipt(r.migration.legacy);
    }
  }
  private validReceiptEntry(entry: Receipt['entry']) {
    // Old installed paths may be refreshed only through a matched receipt/config pair.
    // Old commands are never executed; the current compiled adapter is independently validated.
    if (
      !entry ||
      !Array.isArray(entry.args) ||
      typeof entry.command !== 'string' ||
      typeof entry.args[0] !== 'string' ||
      !isAbsolute(entry.command) ||
      !isAbsolute(entry.args[0]) ||
      [entry.command, entry.args[0]].some((path) =>
        [...path].some((c) => c.charCodeAt(0) < 32 || c === '$'),
      )
    )
      return false;
    return (
      JSON.stringify(entry) ===
      JSON.stringify({
        ...this.entry(),
        command: entry.command,
        args: [entry.args[0], '--enrollment', this.enrollment],
      })
    );
  }
  private check(r: Receipt) {
    this.collisions(true, r.migration && !r.migration.completed ? r.migration.legacy : null);
    const entry = mcpDocument(this.text()).mcpServers.agentmind;
    if (entry !== undefined && JSON.stringify(entry) !== JSON.stringify(r.entry))
      this.fail('CONFIG_CONFLICT');
    const e = readBounded(this.root, this.enrollment),
      router = this.routerRead();
    if (
      e !== null &&
      e !== r.enrollment &&
      e !== (r.migration && !r.migration.completed ? r.migration.legacy.enrollment : undefined)
    )
      this.fail('ENROLLMENT_CONFLICT');
    if (
      (router !== null && router !== r.router_content) ||
      (!r.router.owned && router === null && !this.options.plannedSharedRouter)
    )
      this.fail('ROUTER_CONFLICT');
  }
  plan(installationId: string = randomUUID()) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(installationId))
      this.fail('SETUP_INVALID');
    if (this.scope === 'project')
      throw new AgentMindError(
        'ANTIGRAVITY_SCOPE_UNSUPPORTED',
        'Antigravity project discovery is unsupported; explicitly use --cli antigravity --scope user. Enrollment remains project-bound.',
      );
    const r = this.state();
    if (r && r.phase !== 'removed') {
      this.check(r);
      return {
        action: r.phase === 'installed' ? (this.status().installed ? 'SKIP' : 'REPAIR') : 'RECOVER',
        receipt: r,
      };
    }
    const legacy = this.legacy();
    this.collisions(false, legacy);
    const enrolled = readBounded(this.root, this.enrollment);
    if (enrolled !== null && enrolled !== legacy?.enrollment) this.fail('ENROLLMENT_CONFLICT');
    const router = this.routerRead();
    // Identical existing skills are read-only reuse; ownership never follows byte equality.
    if (router !== null && router !== this.options.router) this.fail('ROUTER_CONFLICT');
    const receipt: Receipt = {
      schema: 1,
      id: installationId,
      root: this.root,
      database: this.options.database,
      scope: this.scope,
      phase: 'installing',
      entry: this.entry(),
      before: this.text(),
      ...(legacy ? { migration: { legacy, completed: false } } : {}),
      router: {
        root: this.settingsRoot(),
        path: this.routerPath,
        owned: router === null && !this.options.plannedSharedRouter,
      },
      router_content: this.options.router,
      enrollment: JSON.stringify({
        schema_version: 1,
        integration: 'agentmind-antigravity-v1',
        installation_id: installationId,
        project_root: this.root,
        project_id: projectScope(this.root).id,
        database: this.options.database,
        mode: 'supervised-local',
      }),
    };
    if (Buffer.byteLength(receipt.enrollment) > 4096) this.fail('SETUP_INVALID');
    return { action: legacy ? 'MIGRATE' : 'INSTALL', receipt };
  }
  private lock<T>(run: () => T) {
    const parents = [{ root: this.root, path: '.agentmind/antigravity' }];
    if (this.scope === 'user')
      parents.push({ root: this.home, path: '.gemini/antigravity-cli/agentmind-integration' });
    const held: { fd: number; path: string }[] = [];
    try {
      for (const parent of parents) {
        const dir = rejectLinks(parent.root, parent.path);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const st = lstatSync(dir);
        if (st.mode & 0o077 || (process.getuid && st.uid !== process.getuid()))
          this.fail('PERMISSION');
        const path = join(dir, 'setup.lock');
        let fd: number;
        try {
          fd = openSync(path, 'wx', 0o600);
        } catch {
          this.fail('SETUP_BUSY');
        }
        held.push({ fd, path });
      }
      return run();
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
      d = mcpDocument(before);
    if (
      d.mcpServers.agentmind !== undefined &&
      JSON.stringify(d.mcpServers.agentmind) !== JSON.stringify(r.entry)
    )
      this.fail('CONFIG_CONFLICT');
    if (remove) delete d.mcpServers.agentmind;
    else d.mcpServers.agentmind = r.entry;
    const after =
      JSON.stringify(d) === JSON.stringify(mcpDocument(r.before))
        ? r.before
        : `${JSON.stringify(d, null, 2)}\n`;
    if (after !== null && Buffer.byteLength(after) > 131072) this.fail('CONFIG_OVERSIZED');
    if (before !== after) replaceFile(this.settingsRoot(), this.config, before, after);
  }
  setup(options: { beforeWrite?: () => void; installationId?: string } = {}) {
    return this.lock(() => {
      options.beforeWrite?.();
      const p = this.plan(options.installationId),
        r = p.receipt;
      if (p.action === 'SKIP') return this.status();
      if (r.phase === 'removing') this.fail('RECOVERY_REQUIRED');
      if (p.action === 'INSTALL' || p.action === 'MIGRATE') {
        replaceFile(
          this.root,
          join(this.root, `.agentmind/antigravity/backup-${r.id}.json`),
          null,
          JSON.stringify({ config_before: r.before, legacy: r.migration?.legacy }),
          524288,
        );
        const ignore = join(this.root, '.agentmind/antigravity/.gitignore');
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
        replaceFile(r.router.root, r.router.path, this.routerRead(), r.router_content);
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
    if (!apply) return { action: 'REMOVE', dry_run: true };
    return this.lock(() => {
      beforeWrite?.();
      const fresh = this.state();
      if (!fresh) this.fail('RECEIPT_CONFLICT');
      this.check(fresh);
      fresh.phase = 'removing';
      this.save(fresh);
      this.registration(fresh, true);
      if (fresh.router.owned)
        replaceFile(fresh.router.root, fresh.router.path, this.routerRead(), null);
      if (fresh.migration && !fresh.migration.completed) {
        replaceFile(
          this.root,
          this.enrollment,
          readBounded(this.root, this.enrollment),
          fresh.migration.legacy.enrollment,
        );
        this.save(fresh.migration.legacy);
        return {
          action: 'REMOVED',
          installed: false,
          database_retained: true,
          backups_retained: true,
          legacy_restored: true,
        };
      }
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
  validateRouterUpdate(nextRouter: string) {
    if (this.scope !== 'user') return;
    const other = readBounded(
      this.root,
      join(this.root, '.agents/skills/agentmind-router/SKILL.md'),
    );
    if (other !== null && other !== nextRouter) this.fail('SHARED_ROUTER_UPDATE_REQUIRED');
  }
  legacyRemoval() {
    const r = this.state(),
      legacy = r?.migration && !r.migration.completed ? r.migration.legacy : this.legacy();
    if (!legacy) return null;
    const path = join(this.root, '.agents/mcp_config.json'),
      before = readBounded(this.root, path),
      d = mcpDocument(before);
    if (
      d.mcpServers.agentmind !== undefined &&
      JSON.stringify(d.mcpServers.agentmind) !== JSON.stringify(legacy.entry)
    )
      this.fail('CONFIG_CONFLICT');
    delete d.mcpServers.agentmind;
    const after =
      JSON.stringify(d) === JSON.stringify(mcpDocument(legacy.before))
        ? legacy.before
        : `${JSON.stringify(d, null, 2)}\n`;
    return { path, before, after };
  }
  verifyDiscovery(executable: string) {
    const r = this.state();
    if (!r || !this.status().installed) this.fail('DISCOVERY_FAILED');
    const result = spawnSync(executable, ['mcp', 'list'], {
      cwd: this.root,
      env: { PATH: process.env.PATH, HOME: this.home, LANG: 'C', NO_COLOR: '1' },
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 262144,
    });
    const line = result.stdout?.split('\n').find((line) => /^agentmind\s/.test(line));
    if (
      result.status !== 0 ||
      !line ||
      !line.includes(r.entry.command) ||
      r.entry.args.some((arg) => !line.includes(arg))
    )
      this.fail('DISCOVERY_FAILED');
  }
  private removeLegacyRouter(legacy: Receipt) {
    if (!legacy.router.owned) return true;
    for (const id of ['codex', 'claude', 'gemini']) {
      const text = readBounded(
        this.root,
        join(this.root, `.agentmind/${id}/installation.json`),
        1048576,
      );
      if (text && !['removed', 'uninstalled'].includes(JSON.parse(text).phase)) return true;
    }
    const current = readBounded(legacy.router.root, legacy.router.path);
    if (current !== null && current !== legacy.router_content) this.fail('ROUTER_CONFLICT');
    replaceFile(legacy.router.root, legacy.router.path, current, null);
    return false;
  }
  finishMigration() {
    return this.lock(() => {
      const r = this.state();
      if (!r?.migration || r.migration.completed) return;
      this.check(r);
      const removal = this.legacyRemoval();
      if (!removal) this.fail('RECEIPT_CONFLICT');
      replaceFile(this.root, removal.path, removal.before, removal.after);
      r.migration.router_retained = this.removeLegacyRouter(r.migration.legacy);
      r.migration.completed = true;
      this.save(r);
    });
  }
  status() {
    const r = this.state();
    let conflict = false;
    try {
      this.collisions(
        !!r && r.phase !== 'removed',
        r?.migration && !r.migration.completed ? r.migration.legacy : this.legacy(),
      );
      if (r && r.phase !== 'removed') this.check(r);
    } catch {
      conflict = true;
    }
    return {
      installed:
        !!r &&
        this.scope === 'user' &&
        r.phase === 'installed' &&
        JSON.stringify(r.entry) === JSON.stringify(this.entry()) &&
        !conflict &&
        JSON.stringify(mcpDocument(this.text()).mcpServers.agentmind) === JSON.stringify(r.entry) &&
        readBounded(this.root, this.enrollment) === r.enrollment &&
        this.routerRead() === r.router_content,
      conflict,
      config: this.config,
      scope: this.scope,
      registry: this.options.database,
      router: r ? { path: r.router.path, owned: r.router.owned } : null,
      migration_pending: !!r?.migration && !r.migration.completed,
      scope_supported: this.scope === 'user',
      native_model_execution: 'NOT_VERIFIED',
    };
  }
}

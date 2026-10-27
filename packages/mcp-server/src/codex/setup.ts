import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { AgentMindError, enrollmentSchema } from '@agentmind/core';
import {
  codexCapabilities,
  configBlock,
  configuredEntry,
  DAILY_TOOLS,
  executable,
  readBuild,
} from './configuration.js';
import { readBounded, replaceFile } from './files.js';
import { ENROLLMENT, projectScope, rejectLinks } from './project.js';

const STATE = '.agentmind/codex/installation.json',
  LOCK = '.agentmind/codex/setup.lock',
  CONFIG = '.codex/config.toml',
  ROUTER = '.agents/skills/agentmind-router/SKILL.md';
type Change = { path: string; before: string | null; after: string | null };
export type Installation = {
  schema_version: 1;
  installation_id: string;
  root: string;
  database: string;
  server_name: string;
  node: string;
  adapter: string;
  enrollment: string;
  router: string;
  phase: 'installing' | 'installed' | 'removing' | 'uninstalled';
  changes: Change[];
  removal?: Change[];
};
export type SetupOptions = {
  root: string;
  database: string;
  adapter: string;
  router: string;
  node?: string;
  codex?: string;
};
export class CodexSetup {
  readonly root: string;
  readonly database: string;
  readonly adapter: string;
  readonly router: string;
  readonly node: string;
  readonly codex: string;
  readonly serverName: string;
  constructor(options: SetupOptions) {
    this.root = projectScope(options.root).root;
    if (
      !isAbsolute(options.database) ||
      !isAbsolute(options.adapter) ||
      [this.root, options.database, options.adapter, options.node ?? process.execPath]
        .join('')
        .split('')
        .some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      throw new AgentMindError(
        'CODEX_SETUP_INVALID',
        'Use absolute ordinary paths without control characters.',
      );
    this.database = options.database;
    this.adapter = options.adapter;
    if (Buffer.byteLength(options.router) > 4096)
      throw new AgentMindError(
        'CODEX_SETUP_INVALID',
        'Router instructions exceed the package budget.',
      );
    this.router = options.router;
    this.node = executable(options.node ?? process.execPath);
    this.codex = executable(options.codex ?? 'codex');
    this.serverName = `agentmind_${projectScope(this.root).id.slice(0, 16)}`;
  }
  private file(path: string) {
    return rejectLinks(this.root, path);
  }
  state(): Installation | null {
    const text = readBounded(this.root, this.file(STATE), 1048576);
    if (text === null) return null;
    const st = statSync(this.file(STATE));
    if ((st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid()))
      throw new AgentMindError(
        'CODEX_STATE_UNSAFE',
        'Integration records must be private and owned by the current user.',
      );
    let r: Installation;
    try {
      r = JSON.parse(text);
    } catch {
      throw new AgentMindError('CODEX_STATE_INVALID', 'Malformed integration record.');
    }
    if (
      r.schema_version !== 1 ||
      !/^[a-f0-9-]{36}$/.test(r.installation_id) ||
      r.root !== this.root ||
      r.database !== this.database ||
      r.adapter !== this.adapter ||
      r.node !== this.node ||
      r.server_name !== this.serverName ||
      r.enrollment !== this.file(ENROLLMENT) ||
      (r.router !== this.router && r.phase !== 'uninstalled') ||
      !['installing', 'installed', 'removing', 'uninstalled'].includes(r.phase) ||
      !Array.isArray(r.changes) ||
      r.changes.length !== 3
    )
      throw new AgentMindError(
        'CODEX_STATE_INVALID',
        'Integration record differs from requested enrollment; inspect relocation or configuration changes.',
      );
    if (r.changes.map((c) => c.path).join('|') !== [CONFIG, ROUTER, ENROLLMENT].join('|'))
      throw new AgentMindError('CODEX_STATE_INVALID', 'Unexpected integration paths.');
    for (const c of [...r.changes, ...(r.removal ?? [])])
      if (
        ![CONFIG, ROUTER, ENROLLMENT].includes(c.path) ||
        ![c.before, c.after].every(
          (x) => x === null || (typeof x === 'string' && Buffer.byteLength(x) <= 131072),
        )
      )
        throw new AgentMindError('CODEX_STATE_INVALID', 'Invalid recovery data.');
    const config = r.changes[0],
      router = r.changes[1],
      enrollment = r.changes[2];
    if (
      !config ||
      !router ||
      !enrollment ||
      config.after !== (config.before ?? '') + configBlock(r) ||
      router.before !== null ||
      router.after !== r.router ||
      enrollment.before !== null
    )
      throw new AgentMindError(
        'CODEX_STATE_INVALID',
        'Ownership requires the exact generated package and configuration block.',
      );
    const e = enrollmentSchema.safeParse(JSON.parse(enrollment.after ?? 'null'));
    if (
      !e.success ||
      e.data.installation_id !== r.installation_id ||
      e.data.project_root !== this.root ||
      e.data.project_id !== projectScope(this.root).id ||
      e.data.database !== this.database
    )
      throw new AgentMindError('CODEX_STATE_INVALID', 'Invalid enrollment provenance.');
    if (r.removal) {
      if (
        !Array.isArray(r.removal) ||
        r.removal.length !== 3 ||
        r.removal.map((c) => c.path).join('|') !== [CONFIG, ROUTER, ENROLLMENT].join('|')
      )
        throw new AgentMindError('CODEX_STATE_INVALID', 'Invalid removal recovery paths.');
      const [c, a, b] = r.removal,
        block = configBlock(r);
      if (
        !c ||
        !a ||
        !b ||
        c.before === null ||
        c.before.split(block).length !== 2 ||
        (c.after ?? '') !== c.before.replace(block, '') ||
        a.before !== router.after ||
        a.after !== null ||
        b.before !== enrollment.after ||
        b.after !== null
      )
        throw new AgentMindError(
          'CODEX_STATE_INVALID',
          'Removal must strip only the exact managed block/files.',
        );
    }
    return r;
  }
  plan(installationId?: string) {
    if (
      installationId !== undefined &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(installationId)
    )
      throw new AgentMindError(
        'CODEX_SETUP_INVALID',
        'Installation identity must be a UUID; no caller path fragments are accepted.',
      );
    const ignored = readBounded(this.root, this.file('.agentmind/codex/.gitignore'));
    if (ignored !== null && ignored !== '*\n')
      throw new AgentMindError(
        'CODEX_FILE_CONFLICT',
        'Private-state ignore file is user-owned or modified; inspect before setup.',
      );
    codexCapabilities(this.codex);
    readBuild(this.adapter);
    const prior = this.state();
    if (prior && prior.phase !== 'uninstalled') {
      if (prior.phase === 'removing')
        throw new AgentMindError(
          'CODEX_RECOVERY_REQUIRED',
          'Complete the interrupted uninstall first.',
        );
      if (prior.phase === 'installed') {
        const current = readBounded(this.root, this.file(CONFIG)),
          block = configBlock(prior);
        if (current !== null && current.split(block).length === 2) {
          const prefix = current.replace(block, '');
          prior.changes[0] = {
            path: CONFIG,
            before: prefix === '' && prior.changes[0]?.before === null ? null : prefix,
            after: current,
          };
          this.checkChanges(prior.changes);
          const complete = prior.changes.every(
            (c) => readBounded(this.root, this.file(c.path)) === c.after,
          );
          return { action: complete ? 'SKIP' : 'REPAIR', record: prior };
        }
      }
      this.checkChanges(prior.changes);
      return { action: 'RECOVER', record: prior };
    }
    const before = readBounded(this.root, this.file(CONFIG));
    if (configuredEntry(this.codex, before ?? '', this.serverName))
      throw new AgentMindError(
        'CODEX_CONFIG_COLLISION',
        'An entry with this project integration name already exists.',
      );
    if (
      readBounded(this.root, this.file(ROUTER)) !== null ||
      readBounded(this.root, this.file(ENROLLMENT)) !== null
    )
      throw new AgentMindError(
        'CODEX_FILE_CONFLICT',
        'Existing router/enrollment is not owned by this setup.',
      );
    const id = installationId ?? randomUUID();
    const r: Installation = {
      schema_version: 1,
      installation_id: id,
      root: this.root,
      database: this.database,
      server_name: this.serverName,
      node: this.node,
      adapter: this.adapter,
      enrollment: this.file(ENROLLMENT),
      router: this.router,
      phase: 'installing',
      changes: [],
    };
    const enrollment = enrollmentSchema.parse({
      schema_version: 1,
      integration: 'agentmind-codex-v1',
      installation_id: id,
      project_root: this.root,
      project_id: projectScope(this.root).id,
      database: this.database,
      mode: 'supervised-local',
    });
    r.changes = [
      { path: CONFIG, before, after: (before ?? '') + configBlock(r) },
      { path: ROUTER, before: null, after: this.router },
      { path: ENROLLMENT, before: null, after: `${JSON.stringify(enrollment, null, 2)}\n` },
    ];
    if (Buffer.byteLength(r.changes[0]?.after ?? '') > 131072)
      throw new AgentMindError(
        'CODEX_CONFIG_LIMIT',
        'Planned project configuration exceeds 128 KiB; no integration files changed.',
      );
    const parsed = configuredEntry(this.codex, r.changes[0]?.after ?? '', this.serverName);
    if (
      !parsed ||
      JSON.stringify(parsed.enabled_tools) !== JSON.stringify(DAILY_TOOLS) ||
      parsed.transport?.command !== this.node ||
      JSON.stringify(parsed.transport?.args) !==
        JSON.stringify([this.adapter, '--enrollment', r.enrollment])
    )
      throw new AgentMindError(
        'CODEX_CONFIG_INVALID',
        'Installed Codex did not accept the exact planned stdio command.',
      );
    return { action: 'INSTALL', record: r };
  }
  private checkChanges(changes: Change[]) {
    for (const c of changes) {
      const now = readBounded(this.root, this.file(c.path));
      if (now !== c.before && now !== c.after)
        throw new AgentMindError(
          'CODEX_FILE_CONFLICT',
          'Local modifications conflict with managed content; no force-overwrite exists.',
        );
    }
  }
  private save(r: Installation) {
    const path = this.file(STATE);
    replaceFile(
      this.root,
      path,
      readBounded(this.root, path, 1048576),
      `${JSON.stringify(r, null, 2)}\n`,
      1048576,
    );
  }
  private locked<T>(fn: () => T) {
    const path = this.file(LOCK);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const dir = statSync(dirname(path));
    if ((dir.mode & 0o077) !== 0 || (process.getuid && dir.uid !== process.getuid()))
      throw new AgentMindError(
        'CODEX_STATE_UNSAFE',
        'Integration state directory must be private and owned by the current user.',
      );
    let acquired = false;
    try {
      writeFileSync(path, JSON.stringify({ schema: 1, pid: process.pid }), {
        flag: 'wx',
        mode: 0o600,
      });
      acquired = true;
      const ignore = this.file('.agentmind/codex/.gitignore');
      const ignored = readBounded(this.root, ignore);
      if (ignored !== null && ignored !== '*\n')
        throw new AgentMindError(
          'CODEX_FILE_CONFLICT',
          'Private-state ignore file is user-owned or modified; inspect before setup.',
        );
      if (ignored === null) replaceFile(this.root, ignore, null, '*\n');
      return fn();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST')
        throw new AgentMindError(
          'CODEX_SETUP_BUSY',
          'Another setup owns the lock. After interruption, verify no setup is running before removing only setup.lock.',
        );
      throw e;
    } finally {
      if (acquired) unlinkSync(path);
    }
  }
  setup(options: { beforeWrite?: () => void; installationId?: string } = {}) {
    return this.locked(() => {
      options.beforeWrite?.();
      const p = this.plan(options.installationId);
      if (p.action === 'SKIP') return { action: 'SKIP' };
      const backup = this.file(`.agentmind/codex/backups/${p.record.installation_id}.json`);
      if (!existsSync(backup)) {
        mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
        writeFileSync(backup, JSON.stringify(p.record, null, 2), { flag: 'wx', mode: 0o600 });
      }
      p.record.phase = 'installing';
      this.save(p.record);
      for (const c of p.record.changes) {
        const now = readBounded(this.root, this.file(c.path));
        if (now === c.after) continue;
        replaceFile(this.root, this.file(c.path), c.before, c.after);
      }
      p.record.phase = 'installed';
      this.save(p.record);
      return { action: p.action, project_id: projectScope(this.root).id };
    });
  }
  uninstall(apply = false, beforeWrite?: () => void) {
    const run = () => {
      if (apply) beforeWrite?.();
      const r = this.state();
      if (!r || r.phase === 'uninstalled') return { action: 'SKIP' };
      let changes: Change[];
      if (r.phase === 'removing' && r.removal) {
        changes = r.removal;
        this.checkChanges(changes);
      } else {
        if (r.phase === 'installing')
          throw new AgentMindError(
            'CODEX_RECOVERY_REQUIRED',
            'Complete interrupted setup before uninstall.',
          );
        const current = readBounded(this.root, this.file(CONFIG)),
          block = configBlock(r);
        if (current === null || current.split(block).length !== 2)
          throw new AgentMindError(
            'CODEX_CONFIG_COLLISION',
            'Managed block missing or modified; cannot prove ownership.',
          );
        const after = current.replace(block, '');
        if (configuredEntry(this.codex, after, this.serverName))
          throw new AgentMindError(
            'CODEX_CONFIG_COLLISION',
            'Another entry uses the integration name.',
          );
        changes = [
          {
            path: CONFIG,
            before: current,
            after: after === '' && r.changes[0]?.before === null ? null : after,
          },
          ...r.changes.slice(1).map((c) => ({ path: c.path, before: c.after, after: null })),
        ];
        for (const c of changes)
          if (readBounded(this.root, this.file(c.path)) !== c.before)
            throw new AgentMindError(
              'CODEX_FILE_CONFLICT',
              'Managed files were modified; preserve them and inspect before removal.',
            );
      }
      if (!apply) return { action: 'REMOVE', paths: changes.map((c) => c.path) };
      r.phase = 'removing';
      r.removal = changes;
      this.save(r);
      for (const c of changes) {
        if (readBounded(this.root, this.file(c.path)) === c.after) continue;
        replaceFile(this.root, this.file(c.path), c.before, c.after);
      }
      r.phase = 'uninstalled';
      this.save(r);
      // Remove only empty managed router folders. Never recursively delete user files.
      const folder = dirname(this.file(ROUTER));
      if (existsSync(folder) && readdirSync(folder).length === 0) rmdirSync(folder);
      return { action: 'REMOVED', database_retained: true, backups_retained: true };
    };
    return apply ? this.locked(run) : run();
  }
  status() {
    const r = this.state();
    const config = readBounded(this.root, this.file(CONFIG));
    const configuration_present =
      r !== null && config !== null && config.split(configBlock(r)).length === 2;
    const enrollment_present =
      r !== null && readBounded(this.root, this.file(ENROLLMENT)) === r.changes[2]?.after;
    const router_present = readBounded(this.root, this.file(ROUTER)) === this.router;
    return {
      installed:
        r?.phase === 'installed' && configuration_present && enrollment_present && router_present,
      configuration_present,
      enrollment_present,
      phase: r?.phase ?? 'NOT_ENROLLED',
      project_root: this.root,
      project_id: projectScope(this.root).id,
      server_name: this.serverName,
      router_present,
      mode: 'supervised-local',
      protected_deployment: 'NOT VERIFIED',
      autonomous_activation: 'NO-GO',
    };
  }
}

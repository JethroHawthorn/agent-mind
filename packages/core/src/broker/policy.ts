import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { AgentMindError } from '../errors.js';

const uid = z.number().int().min(1).max(2147483647);
const absolute = z
  .string()
  .max(4096)
  .refine((p) => isAbsolute(p) && !/[\r\n\0]/.test(p));
export const brokerConfigSchema = z.strictObject({
  schema_version: z.literal(1),
  broker_uid: uid,
  operator_gid: uid.optional(),
  runtime_root: absolute,
  registry_directory: absolute,
  socket_directory: absolute,
  projects: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
        root: absolute,
        project_key: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{15,127}$/)
          .optional(),
        scope_id: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        distribution_home: absolute,
        distribution: z.enum(['disabled', 'protected']).default('disabled'),
        publication: z.strictObject({ root: absolute, gid: uid }).optional(),
      }),
    )
    .min(1)
    .max(64),
  agents: z
    .array(
      z.strictObject({ uid, project: z.string(), source: z.enum(['codex', 'claude', 'unknown']) }),
    )
    .min(1)
    .max(64),
  operators: z
    .array(z.strictObject({ uid, projects: z.array(z.string()).min(1).max(64) }))
    .min(1)
    .max(16),
});
export type BrokerConfig = z.infer<typeof brokerConfigSchema>;
export type Peer = Readonly<{ uid: number; gid: number }>;
export function required<T>(value: T | undefined): T {
  if (value === undefined) denied();
  return value;
}
export function denied(message = 'Protected broker policy denied the operation.'): never {
  throw new AgentMindError('BROKER_DENIED', message);
}
/** Configuration logic tests do not attest deployed OS separation. */
export function validateBrokerConfig(input: unknown): BrokerConfig {
  const p = brokerConfigSchema.safeParse(input);
  if (!p.success) denied('Invalid protected broker configuration.');
  const c = p.data;
  const ids = [0, c.broker_uid, ...c.agents.map((a) => a.uid), ...c.operators.map((o) => o.uid)];
  if (new Set(ids).size !== ids.length)
    denied('Administrator, broker, operators and per-project agents require distinct UIDs.');
  const names = new Set(c.projects.map((p) => p.name));
  if (
    names.size !== c.projects.length ||
    c.agents.some((a) => !names.has(a.project)) ||
    c.operators.some((o) => o.projects.some((p) => !names.has(p)))
  )
    denied('Invalid protected project mapping.');
  if (c.projects.some((p) => (p.project_key === undefined) === (p.scope_id === undefined)))
    denied('Choose exactly one protected project key or existing scope ID.');
  if (
    new Set(c.projects.map((p) => p.project_key ?? p.scope_id)).size !== c.projects.length ||
    new Set(c.projects.map((p) => p.root)).size !== c.projects.length
  )
    denied('Project roots must be unique.');
  const enabled = c.projects.filter((p) => p.distribution === 'protected');
  if (
    enabled.some((p) => !p.publication) ||
    new Set(enabled.map((p) => p.publication?.root)).size !== enabled.length ||
    new Set(enabled.map((p) => p.publication?.gid)).size !== enabled.length
  )
    denied('Each protected publication requires a distinct root and project group.');
  if (enabled.some((p) => p.publication?.gid === c.operator_gid))
    denied('Operator and publication groups must differ.');
  return c;
}
export function principal(
  c: BrokerConfig,
  channel: 'agent' | 'operator',
  peer: Peer,
  project?: string,
) {
  if (!Number.isSafeInteger(peer.uid) || !Number.isSafeInteger(peer.gid) || peer.gid < 0) denied();
  if (channel === 'agent') {
    if (project !== undefined) denied('Agents cannot select project scope.');
    const agent = c.agents.find((a) => a.uid === peer.uid);
    if (!agent) denied();
    return {
      project: required(c.projects.find((p) => p.name === agent.project)),
      source: agent.source,
    };
  }
  const operator = c.operators.find((o) => o.uid === peer.uid);
  if (!project || !operator?.projects.includes(project)) denied();
  return {
    project: required(c.projects.find((p) => p.name === project)),
    source: 'unknown' as const,
  };
}
function ancestors(path: string) {
  const paths = [path];
  while (path !== dirname(path)) {
    path = dirname(path);
    paths.push(path);
  }
  return paths;
}
function secure(path: string, owners: number[], directory?: boolean) {
  if (realpathSync(path) !== path)
    denied('Protected paths must be canonical and cannot contain symlinks.');
  const s = lstatSync(path);
  if (
    !owners.includes(s.uid) ||
    (s.mode & 0o6022) !== 0 ||
    s.isSymbolicLink() ||
    (directory !== undefined && (directory ? !s.isDirectory() : !s.isFile()))
  )
    denied('Unsafe protected ownership or permissions.');
  return s;
}
/** Reject extended ACLs rather than pretend POSIX mode bits alone prove access restrictions. */
export function verifyPaths(helper: string, paths: string[]) {
  execFileSync(helper, ['check'], {
    input: `${paths.join('\n')}\n`,
    timeout: 15000,
    maxBuffer: 1024,
    env: {},
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
export function checkRegistry(c: BrokerConfig, helper: string) {
  const dir = secure(c.registry_directory, [c.broker_uid], true);
  if ((dir.mode & 0o077) !== 0) denied('Registry directory must be broker-owned mode 0700.');
  const paths = ancestors(c.registry_directory);
  for (const p of paths.slice(1)) secure(p, [0, c.broker_uid], true);
  for (const name of readdirSync(c.registry_directory)) {
    const p = join(c.registry_directory, name);
    const s = secure(p, [c.broker_uid], false);
    if ((s.mode & 0o077) !== 0 || s.nlink !== 1)
      denied('Registry files, sidecars and backups must be private regular files.');
    paths.push(p);
  }
  verifyPaths(helper, paths);
}
/** Reject unresolved dyld search paths and dependencies outside the protected release/system. */
export function verifyDarwinDependencies(binaries: string[], runtimeRoot: string) {
  const seen = new Set<string>();
  const inspect = (binary: string) => {
    if (seen.has(binary)) return;
    seen.add(binary);
    const lines = execFileSync('/usr/bin/otool', ['-L', binary], {
      env: {},
      timeout: 5000,
      maxBuffer: 65536,
    })
      .toString()
      .split('\n')
      .slice(1);
    for (const line of lines) {
      const reference = line.trim().split(' (compatibility version')[0];
      if (!reference) continue;
      if (
        isAbsolute(reference) &&
        (resolve(reference).startsWith('/usr/lib/') ||
          resolve(reference).startsWith('/System/Library/'))
      )
        continue;
      const path = reference.startsWith('@loader_path/')
        ? resolve(dirname(binary), reference.slice(13))
        : reference.startsWith('@executable_path/')
          ? resolve(dirname(process.execPath), reference.slice(17))
          : reference;
      if (!isAbsolute(path) || !realpathSync(path).startsWith(`${runtimeRoot}/`))
        denied('Untrusted or unresolved native library dependency.');
      inspect(realpathSync(path));
    }
  };
  for (const binary of binaries) inspect(binary);
}
export function loadProtectedConfig(
  path: string,
  purpose: 'start' | 'preflight' = 'start',
): BrokerConfig {
  if (process.platform !== 'darwin') denied('Unsupported peer credential platform.');
  if (Object.keys(process.env).some((k) => /^(NODE_OPTIONS|NODE_PATH|LD_|DYLD_)/.test(k)))
    denied('Injected runtime environment is forbidden.');
  for (const p of ancestors(path)) secure(p, [0], p !== path);
  if (lstatSync(path).size > 32768) denied('Protected configuration is too large.');
  const c = validateBrokerConfig(JSON.parse(readFileSync(path, 'utf8')));
  if (Buffer.byteLength(`${c.socket_directory}/operator/operator.sock`) > 103)
    denied('Darwin socket path exceeds supported length.');
  if (
    purpose === 'start' &&
    (process.getuid?.() !== c.broker_uid || process.geteuid?.() !== c.broker_uid)
  )
    denied('Run only as the dedicated non-root broker identity.');
  // Necessary deployment check, not a proof of absent delegated sudo/SSH/container authority.
  for (const uid of [c.broker_uid, ...c.agents.map((a) => a.uid)]) {
    const groups = execFileSync('/usr/bin/id', ['-Gn', String(uid)], {
      env: {},
      timeout: 2000,
      maxBuffer: 8192,
    })
      .toString()
      .trim()
      .split(/\s+/);
    if (
      groups.some((g) =>
        ['admin', 'sudo', 'wheel', 'docker', 'lxd', 'incus-admin', 'disk', 'kmem'].includes(g),
      )
    )
      denied('Broker and agents must not belong to administrative groups.');
  }
  if (c.operator_gid === undefined) denied('A private operator group is required.');
  const groupsFor = (id: number) =>
    execFileSync('/usr/bin/id', ['-G', String(id)], { env: {}, timeout: 2000, maxBuffer: 8192 })
      .toString()
      .trim()
      .split(/\s+/)
      .map(Number);
  const brokerGroups = groupsFor(c.broker_uid);
  if (!brokerGroups.includes(c.operator_gid))
    denied('Broker must belong to the private operator group.');
  for (const o of c.operators)
    if (!groupsFor(o.uid).includes(c.operator_gid)) denied('Operator group membership missing.');
  for (const a of c.agents) {
    const groups = groupsFor(a.uid);
    if (groups.includes(c.operator_gid)) denied('Agent belongs to operator group.');
    for (const p of c.projects)
      if (p.publication) {
        if (groups.includes(p.publication.gid) !== (a.project === p.name))
          denied('Publication group mapping is not isolated.');
        if (!brokerGroups.includes(p.publication.gid))
          denied('Broker publication group membership missing.');
      }
  }
  if (
    purpose === 'start' &&
    [...(process.getgroups?.() ?? []), process.getgid?.(), process.getegid?.()].some(
      (g) => g === undefined || !brokerGroups.includes(g),
    )
  )
    denied('Broker inherited an unexpected group authority.');
  if (
    purpose === 'start' &&
    [c.operator_gid, ...c.projects.flatMap((p) => (p.publication ? [p.publication.gid] : []))].some(
      (g) => !process.getgroups?.().includes(g),
    )
  )
    denied('Broker process is missing required supplementary groups.');
  const helper = join(c.runtime_root, 'native/bin/agentmind-peer');
  const paths = [...ancestors(path), ...ancestors(c.runtime_root)];
  for (const p of ancestors(c.runtime_root)) secure(p, [0], true);
  const binaries = [process.execPath, helper];
  const visit = (p: string) => {
    if (paths.length > 50000) denied('Protected runtime inventory exceeds limit.');
    const s = lstatSync(p);
    if (s.isSymbolicLink()) {
      const target = realpathSync(p);
      if (
        relative(c.runtime_root, target).startsWith('..') ||
        isAbsolute(relative(c.runtime_root, target))
      )
        denied('Runtime dependency escapes protected installation.');
      return; // target is inventoried inside the protected tree
    }
    secure(p, [0]);
    if (s.isFile() && (p.endsWith('.node') || p.endsWith('.dylib'))) binaries.push(p);
    paths.push(p);
    if (s.isDirectory()) for (const name of readdirSync(p)) visit(join(p, name));
  };
  visit(c.runtime_root);
  if (
    !process.execPath.startsWith(`${c.runtime_root}/`) ||
    !realpathSync(import.meta.filename).startsWith(`${c.runtime_root}/`)
  )
    denied('Node, broker code and dependencies must be in the protected runtime.');
  verifyDarwinDependencies(binaries, c.runtime_root);
  verifyPaths(helper, [...new Set(paths)]);
  checkRegistry(c, helper);
  for (const p of ancestors(c.socket_directory)) secure(p, [0, c.broker_uid], true);
  const sockets = lstatSync(c.socket_directory);
  if (sockets.uid !== c.broker_uid || sockets.mode & 0o022) denied('Unsafe socket directory.');
  verifyPaths(helper, ancestors(c.socket_directory));
  return c;
}

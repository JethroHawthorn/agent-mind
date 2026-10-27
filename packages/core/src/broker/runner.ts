import { execFileSync } from 'node:child_process';
import { fstatSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { denied, verifyPaths } from './policy.js';

const absolute = z
  .string()
  .max(4096)
  .refine((p) => isAbsolute(p) && !/[\r\n\0]/.test(p));
const executable = z.union([absolute, z.strictObject({ node_entry: absolute })]);
export const runnerPolicySchema = z.strictObject({
  schema_version: z.literal(1),
  runner_uid: z.number().int().positive(),
  broker_uid: z.number().int().positive(),
  operator_uids: z.array(z.number().int().positive()).min(1).max(16),
  allowed_gids: z.array(z.number().int().positive()).min(1).max(32),
  home: absolute,
  workspace: absolute,
  helper: absolute,
  client_config: absolute,
  executables: z.strictObject({
    codex: executable.optional(),
    claude: executable.optional(),
    gemini: executable.optional(),
  }),
});
export type RunnerPolicy = z.infer<typeof runnerPolicySchema>;
export function validateRunnerPolicy(input: unknown): RunnerPolicy {
  const p = runnerPolicySchema.safeParse(input);
  if (!p.success) denied('Invalid runner policy.');
  const c = p.data;
  if (
    new Set([0, c.runner_uid, c.broker_uid, ...c.operator_uids]).size !==
      3 + c.operator_uids.length ||
    !Object.values(c.executables).some(Boolean)
  )
    denied('Runner, broker and operator authorities must differ.');
  return c;
}
export type RunnerObservation = {
  uid: number;
  euid: number;
  gid: number;
  egid: number;
  groups: number[];
  group_names: string[];
};
/** Pure identity policy; synthetic observations are not OS verification evidence. */
export function assertRunnerIdentity(c: RunnerPolicy, o: RunnerObservation) {
  if (
    o.uid !== c.runner_uid ||
    o.euid !== c.runner_uid ||
    [o.gid, o.egid, ...o.groups].some((g) => !c.allowed_gids.includes(g)) ||
    o.group_names.some((g) =>
      ['admin', 'wheel', 'sudo', 'docker', 'lxd', 'incus-admin', 'disk', 'kmem'].includes(g),
    )
  )
    denied(
      'Runner identity or group authority differs from protected policy; no identity switching or fallback.',
    );
}
/** Root-owned paths/ancestors only. No ownership or mode changes. */
export function rootOwnedPath(path: string) {
  if (realpathSync(path) !== path) denied('Protected policy paths must be canonical.');
  for (let p = path; ; p = dirname(p)) {
    const s = lstatSync(p);
    if (s.uid !== 0 || s.mode & 0o6022 || s.isSymbolicLink() || (p !== path && !s.isDirectory()))
      denied('Unsafe root-owned deployment path.');
    if (p === dirname(p)) break;
  }
}
/** Inert command description; no shell interpolation or arbitrary node flags. */
export function runnerCommand(
  c: RunnerPolicy,
  cli: keyof RunnerPolicy['executables'],
  node = process.execPath,
) {
  const entry = c.executables[cli];
  if (!entry) denied('CLI not enrolled in this runner policy.');
  return typeof entry === 'string'
    ? { command: entry, prefix_args: [] as string[] }
    : { command: node, prefix_args: [entry.node_entry] };
}
export function runnerEnvironment(c: RunnerPolicy, node = process.execPath) {
  return {
    HOME: c.home,
    PATH: `${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
  };
}
export function loadRunnerPolicy(path: string, cli: keyof RunnerPolicy['executables']) {
  if (process.platform !== 'darwin') denied('Protected runner supports macOS only.');
  rootOwnedPath(process.execPath);
  rootOwnedPath(import.meta.filename);
  rootOwnedPath(path);
  if (lstatSync(path).size > 32768) denied('Runner policy too large.');
  const c = validateRunnerPolicy(JSON.parse(readFileSync(path, 'utf8')));
  const { command, prefix_args } = runnerCommand(c, cli);
  for (const p of [c.helper, c.client_config, command, ...prefix_args]) {
    rootOwnedPath(p);
    if (!lstatSync(p).isFile()) denied('Protected executable/configuration must be regular files.');
  }
  const paths = [path, c.helper, c.client_config, command, ...prefix_args].flatMap((file) => {
    const a = [file];
    for (let p = dirname(file); ; p = dirname(p)) {
      a.push(p);
      if (p === dirname(p)) break;
    }
    return a;
  });
  verifyPaths(c.helper, [...new Set(paths)]);
  assertRunnerIdentity(c, {
    uid: process.getuid?.() ?? -1,
    euid: process.geteuid?.() ?? -1,
    gid: process.getgid?.() ?? -1,
    egid: process.getegid?.() ?? -1,
    groups: process.getgroups?.() ?? [],
    group_names: execFileSync('/usr/bin/id', ['-Gn'], { env: {}, timeout: 2000, maxBuffer: 8192 })
      .toString()
      .trim()
      .split(/\s+/),
  });
  for (const p of [c.home, c.workspace]) {
    const s = lstatSync(p);
    if (realpathSync(p) !== p || !s.isDirectory() || s.uid !== c.runner_uid || s.mode & 0o022)
      denied(
        'Runner home/workspace must belong to its identity and be canonical/non-shared-writable.',
      );
  }
  // Standard handles are the only inherited descriptors given to the coding CLI.
  // Refuse an operator-owned PTY/file/pipe rather than forwarding operator UI authority.
  for (const fd of [0, 1, 2])
    if (fstatSync(fd).uid !== c.runner_uid)
      denied('Runner must start in its own session, without operator-owned standard descriptors.');
  return { policy: c, command, prefix_args };
}

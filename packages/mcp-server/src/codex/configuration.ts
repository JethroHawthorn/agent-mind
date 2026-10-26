import { spawnSync } from 'node:child_process';
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { AgentMindError } from '@agentmind/core';
export const DAILY_TOOLS = [
  'agentmind_status',
  'memory_search',
  'memory_save',
  'experience_search',
  'experience_record',
  'skill_route',
  'skill_discover',
  'skill_load',
  'skill_resources',
  'skill_resource_get',
  'learning_signal_record',
  'learning_signal_get',
  'skill_authoring_context',
  'skill_authoring_submit',
  'skill_authoring_get',
  'skill_authoring_diff',
  'skill_authoring_evaluate',
  'review_queue',
  'review_get',
] as const;
export function executable(name = 'codex') {
  const candidates = isAbsolute(name)
    ? [name]
    : (process.env.PATH ?? '').split(delimiter).map((p) => join(p, name));
  for (const path of candidates)
    try {
      accessSync(path, constants.X_OK);
      return realpathSync(path);
    } catch {}
  throw new AgentMindError(
    'CODEX_UNAVAILABLE',
    'Codex executable not found; install the official CLI and retry.',
  );
}
export function codexCapabilities(path = executable()) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agentmind-codex-capabilities-')));
  try {
    const run = (args: string[]) =>
      spawnSync(path, args, {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 65536,
        cwd: home,
        env: { PATH: process.env.PATH ?? '', HOME: home, CODEX_HOME: home, LANG: 'C' },
      });
    const version = run(['--version']),
      get = run(['mcp', 'get', '--help']);
    if (version.status !== 0 || get.status !== 0 || !get.stdout.includes('--json'))
      throw new AgentMindError('CODEX_UNSUPPORTED', 'Codex must support mcp get --json.');
    const match = version.stdout.match(/codex-cli [0-9][0-9.]+/);
    return {
      executable: path,
      version: match?.[0] ?? 'UNKNOWN_VERSION',
      stdio: true,
      configuration_parser: true,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
export function configBlock(record: {
  installation_id: string;
  server_name: string;
  adapter: string;
  node: string;
  enrollment: string;
}) {
  // JSON strings are valid TOML basic strings for these validated POSIX paths. No shell involved.
  return `\n# agentmind-codex begin ${record.installation_id}\n[mcp_servers.${record.server_name}]\ncommand = ${JSON.stringify(record.node)}\nargs = ${JSON.stringify([record.adapter, '--enrollment', record.enrollment])}\nenabled_tools = ${JSON.stringify(DAILY_TOOLS)}\nstartup_timeout_sec = 20\ntool_timeout_sec = 30\n# agentmind-codex end ${record.installation_id}\n`;
}
/** Use the installed official parser, without loading credentials or changing its real home. */
export function configuredEntry(codex: string, text: string, name: string) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'agentmind-codex-parse-')));
  try {
    writeFileSync(join(home, 'config.toml'), text, { flag: 'wx', mode: 0o600 });
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      CODEX_HOME: home,
      LANG: 'C',
      TMPDIR: tmpdir(),
    };
    const list = spawnSync(codex, ['mcp', 'list', '--json'], {
      cwd: home,
      env,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 262144,
    });
    if (list.status !== 0)
      throw new AgentMindError(
        'CODEX_CONFIG_INVALID',
        'Codex rejected configuration or parsing was unavailable; no target change authorized.',
      );
    let entries: unknown;
    try {
      entries = JSON.parse(list.stdout);
    } catch {
      throw new AgentMindError('CODEX_CONFIG_INVALID', 'Unsupported Codex parser response.');
    }
    if (!Array.isArray(entries))
      throw new AgentMindError('CODEX_CONFIG_INVALID', 'Unsupported Codex parser response.');
    if (!entries.some((e) => e?.name === name)) return null;
    const get = spawnSync(codex, ['mcp', 'get', name, '--json'], {
      cwd: home,
      env,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 65536,
    });
    if (get.status !== 0)
      throw new AgentMindError('CODEX_CONFIG_INVALID', 'Cannot validate the AgentMind entry.');
    try {
      return JSON.parse(get.stdout);
    } catch {
      throw new AgentMindError('CODEX_CONFIG_INVALID', 'Unsupported entry response.');
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
export function readBuild(path: string) {
  const text = readFileSync(path, 'utf8');
  if (!text.includes('loadEnrollment') || !text.includes('startServer'))
    throw new AgentMindError(
      'CODEX_BUILD_MISSING',
      'Build the AgentMind Codex adapter before setup.',
    );
}

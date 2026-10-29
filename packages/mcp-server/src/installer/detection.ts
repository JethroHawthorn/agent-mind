import { spawnSync } from 'node:child_process';
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { Detection, Provider } from './model.js';
/** Only bounded public help/version commands, isolated homes, no auth/model probes. Cached by caller. */
export function detectCli(id: Provider, override?: string, deep = true): Detection {
  const base = {
    id,
    executable: null,
    version: null,
    stdio: false,
    capabilities_verified: false,
    authentication: 'NOT_VERIFIED' as const,
    native_discovery: 'NOT_VERIFIED' as const,
  };
  const name = override ?? (id === 'antigravity' ? 'agy' : id);
  if ([...name].some((c) => c.charCodeAt(0) < 32) || (name.includes('/') && !isAbsolute(name)))
    return { ...base, state: 'CONFIG_ERROR' };
  const paths = isAbsolute(name)
    ? [name]
    : (process.env.PATH ?? '')
        .split(delimiter)
        .filter(Boolean)
        .map((p) => join(p, name));
  let executable: string | undefined,
    unreadable = false;
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      if (!statSync(p).isFile()) {
        unreadable = true;
        continue;
      }
      accessSync(p, constants.X_OK);
      executable = realpathSync(p);
      break;
    } catch {
      unreadable = true;
    }
  }
  if (!executable) return { ...base, state: unreadable ? 'CONFIG_ERROR' : 'NOT_INSTALLED' };
  const home = mkdtempSync(join(tmpdir(), 'agentmind-public-help-'));
  try {
    const run = (args: string[]) => {
      const file = join(home, 'help'),
        fd = openSync(file, 'w', 0o600);
      try {
        const r = spawnSync(executable, args, {
          cwd: home,
          env: {
            PATH: process.env.PATH ?? '',
            HOME: home,
            CODEX_HOME: home,
            CLAUDE_CONFIG_DIR: join(home, '.claude'),
            GEMINI_CLI_HOME: home,
            LANG: 'C',
            NO_COLOR: '1',
          },
          stdio: ['ignore', fd, 'pipe'],
          timeout: 4000,
          maxBuffer: 65536,
        });
        return {
          ok: r.status === 0 && fstatSync(fd).size <= 262144,
          text: fstatSync(fd).size <= 262144 ? readFileSync(file, 'utf8') : '',
        };
      } finally {
        closeSync(fd);
      }
    };
    const v = run(['--version']),
      version = v.text.match(/\b\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?\b/i)?.[0] ?? null;
    if (!deep)
      return {
        ...base,
        executable,
        version,
        state: v.ok && version ? 'DETECTED' : 'UNSUPPORTED_VERSION',
        stdio: 'NOT_VERIFIED',
      };
    // Antigravity documents interactive /mcp, not Gemini's mcp/skills subcommands.
    // A public version probe establishes presence only; stdio is verified by runtimeDoctor.
    if (id === 'antigravity')
      return {
        ...base,
        executable,
        version,
        state: v.ok && version ? 'DETECTED' : 'UNSUPPORTED_VERSION',
        stdio: 'NOT_VERIFIED',
      };
    const h = run(
      id === 'codex'
        ? ['mcp', 'get', '--help']
        : id === 'claude'
          ? ['mcp', 'add-json', '--help']
          : ['mcp', '--help'],
    );
    const skills = id === 'gemini' ? run(['skills', '--help']) : null;
    const ok =
      v.ok &&
      !!version &&
      h.ok &&
      (id === 'codex'
        ? h.text.includes('--json')
        : id === 'claude'
          ? h.text.includes('--scope')
          : h.text.includes('add') && skills?.ok && skills.text.includes('list'));
    return {
      ...base,
      executable,
      version,
      state: ok ? 'DETECTED' : 'UNSUPPORTED_VERSION',
      stdio: !!ok,
      capabilities_verified: !!ok,
    };
  } catch {
    return { ...base, executable, state: 'UNSUPPORTED_VERSION' };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

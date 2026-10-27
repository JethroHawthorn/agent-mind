import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMindError } from '@agentmind/core';
import { executable } from '../codex/configuration.js';

export function claudeExecutable(path = 'claude') {
  try {
    return executable(path);
  } catch {
    throw new AgentMindError(
      'CLAUDE_UNAVAILABLE',
      'Install the official Claude Code CLI; no login changes were attempted.',
    );
  }
}
export function capabilities(path: string) {
  // The installed native CLI truncates long --help output to a pipe buffer.
  // A private file descriptor captures complete public help, without loading auth.
  const run = (args: string[]) => {
    const root = mkdtempSync(join(tmpdir(), 'agentmind-claude-help-'));
    const file = join(root, 'help.txt'),
      fd = openSync(file, 'wx', 0o600);
    try {
      const r = spawnSync(path, args, {
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 65536,
        stdio: ['ignore', fd, 'pipe'],
      });
      if (fstatSync(fd).size > 262144)
        throw new AgentMindError('CLAUDE_UNSUPPORTED', 'CLI help exceeds the public-output limit.');
      return { status: r.status, stdout: readFileSync(file, 'utf8') };
    } finally {
      closeSync(fd);
      rmSync(root, { recursive: true, force: true });
    }
  };
  const v = run(['--version']),
    help = run(['--help']),
    add = run(['mcp', 'add-json', '--help']);
  const version = v.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (
    v.status !== 0 ||
    !version ||
    help.status !== 0 ||
    add.status !== 0 ||
    !help.stdout.includes('--strict-mcp-config') ||
    !help.stdout.includes('--no-session-persistence') ||
    !add.stdout.includes('--scope')
  )
    throw new AgentMindError(
      'CLAUDE_UNSUPPORTED',
      'Claude must support stdio MCP, scoped add-json, strict MCP config and nonpersistent print sessions.',
    );
  return {
    version,
    stdio: true,
    scoped_add_json: true,
    strict_mcp_config: true,
    native_execution: 'NOT VERIFIED',
    hooks: 'OPTIONAL_EXISTING_SKILL_TELEMETRY; not installed by setup',
  };
}
/** Supported CLI output projection only. Never read authentication/settings files. */
export function inspectClaude(path: string) {
  const r = spawnSync(path, ['auth', 'status'], {
    encoding: 'utf8',
    timeout: 8000,
    maxBuffer: 65536,
  });
  let j: { loggedIn?: unknown; authMethod?: unknown } = {};
  try {
    j = JSON.parse(r.stdout);
  } catch {}
  const methods = ['none', 'claude.ai', 'oauth_token', 'api_key', 'api_key_helper', 'third_party'];
  return {
    authentication: {
      command_exit: r.status,
      configured: r.status === 0 && j.loggedIn === true,
      method:
        typeof j.authMethod === 'string' && methods.includes(j.authMethod)
          ? j.authMethod
          : 'UNKNOWN',
      model_execution: 'NOT VERIFIED',
    },
    existing_files: ['.claude/settings.json', '.claude/settings.local.json', '.claude.json'].map(
      (kind) => ({ kind, present: existsSync(join(homedir(), kind)) }),
    ),
    authentication_files_read: false,
  };
}
export function mcpDocument(text: string | null): {
  [key: string]: unknown;
  mcpServers: Record<string, unknown>;
} {
  try {
    const parsed = text === null ? {} : JSON.parse(text);
    // Reject duplicate JSON keys instead of silently discarding user configuration.
    const objects: Set<string>[] = [];
    const source = text ?? '{}';
    for (let i = 0; i < source.length; i++) {
      if (source[i] === '{') objects.push(new Set());
      else if (source[i] === '}') objects.pop();
      else if (source[i] === '"') {
        const start = i++;
        for (; i < source.length; i++) {
          if (source[i] === '\\') i++;
          else if (source[i] === '"') break;
        }
        if (
          source
            .slice(i + 1)
            .trimStart()
            .startsWith(':')
        ) {
          const key = JSON.parse(source.slice(start, i + 1)),
            keys = objects.at(-1);
          if (!keys || keys.has(key)) throw Error('Duplicate key');
          keys.add(key);
        }
      }
    }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw Error();
    if (
      parsed.mcpServers !== undefined &&
      (!parsed.mcpServers ||
        Array.isArray(parsed.mcpServers) ||
        typeof parsed.mcpServers !== 'object')
    )
      throw Error();
    return { ...parsed, mcpServers: parsed.mcpServers ?? {} };
  } catch {
    throw new AgentMindError(
      'CLAUDE_CONFIG_INVALID',
      'Malformed MCP configuration; no changes made.',
    );
  }
}

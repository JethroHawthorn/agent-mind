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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMindError } from '@agentmind/core';
// Reuse the bounded, duplicate-key-safe JSON parser. Unknown settings are retained, not inspected.
import { mcpDocument } from '../claude/configuration.js';
import { executable } from '../codex/configuration.js';
export function settingsDocument(text: string | null) {
  try {
    return mcpDocument(text);
  } catch {
    throw new AgentMindError(
      'GEMINI_SETTINGS_INVALID',
      'Malformed or ambiguous settings JSON; no values were rewritten.',
    );
  }
}
export const GEMINI_ALIAS = 'agentmind';
export function geminiCapabilities(name = 'gemini') {
  let path: string;
  try {
    path = executable(name);
  } catch {
    return {
      installed: false,
      executable: null,
      version: null,
      compatibility: 'NOT VERIFIED',
      authentication: 'NOT VERIFIED',
      reason: 'GEMINI_NOT_INSTALLED',
      headless: false,
    };
  }
  const root = mkdtempSync(join(tmpdir(), 'agentmind-gemini-capabilities-'));
  try {
    const run = (args: string[]) => {
      const file = join(root, 'public-help'),
        fd = openSync(file, 'w', 0o600);
      try {
        const r = spawnSync(path, args, {
          cwd: root,
          env: { PATH: process.env.PATH, HOME: root, GEMINI_CLI_HOME: root },
          stdio: ['ignore', fd, 'pipe'],
          timeout: 5000,
          maxBuffer: 65536,
        });
        if (fstatSync(fd).size > 262144)
          throw new AgentMindError('GEMINI_UNSUPPORTED', 'Public help exceeds output limit.');
        return { status: r.status, text: readFileSync(file, 'utf8') };
      } finally {
        closeSync(fd);
      }
    };
    const v = run(['--version']),
      h = run(['--help']),
      m = run(['mcp', '--help']),
      s = run(['skills', '--help']);
    const version = v.text.match(/\b\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?\b/i)?.[0] ?? null;
    const supported =
      v.status === 0 &&
      !!version &&
      h.status === 0 &&
      m.status === 0 &&
      /add/.test(m.text) &&
      s.status === 0 &&
      /list/.test(s.text);
    return {
      installed: true,
      executable: path,
      version,
      compatibility: supported ? 'PUBLIC_HELP_VERIFIED' : 'FAIL',
      authentication: 'NOT VERIFIED',
      reason: supported ? 'MODEL_EXECUTION_NOT_TESTED' : 'GEMINI_UNSUPPORTED',
      headless:
        h.text.includes('--output-format') &&
        (h.text.includes('--prompt') || h.text.includes('-p,')),
      safe_native_probe:
        h.text.includes('--allowed-mcp-server-names') &&
        h.text.includes('--approval-mode') &&
        /\bplan\b/.test(h.text),
      skills_help: s.status === 0,
      activation: 'NOT VERIFIED',
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
export function existingGeminiFiles(home: string) {
  return {
    settings_present: existsSync(join(home, '.gemini/settings.json')),
    context_present: existsSync(join(home, '.gemini/GEMINI.md')),
    credential_files_read: false,
    authentication: 'NOT VERIFIED',
  };
}

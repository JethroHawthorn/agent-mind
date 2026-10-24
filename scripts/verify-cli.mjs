// Opt-in live gate: native CLIs own authentication. Never read credential files.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { retrievedByClaude, savedByCodex } from './cli-evidence.mjs';

let flags;
try {
  flags = parseArgs({
    options: { experiences: { type: 'boolean' }, skills: { type: 'boolean' } },
    strict: true,
    allowPositionals: false,
  }).values;
} catch {
  console.error('Use no arguments for the memory gate, or --experiences.');
  process.exit(1);
}
if (flags.skills) {
  console.error(
    'The native skill workflow gate is unavailable until evaluation, operator review, publication and usage prerequisites are implemented.',
  );
  console.log(
    JSON.stringify({
      ok: false,
      cross_cli: 'NOT VERIFIED',
      gate: 'skills',
      reason: 'P2-008 prerequisites are pending',
    }),
  );
  process.exit(1);
}
const entry = fileURLToPath(new URL('../packages/mcp-server/dist/index.js', import.meta.url));
const project = mkdtempSync(join(tmpdir(), 'agentmind-live-'));
const db = join(project, 'memory.db');
const marker = `handoff${randomUUID().replaceAll('-', '')}`;
const status = { codex_save: false, claude_search: false, claude_restart_search: false };
const experiences = Boolean(flags.experiences);
const serverArgs = (agent) => [
  entry,
  '--project-root',
  project,
  '--db',
  db,
  '--source-agent',
  agent,
];

async function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: project,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let diagnostic = '';
    let failure;
    const stop = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* The owned process may already have exited. */
      }
    };
    const timeout = setTimeout(() => {
      failure = new Error(`${command}: timed out; check native login/connectivity.`);
      stop();
    }, 30000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.length > 4 * 1024 * 1024) {
        failure = new Error(`${command}: output limit exceeded.`);
        stop();
      }
    });
    // Classify native errors in memory; never persist or echo raw diagnostics.
    child.stderr.on('data', (chunk) => {
      if (diagnostic.length < 65536)
        diagnostic += chunk.toString().slice(0, 65536 - diagnostic.length);
    });
    child.once('error', () => {
      clearTimeout(timeout);
      reject(new Error(`${command}: could not start.`));
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      stop();
      if (failure || code !== 0) {
        const category = /operation not permitted|permission denied|EPERM|EACCES/i.test(diagnostic)
          ? 'local filesystem/process permissions'
          : /captcha|challenge/i.test(diagnostic)
            ? 'endpoint challenge'
            : /not logged in|login required|unauthorized|authentication|401/i.test(diagnostic)
              ? 'native authentication'
              : 'native configuration or connectivity';
        reject(failure ?? new Error(`${command}: exit ${code}; check ${category}.`));
        return;
      }
      try {
        resolve(
          output
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        );
      } catch {
        reject(new Error(`${command}: expected native JSON tool events.`));
      }
    });
  });
}

try {
  console.error(
    'Live verification uses your normal Codex/Claude accounts; no API key is required by AgentMind.',
  );
  const codex = await run('codex', [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--ignore-user-config',
    '--json',
    '--sandbox',
    'read-only',
    '-c',
    `mcp_servers.agentmind.command=${JSON.stringify(process.execPath)}`,
    '-c',
    `mcp_servers.agentmind.args=${JSON.stringify(serverArgs('codex'))}`,
    experiences
      ? `Call agentmind experience_record exactly once with problem "${marker} concurrent SQLite startup failed", solution "Retry journal mode changes on busy errors", outcome {"status":"succeeded","summary":"The local test fixture passed; this remains unverified."}, evidence [{"kind":"test","reference":"tests/integration/experience-mcp.test.ts"}]. Do not use shell tools or edit files.`
      : `Call agentmind memory_save exactly once with title "Live handoff", content "${marker} uses SQLite WAL.", kind "decision". Do not use shell tools or edit files.`,
  ]);
  const saved = savedByCodex(codex, marker, experiences);
  status.codex_save = true;
  const config = JSON.stringify({
    mcpServers: { agentmind: { command: process.execPath, args: serverArgs('claude') } },
  });
  const args = [
    '-p',
    `Call agentmind ${experiences ? 'experience_search' : 'memory_search'} with query "${marker}". Report its results. Do not save anything or use other tools.`,
    '--strict-mcp-config',
    '--mcp-config',
    config,
    '--tools',
    '',
    '--allowedTools',
    experiences ? 'mcp__agentmind__experience_search' : 'mcp__agentmind__memory_search',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
  ];
  retrievedByClaude(await run('claude', args), saved, experiences);
  status.claude_search = true;
  retrievedByClaude(await run('claude', args), saved, experiences);
  status.claude_restart_search = true;
  console.log(JSON.stringify({ ok: true, ...status, memory_id: saved.id }));
} catch (error) {
  console.error(error.message);
  console.log(JSON.stringify({ ok: false, ...status, cross_cli: 'NOT VERIFIED' }));
  process.exitCode = 1;
} finally {
  rmSync(project, { recursive: true, force: true });
}

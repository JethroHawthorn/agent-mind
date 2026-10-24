// Offline MCP verification. This exercises SDK clients, not Codex or Claude Code.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./mcp-call.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'agentmind-smoke-'));
const project = join(dir, 'project');
const other = join(dir, 'other');
mkdirSync(project);
mkdirSync(other);
const db = join(dir, 'shared.db');
function call(root, agent, name, args) {
  const result = spawnSync(process.execPath, [entry, root, db, agent, name, JSON.stringify(args)], {
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  assert.equal(result.status, 0, 'Independent SDK client must exit successfully');
  return JSON.parse(result.stdout);
}
try {
  const saved = await call(project, 'codex', 'memory_save', {
    title: 'Smoke decision',
    content: 'Orchid uses SQLite WAL.',
    kind: 'decision',
  });
  const found = await call(project, 'claude', 'memory_search', { query: 'Orchid' });
  assert.deepEqual(found.memories, [saved.memory]);
  const isolated = await call(other, 'unknown', 'memory_search', { query: 'Orchid' });
  assert.deepEqual(isolated.memories, []);
  console.log(
    'PASS: separate SDK client/server processes, restart persistence, project isolation. Real CLIs were not exercised.',
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

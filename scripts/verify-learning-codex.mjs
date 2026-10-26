// Explicit opt-in native probe. No auth/config files are read/copied; normal CLI authentication only.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MemoryService, openDatabase, resolveProject } from '../packages/core/dist/index.js';

const project = mkdtempSync(join(tmpdir(), 'agentmind-learning-native-'));
const database = join(project, 'registry.db');
const scope = resolveProject(project, project);
let db = openDatabase(database);
new MemoryService(db, scope, 'codex');
db.close();
const server = resolve('packages/mcp-server/dist/index.js');
try {
  writeFileSync(
    join(project, 'README.md'),
    'Disposable AgentMind learning-signal verification project. No production data.\n',
  );
  const config = `{agentmind_learning={command=${JSON.stringify(process.execPath)},args=${JSON.stringify([server, '--project-root', project, '--db', database, '--source-agent', 'codex', '--enable-learning'])},cwd=${JSON.stringify(project)}}`;
  const prompt =
    'Use only the agentmind_learning MCP server. Do not use shell tools, other servers, files, credentials or network tools. Call learning_signal_record exactly once with schema_version 1, type REUSABLE_WORKFLOW, title "Bounded clamp validation fixture", summary "For a clamp utility, inspect lower bound, upper bound and in-range cases before assuming that a single passing assertion covers the numeric contract.", reusability potentially_reusable, and task_ref "native-clamp-probe". This is an unverified fixture claim, not a task success report. Then call learning_signal_get with the returned signal ID and state its evidence trust. Do not approve, promote or install anything.';
  const child = spawnSync(
    'codex',
    [
      'exec',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--json',
      '-c',
      `mcp_servers=${config}`,
      prompt,
    ],
    { cwd: project, encoding: 'utf8', timeout: 45000, killSignal: 'SIGKILL', maxBuffer: 1048576 },
  );
  db = openDatabase(database);
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name='learning_signals'").get();
  const rows = exists
    ? db.prepare('SELECT payload_json FROM learning_signals WHERE project_id=?').all(scope.id)
    : [];
  const events = (child.stdout ?? '').split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const calls = events
    .filter(
      (event) =>
        event.type === 'item.completed' &&
        event.item?.type === 'mcp_tool_call' &&
        event.item.server === 'agentmind_learning' &&
        event.item.status === 'completed' &&
        !event.item.error &&
        !event.item.result?.isError,
    )
    .map((event) => event.item);
  const resultObjects = (value) => {
    if (typeof value === 'string') {
      try {
        return resultObjects(JSON.parse(value));
      } catch {
        return [];
      }
    }
    if (Array.isArray(value)) return value.flatMap(resultObjects);
    if (!value || typeof value !== 'object') return [];
    return [value, ...Object.values(value).flatMap(resultObjects)];
  };
  const verified = rows.some((r) => {
    const s = JSON.parse(r.payload_json);
    return (
      s.origin.source_agent === 'codex' &&
      s.origin.detection_source === 'agent_reported' &&
      s.triage.evidence_trust === 'AGENT_REPORTED' &&
      calls.some(
        (c) =>
          c.tool === 'learning_signal_record' && resultObjects(c.result).some((r) => r.id === s.id),
      ) &&
      calls.some(
        (c) =>
          c.tool === 'learning_signal_get' &&
          resultObjects(c.result).some((r) => r.id === s.id && r.project_id === scope.id),
      )
    );
  });
  // No raw native conversation/diagnostics are persisted. Content-free failure categories only.
  const stderr = child.stderr ?? '';
  const failure =
    child.error?.code ??
    (/permission|permitted|state database/i.test(stderr)
      ? 'LOCAL_STATE_PERMISSION'
      : /auth|login/i.test(stderr)
        ? 'AUTH_UNAVAILABLE'
        : 'NATIVE_INCOMPLETE');
  console.log(
    JSON.stringify(
      {
        status: verified ? 'REAL CODEX CAPTURE VERIFIED' : 'NOT VERIFIED',
        exit_code: child.status,
        signal: child.signal,
        failure: verified ? null : failure,
        stored_signals: rows.length,
        raw_transcript_stored: false,
        claude: 'NOT VERIFIED; authenticated native test deferred',
      },
      null,
      2,
    ),
  );
  process.exitCode = verified && child.status === 0 ? 0 : 1;
} finally {
  if (db.open) db.close();
  rmSync(project, { recursive: true, force: true });
}

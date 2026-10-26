// Read-only native integration probe. Does not fabricate approved sources or submit/approve skills.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { MemoryService, openDatabase, resolveProject } from '../packages/core/dist/index.js';

const { values } = parseArgs({
  options: { review: { type: 'boolean' } },
  strict: true,
  allowPositionals: false,
});
const tool = values.review ? 'review_queue' : 'skill_authoring_list';
const project = mkdtempSync(join(tmpdir(), 'agentmind-authoring-native-'));
const path = join(project, 'registry.db');
const scope = resolveProject(project, project);
const db = openDatabase(path);
new MemoryService(db, scope, 'codex');
db.close();
try {
  const config = `{agentmind_authoring={command=${JSON.stringify(process.execPath)},args=${JSON.stringify([resolve('packages/mcp-server/dist/index.js'), '--project-root', project, '--db', path, '--source-agent', 'codex', '--enable-authoring'])},cwd=${JSON.stringify(project)}}`;
  const result = spawnSync(
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
      `Use only agentmind_authoring MCP. Call ${tool} once. Do not submit candidates, record decisions, approve anything, use shell tools or read other files. Report that an empty list verifies connectivity only, not proposal authoring, human review or approval.`,
    ],
    { cwd: project, encoding: 'utf8', timeout: 45000, killSignal: 'SIGKILL', maxBuffer: 1048576 },
  );
  const observed = (result.stdout ?? '').split('\n').some((line) => {
    try {
      const e = JSON.parse(line);
      const i = e.item;
      return (
        e.type === 'item.completed' &&
        i?.type === 'mcp_tool_call' &&
        i.server === 'agentmind_authoring' &&
        i.tool === tool &&
        i.status === 'completed' &&
        !i.error &&
        !i.result?.isError
      );
    } catch {
      return false;
    }
  });
  const stderr = result.stderr ?? '';
  const reason =
    result.error?.code ??
    (/permission|permitted|state database/i.test(stderr)
      ? 'LOCAL_STATE_PERMISSION'
      : /auth|login/i.test(stderr)
        ? 'AUTH_UNAVAILABLE'
        : 'NATIVE_INCOMPLETE');
  console.log(
    JSON.stringify(
      {
        probed_tool: tool,
        proposal_review:
          'NOT VERIFIED; empty disposable registry probe checks read connectivity only',
        native_mcp: observed ? 'REAL CODEX MCP READ VERIFIED' : 'NOT VERIFIED',
        authoring_submission:
          'NOT VERIFIED; requires separately operator-approved experiences and explicit acceptance workflow',
        exit_code: result.status,
        signal: result.signal,
        failure: observed ? null : reason,
        raw_conversation_stored: false,
        claude: 'NOT VERIFIED; authenticated testing deferred',
      },
      null,
      2,
    ),
  );
  process.exitCode = observed && result.status === 0 ? 0 : 1;
} finally {
  rmSync(project, { recursive: true, force: true });
}

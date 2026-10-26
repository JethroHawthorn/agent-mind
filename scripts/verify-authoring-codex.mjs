// Read-only native integration probe. Does not fabricate approved sources or submit/approve skills.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { MemoryService, openDatabase, resolveProject } from '../packages/core/dist/index.js';
import { nativeProcess } from './native-process.mjs';

const { values } = parseArgs({
  options: {
    review: { type: 'boolean' },
    retrieval: { type: 'boolean' },
    routing: { type: 'boolean' },
  },
  strict: true,
  allowPositionals: false,
});
if ([values.review, values.retrieval, values.routing].filter(Boolean).length > 1)
  throw new Error('Choose one read probe.');
const tool = values.routing
  ? 'skill_route'
  : values.retrieval
    ? 'skill_discover'
    : values.review
      ? 'review_queue'
      : 'skill_authoring_list';
const project = mkdtempSync(join(tmpdir(), 'agentmind-authoring-native-'));
const path = join(project, 'registry.db');
const scope = resolveProject(project, project);
const db = openDatabase(path);
new MemoryService(db, scope, 'codex');
db.close();
try {
  const config = `{agentmind_authoring={command=${JSON.stringify(process.execPath)},args=${JSON.stringify([resolve('packages/mcp-server/dist/index.js'), '--project-root', project, '--db', path, '--source-agent', 'codex', values.retrieval || values.routing ? '--enable-retrieval' : '--enable-authoring'])},cwd=${JSON.stringify(project)}}`;
  const result = await nativeProcess(
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
      `Use only agentmind_authoring MCP. Call ${tool} once${values.routing ? ' with {"context":{"summary":"harmless offline discovery"},"limit":1}' : values.retrieval ? ' with {"query":"harmless offline discovery","limit":1}' : ''}. Do not submit candidates, record decisions, approve anything, use shell tools or read other files. Report that an empty list verifies connectivity only, not proposal authoring, human review or approval.`,
    ],
    project,
    45000,
  );
  const observed = result.events.some((e) => {
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
  });
  const verified = observed && result.exit_code === 0 && !result.failure;
  const reason =
    result.failure === 'local_permissions'
      ? 'LOCAL_STATE_PERMISSION'
      : result.failure === 'native_authentication'
        ? 'AUTH_UNAVAILABLE'
        : (result.failure ?? 'NATIVE_INCOMPLETE');
  console.log(
    JSON.stringify(
      {
        probed_tool: tool,
        retrieval_workflow:
          'NOT VERIFIED; an empty discovery probe cannot verify main/resource use or task behavior',
        proposal_review:
          'NOT VERIFIED; empty disposable registry probe checks read connectivity only',
        native_mcp: verified ? 'REAL CODEX MCP READ VERIFIED' : 'NOT VERIFIED',
        authoring_submission:
          'NOT VERIFIED; requires separately operator-approved experiences and explicit acceptance workflow',
        exit_code: result.exit_code,
        elapsed_ms: result.elapsed_ms,
        timeout_ms: result.timeout_ms,
        progress: result.progress,
        signal: result.signal,
        failure: verified ? null : reason,
        raw_conversation_stored: false,
        claude: 'NOT VERIFIED; authenticated testing deferred',
      },
      null,
      2,
    ),
  );
  process.exitCode = verified ? 0 : 1;
} finally {
  rmSync(project, { recursive: true, force: true });
}

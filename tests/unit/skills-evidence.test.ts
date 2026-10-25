import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  cleanupLearningFixture,
  createLearningFixture,
  loadLearningFixture,
  runLearningTest,
  verifyLearningSolution,
} from '../../scripts/learning-fixture.mjs';
import { nativeProcess, nativeTimeoutMs } from '../../scripts/native-process.mjs';
import {
  claudeExperienceEvidence,
  claudeSkillEvidence,
  codexDiscoveryEvidence,
  codexSkillContentEvidence,
  nativeStageComplete,
} from '../../scripts/skills-evidence.mjs';

const roots: string[] = [];
it('never advances a stored native stage with only discovery, only telemetry, or missing invocation evidence', () => {
  const complete = {
    artifact_integrity: 'FILESYSTEM VERIFIED',
    codex: { discovery: 'REAL CODEX VERIFIED', content: 'REAL CODEX VERIFIED' },
    claude: { invocation: 'REAL CLAUDE VERIFIED', telemetry_observed: true },
  };
  expect(nativeStageComplete(complete)).toBe(true);
  expect(nativeStageComplete({ ...complete, artifact_integrity: 'FAIL' })).toBe(false);
  expect(nativeStageComplete(undefined)).toBe(false);
  expect(nativeStageComplete({ ...complete, claude: { telemetry_observed: true } })).toBe(false);
  expect(
    nativeStageComplete({
      ...complete,
      claude: { invocation: 'REAL CLAUDE VERIFIED', telemetry_observed: false },
    }),
  ).toBe(false);
  expect(nativeStageComplete({ ...complete, codex: { discovery: 'NOT VERIFIED' } })).toBe(false);
  expect(nativeStageComplete({ ...complete, codex: { discovery: 'REAL CODEX VERIFIED' } })).toBe(
    false,
  );
});
it('requires a successful exact-version native Codex MCP result for post-install content availability', () => {
  const expected = { version_id: 'v1', project_id: 'p1', digest: 'digest', marker: 'NOTE1' };
  const result = {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          version: {
            id: 'v1',
            project_id: 'p1',
            content_hash: 'digest',
            files: [{ path: 'references/notes.md', content: 'NOTE1' }],
          },
        }),
      },
    ],
  };
  const events = [
    {
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        server: 'agentmind',
        tool: 'skill_get',
        status: 'completed',
        result,
      },
    },
  ];
  expect(codexSkillContentEvidence(events, expected)).toMatchObject({
    content: 'REAL CODEX VERIFIED',
  });
  expect(() => codexSkillContentEvidence(events, { ...expected, version_id: 'v2' })).toThrow();
  expect(() =>
    codexSkillContentEvidence(
      [{ type: 'item.completed', item: { type: 'agent_message', text: 'NOTE1' } }],
      expected,
    ),
  ).toThrow();
});
afterEach(() => {
  for (const root of roots.splice(0)) if (existsSync(root)) cleanupLearningFixture(root);
});
function fixture() {
  const f = createLearningFixture();
  roots.push(f.root);
  return f;
}
function tool(name: string, id: string, input: object, content: unknown, is_error = false) {
  return [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name, id, input }] } },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] },
    },
  ];
}
it('accepts exact native Codex discovery metadata but never copied files, another cwd/path or disabled skills', () => {
  const root = '/isolated/project';
  const path = '/isolated/project/.agents/skills/demo/SKILL.md';
  const metadata = {
    data: [{ cwd: root, errors: [], skills: [{ name: 'demo', path, enabled: true }] }],
  };
  expect(codexDiscoveryEvidence(metadata, root, 'demo', path)).toMatchObject({
    discovery: 'REAL CODEX VERIFIED',
  });
  for (const result of [
    { data: [] },
    { data: [{ ...metadata.data[0], cwd: '/other' }] },
    { data: [{ ...metadata.data[0], skills: [{ name: 'demo', path, enabled: false }] }] },
  ])
    expect(() => codexDiscoveryEvidence(result, root, 'demo', path)).toThrow();
  expect(() => codexDiscoveryEvidence(metadata, root, 'demo', '/other/SKILL.md')).toThrow();
});
it('requires correlated successful native Skill and Read results rather than assistant assertions', () => {
  const path = '/isolated/project/.claude/skills/demo/references/notes.md';
  const events = [
    ...tool('Skill', 'invoke', { skill: 'demo' }, 'expanded'),
    ...tool('Read', 'read', { file_path: path }, 'MARKER-V1'),
  ];
  expect(claudeSkillEvidence(events, 'demo', path, 'MARKER-V1')).toMatchObject({
    invocation: 'REAL CLAUDE VERIFIED',
  });
  expect(() =>
    claudeSkillEvidence(
      [{ message: { content: [{ type: 'text', text: 'I invoked demo and read MARKER-V1' }] } }],
      'demo',
      path,
      'MARKER-V1',
    ),
  ).toThrow();
  expect(() =>
    claudeSkillEvidence(
      [
        ...tool('Skill', 'bad', { skill: 'demo' }, 'failed', true),
        ...tool('Read', 'read', { file_path: path }, 'MARKER-V1'),
      ],
      'demo',
      path,
      'MARKER-V1',
    ),
  ).toThrow();
  expect(() => claudeSkillEvidence(events, 'demo', path, 'MARKER-V2')).toThrow();
  expect(() => claudeSkillEvidence(events, 'demo', '/wrong', 'MARKER-V1')).toThrow();
});
it('correlates native experience handoff by exact identity, project, content and provenance', () => {
  const saved = {
    id: 'fixture-id',
    project_id: 'fixture-project',
    problem: 'lower bound',
    solution: 'bound below first',
    source_agent: 'codex',
    approval_status: 'candidate',
    verification_status: 'unverified',
  };
  const events = tool(
    'mcp__agentmind__experience_search',
    'search',
    { query: 'lower bound' },
    JSON.stringify({ experiences: [saved] }),
  );
  expect(claudeExperienceEvidence(events, saved)).toMatchObject({ matched: true });
  expect(() => claudeExperienceEvidence(events, { ...saved, project_id: 'another' })).toThrow();
  expect(() =>
    claudeExperienceEvidence(
      [{ message: { content: [{ type: 'text', text: JSON.stringify(saved) }] } }],
      saved,
    ),
  ).toThrow();
});
it('bounds native process timeout and missing-command failures without a successful evidence result', async () => {
  const f = fixture();
  const timeout = await nativeProcess(
    process.execPath,
    ['-e', 'setInterval(()=>{},1000)'],
    f.root,
    150,
  );
  expect(timeout).toMatchObject({ failure: 'timeout', events: [] });
  expect(await nativeProcess('/nonexistent/agentmind-test-cli', [], f.root, 150)).toMatchObject({
    failure: 'unavailable',
    events: [],
  });
});
it('keeps only bounded non-content progress on failed native runs, never partial success evidence', async () => {
  const f = fixture();
  const code = `console.log('null');console.log(JSON.stringify({type:'system',subtype:'init',secret:'never-persist-native-content'}));
console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'private-call-id',input:{prompt:'never-persist-native-content'}}]}}));
console.log(JSON.stringify({type:'user',message:{content:[{type:'tool_result',tool_use_id:'private-call-id',content:'never-persist-native-content'}]}}));
setInterval(()=>{},1000);`;
  const result = await nativeProcess(process.execPath, ['-e', code], f.root, 400);
  expect(result).toMatchObject({
    failure: 'timeout',
    events: [],
    timeout_ms: 400,
    progress: {
      json_events: 3,
      initializations: 1,
      tool_calls: 1,
      tool_results: 1,
      final_results: 0,
    },
  });
  expect(JSON.stringify(result)).not.toMatch(/never-persist-native-content|private-call-id/);
});
it('validates operator-configured native timeout without changing any authorization decision', () => {
  expect(nativeTimeoutMs(undefined)).toBe(40000);
  expect(nativeTimeoutMs('180')).toBe(180000);
  for (const value of ['4', '181', '0', '1e2', 'true', '--force', ''])
    expect(() => nativeTimeoutMs(value)).toThrow('5–180');
  const r = spawnSync(
    process.execPath,
    [resolve('scripts/verify-skills.mjs'), '--status', '--native-timeout-seconds', '181'],
    { encoding: 'utf8', timeout: 5000 },
  );
  expect(r.status).toBe(1);
  expect(JSON.parse(r.stdout).overall).toBe('FAIL');
});
it('keeps deterministic bug/fix tests in disposable Git/home roots and refuses cleanup of a real checkout', () => {
  const f = fixture();
  expect(existsSync(`${f.root}/.git`)).toBe(true);
  expect(existsSync(`${f.root}/fake-home`)).toBe(true);
  expect(runLearningTest(f.root, false)).toMatchObject({ passed: false, exit_code: 1 });
  expect(verifyLearningSolution(f.root).passed).toBe(false);
  expect(runLearningTest(f.root, true)).toMatchObject({ passed: true, exit_code: 0 });
  expect(verifyLearningSolution(f.root).passed).toBe(true);
  expect(() => loadLearningFixture(process.cwd())).toThrow('non-disposable');
});
it('prepares and cleans up a native fixture without running CLIs or automatically approving anything', () => {
  const r = spawnSync(process.execPath, [resolve('scripts/verify-skills.mjs'), '--prepare'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(r.status, r.stderr).toBe(0);
  const data = JSON.parse(r.stdout);
  roots.push(data.project);
  expect(data).toMatchObject({
    ok: false,
    overall: 'NOT VERIFIED',
    stage: 'prepared',
    fixture_test: { exit_code: 1 },
    workflow_completed: false,
    acceptance_profile: {
      upgrade_policy: 'explicit-activation-gap-v1',
      approval_boundary: 'same-uid-local-confirmation',
      protected_operator_deployment: 'NOT VERIFIED',
      phase3_readiness: 'NO-GO',
    },
  });
  const clean = spawnSync(
    process.execPath,
    [resolve('scripts/verify-skills.mjs'), '--cleanup', data.project],
    { encoding: 'utf8', timeout: 5000 },
  );
  expect(clean.status).toBe(0);
  expect(existsSync(data.project)).toBe(false);
});

// Optional native-session runner; only marked disposable roots, never synthetic human approval.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { MemoryService, openDatabase, resolveProject } from '../packages/core/dist/index.js';
import { DAILY_TOOLS } from '../packages/mcp-server/dist/codex/configuration.js';
import { CodexSetup } from '../packages/mcp-server/dist/codex/setup.js';
import {
  loadContinuousFixture,
  prepareContinuousFixture,
  verifyContinuousTask,
} from './continuous-fixture.mjs';
import { cleanupLearningFixture } from './learning-fixture.mjs';
import { nativeProcess, nativeTimeoutMs } from './native-process.mjs';

const { values } = parseArgs({
  options: {
    prepare: { type: 'boolean' },
    probe: { type: 'boolean' },
    resume: { type: 'string' },
    cleanup: { type: 'string' },
    scenario: { type: 'string', default: 'A' },
    attempt: { type: 'string', default: '1' },
    'native-timeout-seconds': { type: 'string' },
  },
  strict: true,
  allowPositionals: false,
});
let fixture, db;
process.umask(0o077);
try {
  if (values.cleanup) {
    loadContinuousFixture(values.cleanup);
    cleanupLearningFixture(values.cleanup);
    console.log(JSON.stringify({ cleaned: true }));
  } else {
    const scenario = values.scenario;
    if (!/^[1-9]$/.test(values.attempt)) throw Error('Attempt must be 1..9');
    if (!['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].includes(scenario))
      throw Error('Unknown scenario');
    if (!values.prepare && !values.probe && !values.resume)
      throw Error('Choose prepare, probe or resume');
    fixture = values.resume ? loadContinuousFixture(values.resume) : prepareContinuousFixture();
    const root = fixture.root,
      path = join(root, 'registry.db'),
      scope = resolveProject(root, root);
    const setup = new CodexSetup({
      root,
      database: path,
      adapter: resolve('packages/mcp-server/dist/codex/adapter.js'),
      router: readFileSync('skills/agentmind-router/SKILL.md', 'utf8'),
    });
    const file = join(
      root,
      values.probe ? `p4-001-native-${scenario}-${values.attempt}.json` : 'p4-001-prepared.json',
    );
    if (existsSync(file)) throw Error('Evidence already exists; use a new explicit attempt.');
    setup.setup(); // Explicitly authorized fixture setup only; no real Codex home/config touched.
    db = openDatabase(path);
    const memory = new MemoryService(db, scope, 'unknown');
    if (!memory.search({ query: 'Daily boundary fixture' }).length)
      memory.save({
        title: 'Daily boundary fixture',
        content:
          'Preserve zero when clamping numeric values; inspect lower and upper limits independently.',
      });
    const report = {
      schema_version: 1,
      project: root,
      registry: path,
      scenario,
      overall: 'NOT VERIFIED',
      fixture_origin: 'HARNESS_GENERATED; seed memory was not learned by Codex',
      trigger:
        scenario === 'D'
          ? 'TASK_ONLY_PROMPT; router available, spontaneous capture not assumed'
          : scenario === 'F'
            ? 'HARNESS_TRIVIAL_TASK'
            : 'EXPLICIT_HARNESS_PROBE',
      native_scenarios: Object.fromEntries('ABCDEFGHI'.split('').map((s) => [s, 'NOT VERIFIED'])),
      tools: [],
      natural_learning: 'NOT VERIFIED',
      proposal_authorship: 'NOT VERIFIED',
      skill_application: 'NOT VERIFIED',
      human_approval: 'NOT VERIFIED',
      protected_deployment: 'NOT VERIFIED',
      autonomous_activation: 'NO-GO',
      raw_conversation_stored: false,
      reason: 'PREPARED_ONLY',
    };
    const prompts = {
      A: 'Use only the configured AgentMind MCP server. Call agentmind_status once and report the project identity. No shell tools, file edits, credentials, approval or distribution.',
      B: 'Use the configured AgentMind memory to find the Daily boundary fixture decision. Report its guidance without reading host files, changing state or claiming task success.',
      D: 'Repair clamp.ts so the numeric utility preserves both bounds and zero. Keep the existing signature and one-line formatting. Do not modify tests, execute generated/project code, read credentials, approve anything or install skills. Work only in this disposable project.',
      F: 'Reply with exactly the result of 2+2. This is a trivial arithmetic task.',
      G: 'In this fresh session, retrieve the existing Daily boundary fixture from AgentMind. Do not create a replacement or claim new learning.',
      H: 'Use only the configured AgentMind MCP memory_search tool to search Daily boundary fixture. Do not use host files or other servers.',
    };
    if (values.probe && ['C', 'E', 'I'].includes(scenario))
      report.reason =
        scenario === 'I'
          ? 'Run the isolated CLI setup/discovery integration tests; authenticated connectivity remains separate.'
          : 'Manual eligible source/skill approval required; no fixture approval is substituted in native sessions.';
    else if (values.probe) {
      let working = root,
        activeSetup = setup,
        other;
      if (scenario === 'H') {
        other = prepareContinuousFixture();
        working = other.root;
        activeSetup = new CodexSetup({
          root: working,
          database: path,
          adapter: setup.adapter,
          router: setup.router,
        });
        activeSetup.setup();
      }
      try {
        const count = (table) =>
          db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table)
            ? db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE project_id=?`).get(scope.id).n
            : 0;
        const before = [count('learning_signals'), count('authoring_proposals')];
        const config = `{${activeSetup.serverName}={command=${JSON.stringify(process.execPath)},args=${JSON.stringify([activeSetup.adapter, '--enrollment', join(working, '.agentmind/codex/enrollment.json')])},enabled_tools=${JSON.stringify(DAILY_TOOLS)}}}`;
        const result = await nativeProcess(
          'codex',
          [
            'exec',
            '--ignore-user-config',
            '--ephemeral',
            '--json',
            '--sandbox',
            'workspace-write',
            '--skip-git-repo-check',
            '-c',
            `mcp_servers=${config}`,
            prompts[scenario],
          ],
          working,
          nativeTimeoutMs(values['native-timeout-seconds']),
        );
        const calls = result.events
          .filter(
            (e) =>
              e.type === 'item.completed' &&
              e.item?.type === 'mcp_tool_call' &&
              e.item.server === activeSetup.serverName &&
              e.item.status === 'completed' &&
              !e.item.error &&
              !e.item.result?.isError,
          )
          .map((e) => e.item);
        report.tools = calls.map((c) => ({ tool: c.tool }));
        report.reason = result.failure ?? 'NATIVE_EVIDENCE_INCOMPLETE';
        Object.assign(report, {
          exit_code: result.exit_code,
          elapsed_ms: result.elapsed_ms,
          progress: result.progress,
        });
        const data = (call) => {
          try {
            return JSON.parse(
              call?.result?.content?.find((b) => b.type === 'text')?.text ?? 'null',
            );
          } catch {
            return null;
          }
        };
        let pass = false;
        if (scenario === 'A')
          pass = calls.some(
            (c) => c.tool === 'agentmind_status' && data(c)?.project_id === scope.id,
          );
        if (['B', 'G'].includes(scenario))
          pass = calls.some(
            (c) =>
              c.tool === 'memory_search' &&
              Array.isArray(data(c)?.memories) &&
              data(c).memories.some(
                (m) => m.project_id === scope.id && m.title === 'Daily boundary fixture',
              ),
          );
        if (scenario === 'H')
          pass = calls.some(
            (c) =>
              c.tool === 'memory_search' &&
              Array.isArray(data(c)?.memories) &&
              data(c).memories.length === 0,
          );
        if (scenario === 'D') {
          report.controlled_task = verifyContinuousTask(root, 'primary');
          pass =
            report.controlled_task.status === 'PASS' &&
            calls.some((c) => {
              const s = data(c);
              if (c.tool !== 'learning_signal_record' || typeof s?.id !== 'string') return false;
              const row = db
                .prepare('SELECT payload_json FROM learning_signals WHERE id=? AND project_id=?')
                .get(s.id, scope.id);
              if (!row) return false;
              const stored = JSON.parse(row.payload_json);
              return (
                stored.origin?.source_agent === 'codex' &&
                stored.origin?.detection_source === 'agent_reported' &&
                stored.triage?.evidence_trust === 'AGENT_REPORTED'
              );
            });
          if (pass)
            report.natural_learning =
              'OBSERVED_AGENT_SELECTED_CAPTURE_IN_HARNESS_TASK; router causation not established';
        }
        if (scenario === 'F')
          pass =
            calls.length === 0 &&
            before[0] === count('learning_signals') &&
            before[1] === count('authoring_proposals') &&
            !result.events.some((e) => e.item?.type === 'command_execution') &&
            result.events.some(
              (e) =>
                e.type === 'item.completed' &&
                e.item?.type === 'agent_message' &&
                e.item.text?.trim() === '4',
            );
        if (pass && result.exit_code === 0 && !result.failure) {
          report.native_scenarios[scenario] = 'PASS';
          report.reason = 'OBSERVED_NATIVE_STAGE_ONLY; full workflow remains NOT VERIFIED';
        }
      } finally {
        if (other) cleanupLearningFixture(other.root);
      }
    }

    writeFileSync(file, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(report));
    process.exitCode = values.prepare && !values.probe ? 0 : 2;
  }
} catch {
  console.log(
    JSON.stringify({
      overall: 'NOT VERIFIED',
      reason: 'DAILY_PROBE_FAILED',
      project: fixture?.root ?? null,
    }),
  );
  process.exitCode = 1;
} finally {
  db?.close();
}

// Native Claude verification only in explicitly marked disposable projects.
// Auth is handled solely by the installed CLI. No auth files or tokens are read/copied.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  MemoryService,
  openDatabase,
  resolveProject,
  safeError,
} from '../packages/core/dist/index.js';
import { capabilities } from '../packages/mcp-server/dist/claude/configuration.js';
import { ClaudeSetup } from '../packages/mcp-server/dist/claude/setup.js';
import { records } from './cli-evidence.mjs';
import {
  loadContinuousFixture,
  prepareContinuousFixture,
  verifyContinuousTask,
} from './continuous-fixture.mjs';
import { cleanupLearningFixture } from './learning-fixture.mjs';
import { nativeProcess, nativeTimeoutMs } from './native-process.mjs';
import { claudeToolResult } from './skills-evidence.mjs';

const { values: v } = parseArgs({
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
process.umask(0o077);
let db, createdRoot;
try {
  if (v.cleanup) {
    loadContinuousFixture(v.cleanup);
    cleanupLearningFixture(v.cleanup);
    console.log(JSON.stringify({ cleaned: true }));
  } else {
    if (!v.prepare && !v.probe && !v.resume) throw Error('Choose prepare, probe or resume.');
    if (!/^[A-L]$/.test(v.scenario) || !/^[1-9]$/.test(v.attempt))
      throw Error('Use scenario A-L and attempt 1-9.');
    const f = v.resume ? loadContinuousFixture(v.resume) : prepareContinuousFixture(),
      root = f.root,
      path = join(root, 'registry.db');
    if (!v.resume) createdRoot = root;
    const setup = new ClaudeSetup({
      root,
      home: join(root, 'fake-home'),
      database: path,
      adapter: resolve('packages/mcp-server/dist/claude/adapter.js'),
      router: readFileSync('skills/agentmind-router/SKILL.md', 'utf8'),
    });
    setup.setup(); // Explicit fixture-only setup; never real Claude settings.
    const scope = resolveProject(root, root);
    db = openDatabase(path);
    const memory = new MemoryService(db, scope, 'unknown');
    let saved = memory.search({ query: 'Daily boundary fixture' })[0];
    if (!saved)
      saved = memory.save({
        title: 'Daily boundary fixture',
        content: 'Preserve zero and inspect lower and upper numeric bounds independently.',
      });
    const file = join(
      root,
      `p4-002-${v.probe ? 'native' : 'prepared'}-${v.scenario}-${v.attempt}.json`,
    );
    if (existsSync(file)) throw Error('Evidence exists; select another explicit attempt.');
    const report = {
      schema_version: 1,
      project: root,
      registry: path,
      project_id: scope.id,
      version: capabilities(setup.claude).version,
      scenario: v.scenario,
      overall: 'NOT VERIFIED',
      scenarios: Object.fromEntries('ABCDEFGHIJKL'.split('').map((s) => [s, 'NOT VERIFIED'])),
      fixture_origin: 'HARNESS_GENERATED; not Codex-learned',
      human_approval: 'NOT VERIFIED',
      protected_deployment: 'NOT VERIFIED',
      autonomous_activation: 'NO-GO',
      behavioral_execution: 'NOT VERIFIED',
      trigger:
        v.scenario === 'E'
          ? 'TASK_ONLY; router available; capture not assumed'
          : 'EXPLICIT_HARNESS_REQUEST',
      model_execution: 'NOT VERIFIED',
      natural_learning: 'NOT VERIFIED',
      proposal_authorship: 'NOT VERIFIED',
      raw_transcript_stored: false,
      tools: [],
      reason: 'PREPARED_ONLY',
    };
    const prompts = {
      A: 'Call only the configured AgentMind agentmind_status MCP tool once. Return its project ID. Do not edit, approve, install or claim task success.',
      B: 'Invoke the project agentmind-router Skill once. Do not search memory, change files, approve or distribute anything.',
      C: 'Search AgentMind memory for Daily boundary fixture. State the existing guidance, without changing records or claiming new learning.',
      E: 'Repair clamp.ts to preserve both numeric bounds and zero. Keep its signature and one-line format. Do not modify tests, execute code, read credentials, approve or install anything. Work only in this disposable project.',
      I: 'Reply with exactly the result of 2+2. This is a trivial arithmetic task.',
      J: 'This is a fresh session. Retrieve the existing Daily boundary fixture memory from AgentMind without creating a replacement.',
      K: 'Search AgentMind memory for Daily boundary fixture. Do not read host files or use another server.',
    };
    if (v.probe && !prompts[v.scenario])
      report.reason =
        v.scenario === 'G'
          ? 'NO_HOOKS_INSTALLED'
          : 'MANUAL_GATE_REQUIRED; use documented genuine operator/evaluation workflow, never synthetic native approval';
    else if (v.probe) {
      let runRoot = root,
        foreign;
      if (v.scenario === 'K') {
        foreign = prepareContinuousFixture();
        runRoot = foreign.root;
        const other = new ClaudeSetup({
          root: runRoot,
          home: join(runRoot, 'fake-home'),
          database: path,
          adapter: setup.adapter,
          router: setup.options.router,
        });
        other.setup();
      }
      try {
        const enrollment = join(runRoot, '.agentmind/claude/enrollment.json');
        const toolNames = [
          'agentmind_status',
          'memory_search',
          'experience_search',
          'skill_route',
          'skill_discover',
          'skill_load',
          'skill_resources',
          'skill_resource_get',
        ];
        if (v.scenario === 'E') toolNames.push('experience_record', 'learning_signal_record');
        const names = toolNames.map((n) => `mcp__agentmind__${n}`);
        const before = db.prepare('SELECT COUNT(*) AS n FROM memories').get().n;
        const result = await nativeProcess(
          setup.claude,
          [
            '-p',
            prompts[v.scenario],
            '--output-format',
            'stream-json',
            '--verbose',
            '--no-session-persistence',
            '--strict-mcp-config',
            '--mcp-config',
            JSON.stringify({
              mcpServers: {
                agentmind: {
                  type: 'stdio',
                  command: process.execPath,
                  args: [setup.adapter, '--enrollment', enrollment],
                },
              },
            }),
            '--settings',
            JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false }),
            '--setting-sources',
            'user,project',
            '--tools',
            v.scenario === 'B' ? 'Skill' : v.scenario === 'E' ? 'Read,Edit' : '',
            '--allowedTools',
            ...names,
            ...(v.scenario === 'B' ? ['Skill'] : v.scenario === 'E' ? ['Read', 'Edit'] : []),
            '--permission-mode',
            'dontAsk',
          ],
          runRoot,
          nativeTimeoutMs(v['native-timeout-seconds']),
        );
        report.exit_code = result.exit_code;
        report.elapsed_ms = result.elapsed_ms;
        report.progress = result.progress;
        report.reason = result.failure ?? 'CORRELATED_EVIDENCE_REQUIRED';
        const complete =
          result.exit_code === 0 &&
          !result.failure &&
          result.progress.final_results > 0 &&
          result.progress.result_errors === 0;
        if (complete) {
          report.model_execution = 'REAL CLAUDE VERIFIED';
          for (const e of result.events)
            for (const b of e.message?.content ?? [])
              if (
                b.type === 'tool_use' &&
                typeof b.name === 'string' &&
                /^(mcp__agentmind__|Skill$|Read$|Edit$)/.test(b.name)
              )
                report.tools.push(b.name);
          try {
            if (v.scenario === 'A')
              claudeToolResult(result.events, 'mcp__agentmind__agentmind_status', (_i, c) =>
                records(c).some((r) => r.project_id === scope.id && r.source_agent === 'claude'),
              );
            if (['C', 'J'].includes(v.scenario))
              claudeToolResult(result.events, 'mcp__agentmind__memory_search', (_i, c) =>
                records(c).some((r) => r.id === saved.id && r.project_id === scope.id),
              );
            if (v.scenario === 'K')
              claudeToolResult(
                result.events,
                'mcp__agentmind__memory_search',
                (_i, c) =>
                  JSON.stringify(c).includes('memories') &&
                  !JSON.stringify(c).includes(saved.id) &&
                  !JSON.stringify(c).includes(saved.content),
              );
            if (v.scenario === 'B')
              claudeToolResult(result.events, 'Skill', (i) => i.skill === 'agentmind-router');
            if (v.scenario === 'I') {
              const end = result.events.find((e) => e.type === 'result');
              if (
                result.progress.tool_calls !== 0 ||
                String(end?.result ?? '').trim() !== '4' ||
                db.prepare('SELECT COUNT(*) AS n FROM memories').get().n !== before
              )
                throw Error('noise');
            }
            if (v.scenario === 'E') {
              report.controlled_task = verifyContinuousTask(root, 'primary');
              claudeToolResult(result.events, 'mcp__agentmind__learning_signal_record', (_i, c) =>
                records(c).some((r) => r.id && r.evidence_trust === 'AGENT_REPORTED'),
              );
              if (report.controlled_task.status !== 'PASS') throw Error('task not verified');
              report.natural_learning =
                'REAL CLAUDE VERIFIED; task-only prompt, router-guided capture, agent-reported evidence';
            }
            report.scenarios[v.scenario] = 'PASS';
            report.reason = 'CORRELATED_NATIVE_EVIDENCE';
          } catch {
            report.scenarios[v.scenario] = 'FAIL';
            report.reason = 'MISSING_CORRELATED_EVIDENCE';
          }
        }
      } finally {
        if (foreign) cleanupLearningFixture(foreign.root);
      }
    }
    writeFileSync(file, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(report));
    if (v.probe) process.exitCode = 2; // Overall A-L and real cross-agent/human acceptance remain incomplete.
  }
} catch (error) {
  db?.close();
  db = undefined;
  if (createdRoot) {
    try {
      cleanupLearningFixture(createdRoot);
    } catch {
      /* retain unsafe/unrecognized fixture for inspection */
    }
  }
  console.error(`[agentmind] ${safeError(error).code}`);
  console.error(
    'Claude verification failed; check fixture, supported CLI, permissions and bounded timeout. No credentials or transcript output is emitted.',
  );
  process.exitCode = 1;
} finally {
  db?.close();
}

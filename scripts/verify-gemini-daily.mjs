// All mutable state is confined to a marked disposable fixture. Never copy or inspect credentials.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  MemoryService,
  openDatabase,
  resolveProject,
  safeError,
} from '../packages/core/dist/index.js';
import {
  geminiCapabilities,
  settingsDocument,
} from '../packages/mcp-server/dist/gemini/configuration.js';
import { readSettings } from '../packages/mcp-server/dist/gemini/policy.js';
import { GeminiSetup } from '../packages/mcp-server/dist/gemini/setup.js';
import { loadContinuousFixture, prepareContinuousFixture } from './continuous-fixture.mjs';
import { geminiCompleted, geminiToolEvidence } from './gemini-evidence.mjs';
import { cleanupLearningFixture } from './learning-fixture.mjs';
import { nativeProcess, nativeTimeoutMs } from './native-process.mjs';

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
let db, created;
try {
  if (v.cleanup) {
    loadContinuousFixture(v.cleanup);
    cleanupLearningFixture(v.cleanup);
    console.log(JSON.stringify({ cleaned: true }));
  } else {
    if (!v.prepare && !v.probe && !v.resume) throw Error('Choose prepare, probe or resume.');
    if (!/^[A-M]$/.test(v.scenario) || !/^[1-9]$/.test(v.attempt))
      throw Error('Scenario A-M, attempt 1-9.');
    const f = v.resume ? loadContinuousFixture(v.resume) : prepareContinuousFixture();
    if (!v.resume) created = f.root;
    const root = f.root,
      home = join(root, 'fake-home'),
      registry = join(root, 'registry.db');
    const setup = new GeminiSetup({
      root,
      home,
      database: registry,
      adapter: resolve('packages/mcp-server/dist/gemini/adapter.js'),
      router: readFileSync('skills/agentmind-router/SKILL.md', 'utf8'),
    });
    setup.setup();
    // This test-project-only override prevents ordinary user hooks/telemetry entering fixture reports.
    const settings = settingsDocument(readFileSync(setup.config, 'utf8'));
    settings.hooksConfig = { enabled: false };
    settings.telemetry = { enabled: false, logPrompts: false };
    writeFileSync(setup.config, JSON.stringify(settings));
    const scope = resolveProject(root, root);
    db = openDatabase(registry);
    const memory = new MemoryService(db, scope, 'unknown');
    let seed = memory.search({ query: 'Gemini boundary fixture' })[0];
    if (!seed)
      seed = memory.save({
        title: 'Gemini boundary fixture',
        content: 'Inspect lower and upper numeric boundaries separately; preserve zero.',
      });
    const file = join(
      root,
      `p4-003-${v.probe ? 'native' : 'prepared'}-${v.scenario}-${v.attempt}.json`,
    );
    if (existsSync(file)) throw Error('Use a new explicit attempt; evidence is append-only.');
    const capabilities = geminiCapabilities();
    const report = {
      schema_version: 1,
      project: root,
      project_id: scope.id,
      scenario: v.scenario,
      overall: 'NOT VERIFIED',
      scenarios: Object.fromEntries('ABCDEFGHIJKLM'.split('').map((x) => [x, 'NOT VERIFIED'])),
      cli: capabilities,
      authentication: 'NOT VERIFIED',
      model_execution: 'NOT VERIFIED',
      native_discovery: 'NOT VERIFIED',
      native_activation: 'NOT VERIFIED',
      trigger: 'EXPLICIT_HARNESS_REQUEST',
      fixture_origin: 'HARNESS_GENERATED; no native source-agent authorship',
      source_authorship: 'NOT VERIFIED',
      receiving_application: 'NOT VERIFIED',
      task_outcome: 'NOT VERIFIED',
      human_approval: 'NOT VERIFIED',
      behavioral_execution: 'NOT VERIFIED',
      protected_deployment: 'NOT VERIFIED',
      autonomous_activation: 'NO-GO',
      hooks_installed: false,
      raw_transcript_stored_by_agentmind: false,
      native_cli_history: 'MAY_EXIST_IN_DISPOSABLE_HOME; NOT INGESTED',
      reason: v.probe ? capabilities.reason : 'PREPARED_ONLY',
    };
    const prompts = {
      A: 'Call only the AgentMind agentmind_status MCP tool once and report project identity. No edits, commands, authentication, approval or installation.',
      D: 'Search AgentMind memory for Gemini boundary fixture. Report the existing guidance without claiming successful application, changing records or reading host files.',
      K: 'In this fresh session search AgentMind memory for Gemini boundary fixture without creating a replacement.',
    };
    if (v.probe && capabilities.installed) {
      if (!capabilities.safe_native_probe || !capabilities.headless)
        report.reason = 'SAFE_HEADLESS_FLAGS_NOT_VERIFIED';
      else if (!prompts[v.scenario])
        report.reason =
          'MANUAL_GATE_REQUIRED; discovery/activation/authorship/approval/application require separate observed evidence';
      else if (
        setup.layers
          .filter((l) => l.label === 'system')
          .some((l) => settingsDocument(readSettings(l)).hooksConfig?.enabled === true)
      )
        report.reason = 'ADMIN_HOOK_OVERRIDE; native probe disabled, policy unchanged';
      else {
        const result = await nativeProcess(
          capabilities.executable,
          [
            '--prompt',
            prompts[v.scenario],
            '--output-format',
            'stream-json',
            '--allowed-mcp-server-names',
            'agentmind',
            '--approval-mode',
            'plan',
          ],
          root,
          nativeTimeoutMs(v['native-timeout-seconds']),
          { ...process.env, HOME: home, GEMINI_CLI_HOME: home },
        );
        report.exit_code = result.exit_code;
        report.elapsed_ms = result.elapsed_ms;
        report.reason = result.failure ?? 'MISSING_CORRELATED_EVIDENCE';
        report.event_counts = {
          init: result.events.filter((e) => e.type === 'init').length,
          tool_calls: result.events.filter((e) => e.type === 'tool_use').length,
          tool_results: result.events.filter((e) => e.type === 'tool_result').length,
        };
        if (geminiCompleted(result)) {
          report.model_execution = 'REAL GEMINI VERIFIED';
          report.authentication = 'CLI_MODEL_EXECUTION_OBSERVED; method not inspected';
          const matched =
            v.scenario === 'A'
              ? geminiToolEvidence(result, 'mcp_agentmind_agentmind_status', (_i, objects) =>
                  objects.some(
                    (r) =>
                      r.ok === true && r.project_id === scope.id && r.source_agent === 'gemini',
                  ),
                )
              : geminiToolEvidence(result, 'mcp_agentmind_memory_search', (_i, objects) =>
                  objects.some(
                    (r) =>
                      r.id === seed.id && r.project_id === scope.id && r.content === seed.content,
                  ),
                );
          report.scenarios[v.scenario] = matched ? 'PASS' : 'FAIL';
          report.reason = matched ? 'CORRELATED_NATIVE_EVIDENCE' : 'MISSING_CORRELATED_EVIDENCE';
        }
      }
    }
    writeFileSync(file, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(report));
    if (v.probe) process.exitCode = 2;
  }
} catch (e) {
  db?.close();
  db = undefined;
  if (created) {
    try {
      cleanupLearningFixture(created);
    } catch {}
  }
  console.error(
    `[agentmind] ${safeError(e).code}: Gemini verification could not complete. No credentials or transcript output emitted.`,
  );
  process.exitCode = 1;
} finally {
  db?.close();
}

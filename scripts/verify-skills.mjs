// Opt-in resumable native acceptance gate. NO automated approval or installation capability.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ExperienceService,
  hashSkillFiles,
  openDatabase,
  resolveProject,
  SkillDistributionService,
  SkillEvaluationService,
  SkillStore,
} from '../packages/core/dist/index.js';
import { savedByCodex } from './cli-evidence.mjs';
import {
  cleanupLearningFixture,
  createLearningFixture,
  FIX,
  loadLearningFixture,
  runLearningTest,
  saveLearningFixture,
  skillFixtureFiles,
  verifyLearningSolution,
} from './learning-fixture.mjs';
import { discoverCodex, nativeProcess, nativeTimeoutMs } from './native-process.mjs';
import {
  claudeExperienceEvidence,
  claudeSkillEvidence,
  codexSkillContentEvidence,
  nativeStageComplete,
} from './skills-evidence.mjs';

const server = fileURLToPath(new URL('../packages/mcp-server/dist/index.js', import.meta.url));
const script = (name) =>
  fileURLToPath(new URL(`../packages/mcp-server/dist/${name}.js`, import.meta.url));
const quote = (token) => `'${String(token).replaceAll("'", "'\\''")}'`;
let fixture;
let db;
const emit = (extra, code = 1) => {
  const result = {
    ok: false,
    gate: 'skills',
    overall: 'NOT VERIFIED',
    cross_cli: 'NOT VERIFIED',
    workflow_completed: false,
    acceptance_profile: {
      upgrade_policy: 'explicit-activation-gap-v1',
      approval_boundary: 'same-uid-local-confirmation',
      protected_operator_deployment: 'NOT VERIFIED',
      phase3_readiness: 'NO-GO',
    },
    ...extra,
  };
  if (fixture) {
    saveLearningFixture(fixture);
    result.project = fixture.root;
    result.native = fixture.native ?? {};
    writeFileSync(
      join(fixture.root, 'acceptance-evidence.json'),
      `${JSON.stringify({ ...result, native: fixture.native ?? {} }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  console.log(JSON.stringify(result));
  process.exitCode = code;
};
async function main() {
  process.umask(0o077);
  const { values: flags } = parseArgs({
    options: {
      skills: { type: 'boolean' },
      prepare: { type: 'boolean' },
      resume: { type: 'string' },
      status: { type: 'boolean' },
      probe: { type: 'boolean' },
      cleanup: { type: 'string' },
      help: { type: 'boolean' },
      'native-timeout-seconds': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (flags.help) {
    console.log(
      'Native skills gate: --prepare | --resume /absolute/disposable/project | --probe | --status | --cleanup /absolute/disposable/project [--native-timeout-seconds 5..180, default 40]. Native authentication stays with each CLI. Approval/promotion/sync/rollback always require operator commands in their own terminal.',
    );
    return;
  }
  if (flags.cleanup) {
    cleanupLearningFixture(flags.cleanup);
    console.log(JSON.stringify({ cleaned: true }));
    return;
  }
  const timeoutMs = nativeTimeoutMs(flags['native-timeout-seconds']);
  const runNative = (command, args, root) => nativeProcess(command, args, root, timeoutMs);
  if (flags.status && !flags.resume) {
    emit({
      reason:
        'Run the opt-in native gate or prepare/resume an isolated fixture; no native workflow evidence has been collected.',
    });
    return;
  }
  fixture = flags.resume ? loadLearningFixture(flags.resume) : createLearningFixture();
  const root = fixture.root;
  const path = join(root, 'registry.db');
  const home = join(root, 'fake-home');
  db = openDatabase(path);
  const scope = resolveProject(root, root);
  const store = new SkillStore(db, scope);
  const operator = (name, args) =>
    [process.execPath, script(name), '--project-root', root, '--db', path, ...args]
      .map(quote)
      .join(' ');
  const pause = (stage, commands, reason) =>
    emit(
      {
        stage,
        reason,
        operator_action_required: true,
        operator_cwd: root,
        operator_commands: commands,
        evidence_level: 'NOT VERIFIED',
      },
      2,
    );
  const serverArgs = (agent) => [
    server,
    '--project-root',
    root,
    '--db',
    path,
    '--source-agent',
    agent,
  ];
  const codexArgs = (prompt, sandbox = 'workspace-write') => [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--skip-git-repo-check',
    '--json',
    '--sandbox',
    sandbox,
    '-c',
    `mcp_servers.agentmind.command=${JSON.stringify(process.execPath)}`,
    '-c',
    `mcp_servers.agentmind.args=${JSON.stringify(serverArgs('codex'))}`,
    prompt,
  ];
  const claudeArgs = (prompt, skill = false) => [
    '-p',
    '--no-session-persistence',
    '--output-format',
    'stream-json',
    '--verbose',
    '--setting-sources',
    'project,local',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify({
      mcpServers: { agentmind: { command: process.execPath, args: serverArgs('claude') } },
    }),
    '--tools',
    skill ? 'Skill,Read' : '',
    '--allowedTools',
    skill ? 'Skill,Read,mcp__agentmind__skill_usage_record' : 'mcp__agentmind__experience_search',
    ...(skill ? ['--settings', join(root, 'verification-hooks.json')] : []),
    '--permission-mode',
    'plan',
    '--',
    prompt,
  ];
  const nativeStatus = (r) => ({
    exit_code: r.exit_code,
    signal: r.signal,
    failure: r.failure,
    elapsed_ms: r.elapsed_ms,
    timeout_ms: r.timeout_ms,
    progress: r.progress,
  });
  const marker = `clamp${fixture.nonce.replaceAll('-', '')}`;
  if (flags.prepare) {
    const bug = runLearningTest(root, false);
    emit(
      {
        stage: 'prepared',
        fixture_test: bug,
        reason: 'Disposable fixture ready; no native or human verification claimed.',
      },
      0,
    );
    return;
  }
  if (flags.status) {
    emit({
      stage: 'status',
      native: fixture.native ?? {},
      reason: 'Stored local observations only. Resume to recheck actual registry and native state.',
    });
    return;
  }
  fixture.native ??= {};
  if (!fixture.experience_id) {
    const existing = db
      .prepare(
        "SELECT id FROM experiences WHERE project_id=? AND source_agent='codex' AND json_extract(provenance_json,'$.task_ref')=? LIMIT 1",
      )
      .get(scope.id, marker);
    if (existing) {
      emit({
        reason:
          'An earlier experience exists without its correlated native capture receipt. Do not blindly retry append-only recording; use a fresh fixture or inspect manually.',
      });
      return;
    }
    const bug = runLearningTest(root, false);
    if (bug.exit_code !== 1) throw new Error('Controlled bug did not fail its fixture test.');
    const prompt = `Work only in this disposable project. Fix clamp.ts to exactly this code (including final newline): ${JSON.stringify(FIX)}. Do not change the test or any other files, configuration or operator state. Call agentmind experience_record exactly once with problem "${marker} clamp ignores the lower bound", solution "Use Math.min(Math.max(value, min), max)", outcome {"status":"unknown","summary":"The independent verifier must run the defined fixture; this report is not verified success."}, evidence [{"kind":"test","reference":"clamp.test.mjs"}], provenance {"task_ref":"${marker}"}. Do not approve, promote, install or roll back anything.`;
    const codex = await runNative('codex', codexArgs(prompt), root);
    fixture.native.codex_capture = { status: 'NOT VERIFIED', ...nativeStatus(codex) };
    if (codex.failure) {
      // Independently probe Claude without pretending that an empty search proves a handoff.
      const claude = await runNative(
        'claude',
        claudeArgs(
          `Call agentmind experience_search with query "${marker}". Do not save anything.`,
        ),
        root,
      );
      fixture.native.claude_probe = {
        status: 'NOT VERIFIED',
        ...nativeStatus(claude),
        meaning: 'Availability probe only; no matching experience handoff proved.',
      };
      emit({
        stage: 'native-capture',
        reason:
          'Native experience capture did not complete. No synthetic approval or native-use evidence substituted.',
      });
      return;
    }
    let saved;
    try {
      saved = savedByCodex(codex.events, marker, true);
    } catch {
      emit({
        stage: 'native-capture',
        reason:
          'No correlated successful native Codex experience tool result. Existing SQLite content alone cannot substitute for native evidence.',
      });
      return;
    }
    if (saved.project_id !== scope.id) throw new Error('Native capture scope mismatch.');
    const persisted = new ExperienceService(db, scope).inspect(saved.id);
    if (
      persisted.problem !== saved.problem ||
      persisted.solution !== saved.solution ||
      persisted.source_agent !== 'codex'
    )
      throw new Error('Native capture does not match SQLite.');
    fixture.experience_id = saved.id;
    fixture.native.codex_capture = {
      status: 'REAL CODEX VERIFIED',
      ...nativeStatus(codex),
      experience_id: saved.id,
    };
    saveLearningFixture(fixture);
  }
  const experience = new ExperienceService(db, scope).inspect(fixture.experience_id);
  if (!fixture.native.claude_handoff) {
    const claude = await runNative(
      'claude',
      claudeArgs(
        `Call agentmind experience_search with query "${marker}". Report its observed results without saving anything.`,
      ),
      root,
    );
    if (claude.failure) {
      fixture.native.claude_probe = { status: 'NOT VERIFIED', ...nativeStatus(claude) };
      emit({
        stage: 'native-handoff',
        reason: 'Claude did not complete the native experience retrieval.',
      });
      return;
    }
    try {
      claudeExperienceEvidence(claude.events, experience);
    } catch {
      emit({
        stage: 'native-handoff',
        reason: 'No correlated native Claude result matching the exact saved experience.',
      });
      return;
    }
    fixture.native.claude_handoff = {
      status: 'REAL CLAUDE VERIFIED',
      experience_id: experience.id,
    };
    saveLearningFixture(fixture);
  }
  const solution = verifyLearningSolution(root);
  if (!solution.passed) {
    emit({
      overall: 'FAIL',
      stage: 'controlled-task',
      reason: 'Native source is not the exact allowlisted solution or its controlled test failed.',
      controlled_test: solution,
    });
    return;
  }
  fixture.controlled_test = solution;
  if (flags.probe) {
    emit({
      stage: 'native-handoff',
      native: fixture.native,
      reason: 'Probe stops before human approval. Run --resume to prepare the review boundary.',
    });
    return;
  }
  if (experience.approval_status !== 'approved') {
    pause(
      'experience-review',
      [
        operator('review', ['--inspect', experience.id]),
        operator('review', [
          '--id',
          experience.id,
          '--decision',
          'approved',
          '--expected-updated-at',
          experience.updated_at,
          '--reviewer',
          'local operator',
          '--reason',
          'Inspected the exact disposable clamp fixture acceptance results.',
        ]),
      ],
      'Human experience review required. This verifier never performs it.',
    );
    return;
  }
  async function propose(revision) {
    const client = new Client({ name: 'agentmind-native-verification-fixture', version: '1' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: serverArgs('codex'),
        cwd: root,
        stderr: 'pipe',
      }),
    );
    try {
      const reply = await client.callTool({
        name: 'skill_propose',
        arguments: {
          name: fixture.name,
          description: 'Check lower and upper bounds in a numeric clamp utility',
          source_experience_ids: [experience.id],
          expected_latest_version: revision - 1,
          files: skillFixtureFiles(fixture, revision),
        },
      });
      if (reply.isError) throw new Error('Fixture proposal rejected.');
      return JSON.parse(reply.content[0].text).version.id;
    } finally {
      await client.close();
    }
  }
  async function ready(revision) {
    const key = revision === 1 ? 'v1' : 'v2';
    if (!fixture[key]) {
      fixture[key] = await propose(revision);
      saveLearningFixture(fixture);
    }
    let r = store.getVersion(fixture[key]);
    if (
      store.getIdentity(r.version.skill_id).name !== fixture.name ||
      hashSkillFiles(r.version.files) !== hashSkillFiles(skillFixtureFiles(fixture, revision))
    )
      throw new Error('Artifact is not the exact code-owned verification fixture.');
    if (r.state.status === 'candidate') {
      const evaluation = new SkillEvaluationService(db, scope).evaluate({
        version_id: r.version.id,
        expected_content_hash: r.version.content_hash,
        expected_state_revision: r.state.revision,
      });
      r = store.getVersion(r.version.id);
      if (evaluation.evaluation.result !== 'PASS') {
        const active = store.getIdentity(r.version.skill_id).active_version_id;
        pause(
          'evaluation-policy',
          active
            ? [
                operator('skill-operator', ['--diff', r.version.id]),
                operator('skill-operator', ['--deactivate', active]),
              ]
            : [],
          'The standard explicit-activation-gap-v1 procedure requires operator-reviewed deactivation before reevaluation of changed content. Do not sync the gap. Continuous-active upgrading is unsupported; no evaluation waiver exists.',
        );
        return null;
      }
      pause(
        'skill-approval',
        [
          operator('skill-operator', ['--show', r.version.id]),
          operator('skill-operator', ['--evaluation', r.version.id]),
          operator('skill-operator', ['--approve', r.version.id]),
          operator('skill-operator', ['--promote', r.version.id]),
        ],
        'Exact candidate approval and promotion must be performed by the operator.',
      );
      return null;
    }
    if (r.state.status !== 'approved') {
      emit({
        overall: 'FAIL',
        reason: 'Candidate was rejected; create a new fixture instead of reviving it.',
      });
      return null;
    }
    if (store.getIdentity(r.version.skill_id).active_version_id !== r.version.id) {
      pause(
        'skill-promotion',
        [operator('skill-operator', ['--promote', r.version.id])],
        'Approved version is not active. Explicit operator action required.',
      );
      return null;
    }
    return r.version;
  }
  async function installed(version) {
    const request = { skill_id: version.skill_id, target: 'all', scope: 'project' };
    const plan = new SkillDistributionService(db, scope, home).plan(request);
    if (plan.entries.some((e) => e.action === 'CONFLICT')) {
      emit({
        overall: 'FAIL',
        stage: 'distribution',
        reason: 'Distribution conflict; preserve local files and inspect with the operator CLI.',
      });
      return false;
    }
    if (plan.entries.some((e) => e.action !== 'SKIP')) {
      pause(
        'distribution',
        [
          operator('skill-distribute', [
            '--home-root',
            home,
            '--skill-id',
            version.skill_id,
            '--target',
            'all',
            '--scope',
            'project',
            '--sync',
            '--dry-run',
          ]),
          operator('skill-distribute', [
            '--home-root',
            home,
            '--skill-id',
            version.skill_id,
            '--target',
            'all',
            '--scope',
            'project',
            '--sync',
          ]),
        ],
        'Only an operator may synchronize approved active content.',
      );
      return false;
    }
    return true;
  }
  async function verifyNative(version, revision) {
    const codex = await discoverCodex(
      root,
      fixture.name,
      join(root, '.agents', 'skills', fixture.name, 'SKILL.md'),
    );
    const codexSession = await runNative(
      'codex',
      codexArgs(
        `Use $${fixture.name}. Call agentmind skill_get with version_id "${version.id}" and inspect its supporting note. Do not edit files or run shell commands. This is content availability verification, not permission to approve or promote anything.`,
        'read-only',
      ),
      root,
    );
    codex.session = nativeStatus(codexSession);
    if (!codexSession.failure) {
      try {
        Object.assign(
          codex,
          codexSkillContentEvidence(codexSession.events, {
            version_id: version.id,
            project_id: scope.id,
            digest: version.content_hash,
            marker: `CLAMP_${fixture.nonce}_V${revision}`,
          }),
        );
      } catch {
        codex.content = 'NOT VERIFIED';
      }
    }
    const installation = db
      .prepare(
        "SELECT id FROM skill_installations WHERE project_id=? AND version_id=? AND target='claude' AND status='installed'",
      )
      .get(scope.id, version.id);
    if (!installation) throw new Error('Claude installation record missing.');
    const command = [
      process.execPath,
      script('skill-usage-hook'),
      '--project-root',
      root,
      '--db',
      path,
      '--installation-id',
      installation.id,
    ]
      .map(quote)
      .join(' ');
    writeFileSync(
      join(root, 'verification-hooks.json'),
      JSON.stringify({
        hooks: Object.fromEntries(
          ['PreToolUse', 'PostToolUse'].map((name) => [
            name,
            [{ matcher: '^Skill$', hooks: [{ type: 'command', command, timeout: 3 }] }],
          ]),
        ),
      }),
    );
    const before = db
      .prepare(
        "SELECT COUNT(*) AS n FROM skill_usage_events WHERE project_id=? AND version_id=? AND category='native_hook' AND event_type='invoked'",
      )
      .get(scope.id, version.id).n;
    const claude = await runNative(
      'claude',
      claudeArgs(
        `Call the Skill tool with skill "${fixture.name}". Follow its reference link and use Read to inspect its supporting note. Report the exact marker found there. Do not edit files or run commands.`,
        true,
      ),
      root,
    );
    const result = {
      codex,
      claude: { status: 'NOT VERIFIED', ...nativeStatus(claude) },
      version_id: version.id,
      artifact_digest: version.content_hash,
    };
    if (!claude.failure) {
      const notes = join(root, '.claude', 'skills', fixture.name, 'references', 'notes.md');
      try {
        result.claude = {
          ...result.claude,
          ...claudeSkillEvidence(
            claude.events,
            fixture.name,
            notes,
            `CLAMP_${fixture.nonce}_V${revision}`,
          ),
          status: 'REAL CLAUDE VERIFIED',
        };
      } catch {
        result.claude.failure = 'missing_correlated_skill_and_note_evidence';
      }
      const after = db
        .prepare(
          "SELECT COUNT(*) AS n FROM skill_usage_events WHERE project_id=? AND version_id=? AND category='native_hook' AND event_type='invoked'",
        )
        .get(scope.id, version.id).n;
      result.claude.telemetry_observed = after > before;
    }
    const reconciled = new SkillDistributionService(db, scope, home).plan({
      skill_id: version.skill_id,
      target: 'all',
      scope: 'project',
    });
    result.artifact_integrity = reconciled.entries.every((e) => e.action === 'SKIP')
      ? 'FILESYSTEM VERIFIED'
      : 'FAIL';
    fixture.native[`revision_${revision}`] = result;
    saveLearningFixture(fixture);
    return nativeStageComplete(result);
  }
  if (!fixture.native.revision_1) {
    const v1 = await ready(1);
    if (!v1 || !(await installed(v1))) return;
    if (!(await verifyNative(v1, 1))) {
      emit({
        stage: 'native-skill-v1',
        reason: 'Native discovery/invocation/telemetry evidence is incomplete.',
      });
      return;
    }
  }
  // Failed native stages must be retried, not treated as fulfilled merely because a result object exists.
  if (!nativeStageComplete(fixture.native.revision_1)) {
    const v1 = await ready(1);
    if (!v1 || !(await installed(v1)) || !(await verifyNative(v1, 1))) {
      emit({ stage: 'native-skill-v1', reason: 'Native V1 evidence incomplete.' });
      return;
    }
  }
  if (!nativeStageComplete(fixture.native.revision_2)) {
    const v2 = await ready(2);
    if (!v2 || !(await installed(v2))) return;
    if (!(await verifyNative(v2, 2))) {
      emit({ stage: 'native-skill-v2', reason: 'Native V2 evidence incomplete.' });
      return;
    }
    fixture.native.upgrade_verified = true;
    saveLearningFixture(fixture);
  }
  const v1 = store.getVersion(fixture.v1).version;
  if (store.getIdentity(v1.skill_id).active_version_id !== v1.id) {
    pause(
      'rollback',
      [operator('skill-operator', ['--rollback', v1.id])],
      'Operator rollback is required; deployed copies remain unchanged until a separate confirmed sync.',
    );
    return;
  }
  if (!(await installed(v1))) return;
  if (!(await verifyNative(v1, 1))) {
    emit({
      stage: 'native-rollback',
      reason: 'Native rollback synchronization evidence incomplete.',
    });
    return;
  }
  emit(
    {
      stage: 'complete-local-workflow',
      workflow_completed: true,
      overall: 'NOT VERIFIED',
      reason:
        'Standard activation-gap workflow observed. Protected operator/storage separation is not implemented; shared-UID confirmation cannot establish adversarial human-only approval.',
      native: fixture.native,
      release: 'NO-GO for Phase 3',
    },
    1,
  );
}
main()
  .catch(() =>
    emit({
      overall: 'FAIL',
      reason:
        'Verification operation or supported native evidence contract failed. Inspect local registry with trusted read commands; no raw native output is retained.',
    }),
  )
  .finally(() => {
    if (db?.open) db.close();
  });

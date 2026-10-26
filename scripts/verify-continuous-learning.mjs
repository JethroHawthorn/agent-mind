// Opt-in, bounded native capture probe. No approval automation, credential access or installation.
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openDatabase, resolveProject } from '../packages/core/dist/index.js';
import { continuousToolEvidence } from './continuous-evidence.mjs';
import {
  loadContinuousFixture,
  prepareContinuousFixture,
  verifyContinuousTask,
} from './continuous-fixture.mjs';
import { cleanupLearningFixture } from './learning-fixture.mjs';
import { nativeProcess, nativeTimeoutMs } from './native-process.mjs';

const { values: flags } = parseArgs({
  options: {
    prepare: { type: 'boolean' },
    probe: { type: 'boolean' },
    resume: { type: 'string' },
    status: { type: 'boolean' },
    cleanup: { type: 'string' },
    'native-timeout-seconds': { type: 'string' },
  },
  strict: true,
});
process.umask(0o077);
let fixture;
let db;
try {
  if (flags.cleanup) {
    loadContinuousFixture(flags.cleanup);
    cleanupLearningFixture(flags.cleanup);
    console.log(JSON.stringify({ cleaned: true }));
  } else if (flags.status) {
    if (!flags.resume) throw Error('Status requires --resume ROOT.');
    const f = loadContinuousFixture(flags.resume);
    const evidence = join(f.root, 'continuous-native-evidence.json');
    const stat = lstatSync(evidence);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
      throw Error('Unsafe evidence file.');
    console.log(
      JSON.stringify({
        ...JSON.parse(readFileSync(evidence, 'utf8')),
        recorded_evidence_only: true,
      }),
    );
    process.exitCode = 2;
  } else {
    if (!flags.prepare && !flags.probe && !flags.resume)
      throw Error('Choose --prepare, --probe, --resume ROOT [--probe], or --cleanup ROOT.');
    const timeout = nativeTimeoutMs(flags['native-timeout-seconds']);
    fixture = flags.resume ? loadContinuousFixture(flags.resume) : prepareContinuousFixture();
    const root = fixture.root,
      path = join(root, 'registry.db');
    db = openDatabase(path);
    const scope = resolveProject(root, root);
    const server = fileURLToPath(new URL('../packages/mcp-server/dist/index.js', import.meta.url));
    const args = [
      server,
      '--project-root',
      root,
      '--db',
      path,
      '--source-agent',
      'codex',
      '--enable-learning',
      '--enable-authoring',
      '--enable-retrieval',
      '--enable-curator',
    ];
    const report = {
      schema_version: 1,
      overall: 'NOT VERIFIED',
      project: root,
      registry: path,
      project_id: scope.id,
      evidence_level: 'LEVEL_2_NATIVE_ATTEMPT',
      capture: 'EXPLICITLY INSTRUCTED',
      native_capture: 'NOT VERIFIED',
      native_authoring: 'NOT VERIFIED',
      native_reuse: 'NOT VERIFIED',
      human_approval: 'NOT VERIFIED',
      protected_operator: 'NOT VERIFIED',
      claude: 'DEFERRED',
      gemini: 'DEFERRED',
      autonomous_activation: 'NO-GO',
      suite_digest: fixture.continuous.suite_digest,
      tools: [],
      reason: 'PREPARED_ONLY',
      controlled_task: null,
    };
    if (flags.probe && !flags.status) {
      const prompt = `Disposable AgentMind acceptance task. Fix only clamp.ts so both numeric bounds hold, retaining its one-line formatting and signature. Read clamp.test.mjs but do not change tests. Do not run shell commands or execute generated code; the outer harness checks repository-owned tests. Then explicitly record this potential lesson using experience_record (an unknown outcome with a short summary; do not claim tests executed or supply trusted provenance/verification fields), and learning_signal_record referencing that experience. Use short evidence references, not transcripts. Do not approve experiences or skills, create operator grants, modify registry files, install skills or access credentials. Stop after capture. The second task retry-delay.mjs is reserved for later reuse; leave it unchanged.`;
      const result = await nativeProcess(
        'codex',
        [
          'exec',
          '--ephemeral',
          '--ignore-user-config',
          '--skip-git-repo-check',
          '--json',
          '--sandbox',
          'workspace-write',
          '-c',
          `mcp_servers.agentmind.command=${JSON.stringify(process.execPath)}`,
          '-c',
          `mcp_servers.agentmind.args=${JSON.stringify(args)}`,
          prompt,
        ],
        root,
        timeout,
      );
      report.tools = continuousToolEvidence(result);
      report.controlled_task = verifyContinuousTask(root, 'primary');
      report.reason = result.failure ?? 'CAPTURE_REQUIRES_SCOPED_REFERENCE_CHECK';
      Object.assign(report, {
        exit_code: result.exit_code,
        elapsed_ms: result.elapsed_ms,
        timeout_ms: result.timeout_ms,
        progress: result.progress,
      });
      const experience = report.tools.find((t) => t.tool === 'experience_record');
      const signal = report.tools.find((t) => t.tool === 'learning_signal_record');
      const xp =
        experience?.id &&
        db
          .prepare('SELECT id FROM experiences WHERE id = ? AND project_id = ?')
          .get(experience.id, scope.id);
      const sig =
        signal?.id &&
        db
          .prepare('SELECT payload_json FROM learning_signals WHERE id = ? AND project_id = ?')
          .get(signal.id, scope.id);
      if (
        xp &&
        sig &&
        JSON.parse(sig.payload_json).experience_ids?.includes(experience.id) &&
        report.controlled_task.status === 'PASS'
      ) {
        report.native_capture = 'REAL CODEX VERIFIED';
        report.reason =
          'MANUAL_EXPERIENCE_REVIEW_REQUIRED; authoring and reuse remain NOT VERIFIED';
      }
    }
    // Never persist native conversation output, tool arguments, credentials or inferred success.
    const fd = openSync(
      join(root, 'continuous-native-evidence.json'),
      constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw Error('Unsafe evidence file.');
      ftruncateSync(fd, 0);
      writeFileSync(fd, JSON.stringify(report, null, 2));
    } finally {
      closeSync(fd);
    }
    console.log(JSON.stringify(report));
    process.exitCode = flags.prepare && !flags.probe ? 0 : 2;
  }
} catch {
  console.log(
    JSON.stringify({
      overall: 'NOT VERIFIED',
      reason: 'INVALID_FIXTURE_OR_PROBE_FAILURE',
      project: fixture?.root ?? null,
    }),
  );
  process.exitCode = 1;
} finally {
  db?.close();
}

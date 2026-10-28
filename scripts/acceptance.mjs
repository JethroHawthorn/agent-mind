// Trusted repository test orchestration, never a candidate command runner or deployment tool.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  redactSecrets,
  redactSensitiveValue,
  reviewText,
  SCHEMA_VERSION,
} from '../packages/core/dist/index.js';
import {
  acceptanceGates,
  classifySuite,
  POLICY,
  releaseProfiles,
  SCENARIOS,
  suiteFiles,
  UNAVAILABLE,
} from './acceptance/model.mjs';

const repo = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const help = `P6-001 acceptance — offline/version checks only; no native model or privileged deployment
 pnpm acceptance [--repeat 1..3] [--output /canonical/allowed/agentmind-p6-001-NAME] [--keep-work]
 pnpm acceptance --inspect-run /canonical/allowed/agentmind-p6-001-NAME
Outputs must be new directories below canonical OS temp or docs/reviews/p6-001. Default: fresh temp.
All working registries/config/homes are disposable. Results/evidence persist; work is cleaned by default.
Inspects installed CLI --version only using an empty HOME. Never reads/copies authentication or invokes models.
Native/OS/sandbox acceptance remains NOT VERIFIED. Existing optional verifiers require separate authorization.
Exit 0: all requested profiles verified; 2: offline completed with unverified gates; 1: observed failure; 4: arguments/isolation preconditions.
SIGINT/SIGTERM cancel the child process group and record incomplete evidence. SIGKILL leaves a marked run for read-only inspection.
`;
let v;
try {
  ({ values: v } = parseArgs({
    strict: true,
    allowPositionals: false,
    options: {
      help: { type: 'boolean', short: 'h' },
      repeat: { type: 'string', default: '2' },
      output: { type: 'string' },
      'keep-work': { type: 'boolean' },
      'inspect-run': { type: 'string' },
    },
  }));
} catch {
  process.stderr.write(
    'Invalid acceptance arguments; native/model execution flags are not accepted. Use --help.\n',
  );
  process.exit(4);
}
function inside(parent, path) {
  const rel = relative(parent, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function safeDirectory(path) {
  const s = lstatSync(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    realpathSync(path) !== path ||
    (process.getuid && s.uid !== process.getuid()) ||
    s.mode & 0o077
  )
    throw Error('UNSAFE_RUN_DIRECTORY');
  return s;
}
function allowedRun(path) {
  const temp = realpathSync(tmpdir()),
    reports = join(repo, 'docs/reviews/p6-001');
  if (
    !basename(path).startsWith('agentmind-p6-001-') ||
    (!inside(temp, path) && !inside(reports, path))
  )
    throw Error('RUN_OUTSIDE_ALLOWED_ROOT');
}
function rejectAncestorLinks(path) {
  for (let cursor = dirname(path); ; cursor = dirname(cursor)) {
    try {
      const st = lstatSync(cursor);
      if (st.isSymbolicLink() || !st.isDirectory()) throw Error('UNSAFE_ANCESTOR');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (cursor === dirname(cursor)) break;
  }
}
function marker(root) {
  allowedRun(root);
  safeDirectory(root);
  const path = join(root, 'run-marker.json'),
    s = lstatSync(path);
  if (!s.isFile() || s.nlink !== 1 || s.size > 4096) throw Error('UNSAFE_RUN_MARKER');
  const m = JSON.parse(readFileSync(path, 'utf8')),
    d = lstatSync(root);
  if (
    m.kind !== 'agentmind-p6-001-disposable' ||
    m.root_digest !== hash(root) ||
    m.dev !== d.dev ||
    m.ino !== d.ino ||
    !/^[a-f0-9-]{36}$/.test(m.id)
  )
    throw Error('INVALID_RUN_MARKER');
  return m;
}
function sourceSnapshot() {
  const result = {};
  const walk = (path) => {
    for (const ent of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = join(path, ent.name);
      if (ent.isSymbolicLink()) throw Error('LINKED_SOURCE');
      if (ent.isDirectory()) walk(file);
      else if (/\.(?:ts|mjs|md|json|yaml|c|py)$/.test(file))
        result[relative(repo, file)] = hash(readFileSync(file));
    }
  };
  for (const directory of [
    'packages/core/src',
    'packages/mcp-server/src',
    'scripts',
    'tests',
    'skills',
  ])
    walk(join(repo, directory));
  for (const name of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'vitest.config.ts',
    'native/peer.c',
  ])
    result[name] = hash(readFileSync(join(repo, name)));
  return result;
}
let root,
  work,
  aborted = false,
  current;
const cancel = () => {
  aborted = true;
  current?.();
};
async function main() {
  if (v.help) {
    process.stdout.write(help);
    return;
  }
  if (v['inspect-run']) {
    if (v.output || v['keep-work'] || v.repeat !== '2') throw Error('ARGUMENTS');
    const path = resolve(v['inspect-run']);
    marker(path);
    const resultPath = join(
      path,
      existsSync(join(path, 'result.json')) ? 'result.json' : 'progress.json',
    );
    const s = lstatSync(resultPath);
    if (!s.isFile() || s.nlink !== 1 || s.size > 8 * 1024 * 1024) throw Error('INVALID_RESULT');
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    let integrity = false;
    const manifestPath = join(path, 'manifest.json');
    if (existsSync(manifestPath)) {
      const ms = lstatSync(manifestPath);
      if (!ms.isFile() || ms.nlink !== 1 || ms.size > 4 * 1024 * 1024)
        throw Error('INVALID_MANIFEST');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length > 10000)
        throw Error('INVALID_MANIFEST');
      integrity =
        manifest.run_id === result.run_id &&
        manifest.artifacts.some((item) => item.path === 'result.json') &&
        manifest.artifacts.some((item) => item.path === 'run-marker.json') &&
        manifest.artifacts.every((item) => {
          if (
            typeof item.path !== 'string' ||
            isAbsolute(item.path) ||
            !inside(path, resolve(path, item.path))
          )
            return false;
          const file = resolve(path, item.path),
            st = lstatSync(file);
          return (
            st.isFile() &&
            st.nlink === 1 &&
            realpathSync(file) === file &&
            st.size <= 32 * 1024 * 1024 &&
            hash(readFileSync(file)) === item.sha256
          );
        });
    }
    const gates = acceptanceGates(Array.isArray(result.scenarios) ? result.scenarios : []);

    process.stdout.write(
      `${reviewText({ inspection_only: true, not_authentication: true, complete: existsSync(join(path, 'result.json')), run_id: result.run_id, status: result.status ?? 'NOT VERIFIED', phase: result.phase ?? 'INTERRUPTED', profiles: releaseProfiles(gates), checksum_integrity: integrity })}\n`,
    );
    process.exitCode =
      existsSync(join(path, 'result.json')) &&
      integrity &&
      result.status === 'PASS' &&
      gates.J.status === 'PASS'
        ? 0
        : 2;
    return;
  }
  if (!/^[1-3]$/.test(v.repeat)) throw Error('ARGUMENTS');
  process.umask(0o077);
  const temp = realpathSync(tmpdir()),
    reports = join(repo, 'docs/reviews/p6-001');
  if (v.output) {
    const output = resolve(v.output);
    if (
      output !== v.output ||
      !basename(output).startsWith('agentmind-p6-001-') ||
      existsSync(output)
    )
      throw Error('OUTPUT_MUST_BE_NEW');
    if (!inside(temp, output) && !inside(reports, output))
      throw Error('OUTPUT_OUTSIDE_ALLOWED_ROOT');
    // Create only the fixed repository report ancestry; never user-selected config paths.
    rejectAncestorLinks(output);
    if (inside(reports, output)) mkdirSync(reports, { recursive: true, mode: 0o700 });
    if (realpathSync(dirname(output)) !== dirname(output)) throw Error('LINKED_OUTPUT_PARENT');
    mkdirSync(output, { mode: 0o700 });
    root = output;
  } else root = realpathSync(mkdtempSync(join(temp, 'agentmind-p6-001-')));
  const identity = safeDirectory(root),
    runId = randomUUID();
  writeFileSync(
    join(root, 'run-marker.json'),
    JSON.stringify({
      kind: 'agentmind-p6-001-disposable',
      id: runId,
      root_digest: hash(root),
      dev: identity.dev,
      ino: identity.ino,
    }),
    { flag: 'wx', mode: 0o600 },
  );
  // Reports may live inside this repository; projects must not inherit its Git root.
  work = realpathSync(mkdtempSync(join(temp, `agentmind-p6-work-${runId}-`)));
  safeDirectory(work);
  const workId = lstatSync(work),
    evidence = join(root, 'evidence');
  mkdirSync(evidence, { mode: 0o700 });
  for (const name of ['home', 'tmp', 'xdg', 'codex', 'claude', 'cache'])
    mkdirSync(join(work, name), { mode: 0o700 });
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: join(work, 'home'),
    TMPDIR: join(work, 'tmp'),
    TMP: join(work, 'tmp'),
    TEMP: join(work, 'tmp'),
    XDG_CONFIG_HOME: join(work, 'xdg'),
    XDG_CACHE_HOME: join(work, 'cache'),
    CODEX_HOME: join(work, 'codex'),
    CLAUDE_CONFIG_DIR: join(work, 'claude'),
    NO_COLOR: '1',
    CI: '1',
    LANG: 'C.UTF-8',
    TZ: 'UTC',
    pnpm_config_verify_deps_before_run: 'false',
    AGENTMIND_P6_001_ARTIFACTS: evidence,
    AGENTMIND_WRITE_REVIEW_ARTIFACTS: '1',
    AGENTMIND_REVIEW_ARTIFACT_DIR: evidence,
    AGENTMIND_DATABASE_BENCHMARK_OUTPUT: join(evidence, 'database-performance.json'),
  };
  const scrub = (value) => {
    // Sanitize each trusted test assertion independently so the privacy walker budget
    // cannot silently discard later suites from a large structured test report.
    if (value && typeof value === 'object' && Array.isArray(value.testResults)) {
      return {
        ...scrub({ ...value, testResults: undefined }),
        testResults: value.testResults.map((suite) => ({
          ...scrub({ ...suite, assertionResults: undefined }),
          assertionResults: Array.isArray(suite.assertionResults)
            ? suite.assertionResults.map(scrub)
            : [],
        })),
      };
    }
    const visit = (x) =>
      typeof x === 'string'
        ? redactSecrets(x)
            .split(work)
            .join('<work>')
            .split(root)
            .join('<run>')
            .split(repo)
            .join('<repo>')
            .split(homedir())
            .join('<home>')
        : Array.isArray(x)
          ? x.map(visit)
          : x && typeof x === 'object'
            ? Object.fromEntries(Object.entries(x).map(([k, val]) => [k, visit(val)]))
            : x;
    return visit(redactSensitiveValue(value));
  };
  const write = (name, value) => {
    marker(root);
    const tmp = join(root, `${name}.partial`);
    writeFileSync(tmp, `${JSON.stringify(scrub(value), null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, join(root, name));
  };
  const started = new Date().toISOString(),
    source = sourceSnapshot(),
    commands = [],
    results = [];
  const state = {
    schema_version: 1,
    policy: POLICY,
    run_id: runId,
    started_at: started,
    status: 'NOT VERIFIED',
    phase: 'RUNNING',
    model_authorization: 'OFFLINE_AND_VERSION_CHECKS_ONLY',
    commands,
    scenarios: results,
    source_sha256: source,
    fixture: {
      root: '<work>',
      temporary_workspace_name: basename(work),
      data: 'synthetic only',
      credential_material: 'none copied or inspected',
      approval: 'synthetic test fixture authority only',
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      schema: SCHEMA_VERSION,
      package_manager: 'pnpm 11.6.0 repository contract',
      environment_keys: Object.keys(env).sort(),
    },
    native: {},
  };
  write('progress.json', state);
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  async function execute(id, command, args, timeout = 600000) {
    if (aborted) return { exit_code: null, reason: 'CANCELLED', elapsed_ms: 0 };
    const start = performance.now();
    let out = '',
      err = '',
      bytes = 0,
      reason = null;
    const child = spawn(command, args, {
      cwd: repo,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stop = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
    };
    current = () => {
      reason = 'CANCELLED';
      stop();
    };
    const timer = setTimeout(() => {
      reason = 'TIMEOUT';
      stop();
    }, timeout);
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) {
        reason = 'OUTPUT_LIMIT';
        stop();
      } else out += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      if (err.length < 65536) err += chunk.toString().slice(0, 65536 - err.length);
    });
    child.once('error', () => {
      reason = 'EXECUTABLE_UNAVAILABLE';
    });
    const observed = await new Promise((done) =>
      child.once('close', (code, signal) => done({ exit_code: code, signal })),
    );
    clearTimeout(timer);
    stop();
    current = undefined;
    const record = {
      id,
      command: command === process.execPath ? '<node>' : command,
      args,
      exit_code: observed.exit_code,
      signal: observed.signal,
      reason,
      elapsed_ms: performance.now() - start,
      log: `evidence/${id}.log`,
      classification: 'HOST_OBSERVED_PROCESS_EXIT',
    };
    writeFileSync(join(evidence, `${id}.log`), String(scrub(`${out}\n${err}`)), { mode: 0o600 });
    commands.push(record);
    write('progress.json', state);
    return { ...record, stdout: out };
  }
  try {
    for (const provider of ['codex', 'claude', 'gemini']) {
      let executable = null;
      for (const part of env.PATH.split(sep === '\\' ? ';' : ':')) {
        if (!part || !isAbsolute(part)) continue;
        const candidate = join(part, provider);
        try {
          accessSync(candidate, constants.X_OK);
          if (lstatSync(realpathSync(candidate)).isFile()) {
            executable = candidate;
            break;
          }
        } catch {}
      }
      const detection = {
        installed: !!executable,
        executable: executable ? scrub(executable) : null,
        version: null,
        version_check: 'NOT VERIFIED',
        compatibility: 'NOT VERIFIED',
        authentication: 'NOT VERIFIED_NOT_INSPECTED',
        levels: {
          executable: executable ? 'PASS' : 'NOT VERIFIED',
          compatible_version: 'NOT VERIFIED',
          mcp_registered: 'NOT VERIFIED',
          generic_mcp: 'NOT VERIFIED',
          native_discovery: 'NOT VERIFIED',
          native_invocation: 'NOT VERIFIED',
          router_discovery: 'NOT VERIFIED',
          router_selection: 'NOT VERIFIED',
          memory_retrieved: 'NOT VERIFIED',
          skill_retrieved: 'NOT VERIFIED',
          independent_native_task: 'NOT VERIFIED',
          learning: 'NOT VERIFIED',
          cross_agent_reuse: 'NOT VERIFIED',
        },
      };
      if (executable) {
        const run = await execute(`version-${provider}`, executable, ['--version'], 15000);
        const match = run.stdout?.match(/\b\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\b/);
        if (run.exit_code === 0 && match) {
          detection.version = match[0];
          detection.version_check = 'PASS';
        }
      }
      state.native[provider] = detection;
    }
    for (let attempt = 1; attempt <= Number(v.repeat) && !aborted; attempt++) {
      const attemptDir = join(evidence, `attempt-${attempt}`);
      mkdirSync(attemptDir, { mode: 0o700 });
      env.AGENTMIND_P6_001_ARTIFACTS = attemptDir;
      env.AGENTMIND_REVIEW_ARTIFACT_DIR = attemptDir;
      const traces = join(attemptDir, 'continuous');
      mkdirSync(traces, { mode: 0o700 });
      env.AGENTMIND_P3_007_OUTPUT = traces;
      const reportPath = join(evidence, `vitest-${attempt}.json`);
      const args = [
        join(repo, 'node_modules/vitest/vitest.mjs'),
        'run',
        ...suiteFiles(),
        '--maxWorkers=2',
        '--reporter=json',
        `--outputFile=${reportPath}`,
      ];
      const observed = await execute(`offline-${attempt}`, process.execPath, args);
      let report = null;
      try {
        const st = lstatSync(reportPath);
        if (!st.isFile() || st.nlink !== 1 || st.size > 16 * 1024 * 1024) throw Error();
        report = JSON.parse(readFileSync(reportPath, 'utf8'));
      } catch {}
      for (const spec of SCENARIOS) {
        const verdict = classifySuite(report, observed.exit_code, spec.files);
        results.push({
          ...spec,
          attempt,
          ...verdict,
          preconditions: [
            'trusted repository test suite',
            'fresh disposable fixture state',
            'no models or protected deployment',
          ],
          command_id: observed.id,
          expected: 'All named trusted assertions pass without omitted suites.',
          actual: verdict.reason,
          exit_code: observed.exit_code,
          artifacts: [`evidence/vitest-${attempt}.json`, `evidence/offline-${attempt}.log`],
          environment: state.environment,
        });
      }
      if (report)
        writeFileSync(reportPath, `${JSON.stringify(scrub(report), null, 2)}\n`, { mode: 0o600 });
      const metricsPath = join(attemptDir, 'retrieval-quality.json');
      let metrics = null;
      try {
        metrics = JSON.parse(readFileSync(metricsPath, 'utf8'));
      } catch {}
      const measured = metrics?.metrics;
      const scoreValid =
        measured?.queries === 31 &&
        measured?.no_match_total === 7 &&
        Number.isInteger(measured?.no_match_correct);
      results.push({
        id: 'P6-E-NO-MATCH',
        attempt,
        profile: 'A',
        requirement:
          'Return no candidates for every no-relevant-skill query in the fixed labeled corpus.',
        classification: 'HOST_OBSERVED_LABELED_RETRIEVAL_NOT_MODEL_SELECTION',
        boundary: 'advisory retrieval quality, not authorization',
        status: scoreValid
          ? measured.no_match_correct === measured.no_match_total
            ? 'PASS'
            : 'FAIL'
          : 'NOT VERIFIED',
        expected: '7/7 labeled no-match tasks return no candidates.',
        actual: scoreValid
          ? `${measured.no_match_correct}/${measured.no_match_total}`
          : 'METRICS_UNAVAILABLE',
        exit_code: observed.exit_code,
        artifacts: [`evidence/attempt-${attempt}/retrieval-quality.json`],
        finding:
          scoreValid && measured.no_match_correct !== measured.no_match_total ? 'P6-001-R01' : null,
      });
      const smoke = await execute(
        `smoke-${attempt}`,
        process.execPath,
        ['scripts/smoke.mjs'],
        60000,
      );
      results.push({
        id: 'P6-B-SMOKE',
        attempt,
        profile: 'A',
        requirement:
          'Actual SDK/server process persistence and authorized memory sharing; not native model use.',
        classification: 'GENERIC_MCP_HOST_OBSERVED',
        boundary: 'project / stdio / SQLite',
        command_id: smoke.id,
        status: smoke.exit_code === 0 ? 'PASS' : 'FAIL',
        exit_code: smoke.exit_code,
        actual: smoke.reason ?? 'HOST_PROCESS_EXIT',
        artifacts: [smoke.log],
      });
      write('progress.json', state);
    }
    // Qualification only: fixed no-authorization commands never provision or execute canaries.
    const os = await execute(
      'os-qualification',
      process.execPath,
      ['scripts/verify-broker-os.mjs'],
      15000,
    );
    const sandbox = await execute(
      'sandbox-qualification',
      process.execPath,
      ['scripts/verify-behavioral-isolation.mjs'],
      15000,
    );
    for (const spec of UNAVAILABLE)
      results.push({
        ...spec,
        status: 'NOT VERIFIED',
        attempt: null,
        classification: 'NO_REQUIRED_EXECUTION_EVIDENCE',
        boundary:
          spec.profile === 'D'
            ? 'OS_OPERATOR'
            : spec.profile === 'E'
              ? 'SANDBOX'
              : spec.profile === 'B'
                ? 'NATIVE_CLI'
                : 'REQUIRED_DEPLOYMENT_OR_NATIVE',
        command_id: spec.profile === 'D' ? os.id : spec.profile === 'E' ? sandbox.id : null,
        exit_code:
          spec.profile === 'D' ? os.exit_code : spec.profile === 'E' ? sandbox.exit_code : null,
        actual: spec.reason,
        artifacts: spec.profile === 'D' ? [os.log] : spec.profile === 'E' ? [sandbox.log] : [],
      });
    // Collect only known synthetic benchmark files from this run's isolated TMPDIR.
    for (const name of readdirSync(env.TMPDIR).filter((n) =>
      /^agentmind-(?:p4-|p5004-).*\.json$/.test(n),
    )) {
      const path = join(env.TMPDIR, name),
        st = lstatSync(path);
      if (st.isFile() && st.nlink === 1 && st.size <= 8 * 1024 * 1024)
        try {
          writeFileSync(
            join(evidence, name),
            `${JSON.stringify(scrub(JSON.parse(readFileSync(path, 'utf8'))), null, 2)}\n`,
            { mode: 0o600 },
          );
        } catch {}
    }
    state.gates = acceptanceGates(results);
    state.profiles = releaseProfiles(state.gates);
    state.source_changed = JSON.stringify(source) !== JSON.stringify(sourceSnapshot());
    state.status =
      aborted || state.source_changed || results.some((s) => s.status === 'FAIL')
        ? 'FAIL'
        : 'NOT VERIFIED';
    state.phase = aborted ? 'CANCELLED' : 'COMPLETE';
    state.finished_at = new Date().toISOString();
  } catch {
    state.status = 'FAIL';
    state.phase = 'HARNESS_ERROR';
    state.reason = 'ISOLATION_EXECUTION_OR_EVIDENCE_FAILURE';
  } finally {
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
    state.cleanup = 'KEPT_EXPLICITLY';
    if (!v['keep-work'])
      try {
        marker(root);
        const now = lstatSync(work);
        if (
          now.dev !== workId.dev ||
          now.ino !== workId.ino ||
          now.isSymbolicLink() ||
          realpathSync(work) !== work
        ) {
          state.status = 'FAIL';
          state.cleanup = 'REFUSED_CHANGED_WORK_IDENTITY';
        } else {
          rmSync(work, { recursive: true, force: true });
          state.cleanup = 'WORK_REMOVED_EVIDENCE_RETAINED';
        }
      } catch {
        state.status = 'FAIL';
        state.cleanup = 'REFUSED_CHANGED_WORK_IDENTITY';
      }
    write('result.json', state);
    const sanitizeEvidence = (path) => {
      for (const ent of readdirSync(path, { withFileTypes: true })) {
        const file = join(path, ent.name);
        if (ent.isDirectory()) sanitizeEvidence(file);
        else if (
          ent.isFile() &&
          ent.name.endsWith('.json') &&
          lstatSync(file).size <= 16 * 1024 * 1024
        )
          try {
            writeFileSync(
              file,
              `${JSON.stringify(scrub(JSON.parse(readFileSync(file, 'utf8'))), null, 2)}\n`,
              { mode: 0o600 },
            );
          } catch {}
      }
    };
    sanitizeEvidence(evidence);
    const artifacts = [];
    const scan = (path) => {
      for (const ent of readdirSync(path, { withFileTypes: true })) {
        const file = join(path, ent.name);
        if (ent.isDirectory()) scan(file);
        else if (ent.isFile() && ent.name !== 'manifest.json')
          artifacts.push({
            path: relative(root, file),
            bytes: lstatSync(file).size,
            sha256: hash(readFileSync(file)),
          });
      }
    };
    scan(root);
    write('manifest.json', {
      schema_version: 1,
      run_id: runId,
      policy: POLICY,
      artifacts: artifacts.sort((a, b) => a.path.localeCompare(b.path)),
      integrity: 'SHA256_CHECKSUMS_NOT_SIGNATURES_OR_OS_ATTESTATION',
      test_authority:
        'Trusted repository tests + parent-observed process exits; untrusted stdout cannot select profiles or verdicts.',
    });
  }
  process.stdout.write(
    `${reviewText({ run_id: runId, output: root, status: state.status, phase: state.phase, scenarios: Object.fromEntries(['PASS', 'FAIL', 'NOT VERIFIED', 'NOT APPLICABLE'].map((status) => [status, results.filter((s) => s.status === status).length])), gates: state.gates, profiles: state.profiles, cleanup: state.cleanup })}\n`,
  );
  process.exitCode = state.status === 'FAIL' ? 1 : 2;
}
main().catch(() => {
  process.stderr.write(
    'Acceptance refused: invalid arguments, unsafe output or missing build. Use --help; no live environment is an accepted target.\n',
  );
  process.exitCode = 4;
});

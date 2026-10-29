// Artifact-first offline RC inspection. No provider authentication, model or privileged deployment.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

const repository = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const hash = (b) => createHash('sha256').update(b).digest('hex');
const fail = (code) => {
  throw Error(code);
};
export function inspectArtifact(bytes, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected) || hash(bytes) !== expected) fail('RC_DIGEST_MISMATCH');
  if (bytes.length > 64 * 1024 * 1024) fail('RC_ARCHIVE_BUDGET');
  const tar = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
  const entries = new Map();
  let at = 0,
    terminated = false;
  const string = (b) => {
    const i = b.indexOf(0);
    const body = i < 0 ? b : b.subarray(0, i);
    const s = body.toString('utf8');
    if (!Buffer.from(s).equals(body)) fail('RC_UTF8');
    return s;
  };
  const octal = (b) => {
    const s = string(b).trim();
    if (!/^[0-7]+$/.test(s)) fail('RC_TAR_NUMBER');
    return Number.parseInt(s, 8);
  };
  while (at + 512 <= tar.length) {
    const h = tar.subarray(at, at + 512);
    at += 512;
    if (h.every((b) => b === 0)) {
      if (tar.length - at < 512 || !tar.subarray(at).every((b) => b === 0)) fail('RC_TAR_TRAILING');
      terminated = true;
      break;
    }
    if (entries.size >= 10001) fail('RC_FILE_COUNT');
    const checksum = octal(h.subarray(148, 156)),
      copy = Buffer.from(h);
    copy.fill(32, 148, 156);
    if (
      copy.reduce((s, b) => s + b, 0) !== checksum ||
      string(h.subarray(257, 263)) !== 'ustar' ||
      h[156] !== 48
    )
      fail('RC_TAR_HEADER');
    const prefix = string(h.subarray(345, 500)),
      leaf = string(h.subarray(0, 100)),
      path = prefix ? `${prefix}/${leaf}` : leaf;
    if (
      path.includes('\\') ||
      [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === ':') ||
      path.startsWith('/') ||
      path.split('/').some((p) => !p || p === '.' || p === '..') ||
      entries.has(path)
    )
      fail('RC_PATH_OR_DUPLICATE');
    const mode = octal(h.subarray(100, 108)),
      size = octal(h.subarray(124, 136));
    if (
      mode !== 0o644 ||
      octal(h.subarray(108, 116)) !== 0 ||
      octal(h.subarray(116, 124)) !== 0 ||
      octal(h.subarray(136, 148)) !== 0 ||
      size > 8 * 1024 * 1024 ||
      at + size > tar.length
    )
      fail('RC_CONTENT_HEADER');
    if (!tar.subarray(at + size, at + Math.ceil(size / 512) * 512).every((b) => b === 0))
      fail('RC_TAR_PADDING');
    entries.set(path, Buffer.from(tar.subarray(at, at + size)));
    at += Math.ceil(size / 512) * 512;
  }
  if (!terminated) fail('RC_TAR_INCOMPLETE');
  const manifests = [...entries.keys()].filter((p) => /^[^/]+\/RELEASE-MANIFEST.json$/.test(p));
  if (manifests.length !== 1) fail('RC_MANIFEST');
  const manifest = JSON.parse(entries.get(manifests[0]).toString('utf8'));
  if (
    manifest.schema_version !== 1 ||
    manifest.artifact_type !== 'SOURCE_WORKSPACE_RC' ||
    !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version) ||
    !Array.isArray(manifest.files)
  )
    fail('RC_MANIFEST_FORMAT');
  const root = `agentmind-${manifest.version}/`,
    seen = new Set(),
    identity = [];
  for (const row of manifest.files) {
    if (typeof row.path !== 'string' || seen.has(row.path) || !/^[a-f0-9]{64}$/.test(row.sha256))
      fail('RC_MANIFEST_ENTRY');
    const value = entries.get(root + row.path);
    if (!value || value.length !== row.bytes || hash(value) !== row.sha256)
      fail('RC_FILE_INTEGRITY');
    seen.add(row.path);
    identity.push({ path: row.path, sha256: row.sha256 });
  }
  if (
    entries.size !== seen.size + 1 ||
    manifests[0] !== `${root}RELEASE-MANIFEST.json` ||
    manifest.file_count !== seen.size ||
    hash(JSON.stringify(identity)) !== manifest.source_identity
  )
    fail('RC_MANIFEST_IDENTITY');
  for (const p of entries.keys())
    if (
      !p.startsWith(root) ||
      /(^|\/)(node_modules|dist|\.git|\.env[^/]*)(\/|$)|\.(db|sqlite|pem|key|log)$/.test(p)
    )
      fail('RC_UNEXPECTED_PAYLOAD');
  return { manifest, entries, root, sha256: expected };
}
export function extractVerified(artifact, destination) {
  if (existsSync(destination) || realpathSync(dirname(destination)) !== dirname(destination))
    fail('RC_EXTRACTION_TARGET');
  mkdirSync(destination, { mode: 0o700 });
  for (const [path, bytes] of artifact.entries) {
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
  }
  return join(destination, artifact.root.slice(0, -1));
}
export function auditDependencyTree(root) {
  const base = realpathSync(root);
  let files = 0,
    links = 0;
  const native = [];
  const walk = (path) => {
    for (const e of readdirSync(path, { withFileTypes: true })) {
      const p = join(path, e.name),
        st = lstatSync(p);
      if (st.isSymbolicLink()) {
        links++;
        const target = realpathSync(p);
        if (target !== base && !target.startsWith(base + sep)) fail('RC_EXTERNAL_DEPENDENCY_LINK');
      } else if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        files++;
        if (p.endsWith('.node'))
          native.push({ path: relative(base, p), sha256: hash(readFileSync(p)) });
      } else fail('RC_DEPENDENCY_SPECIAL_FILE');
    }
  };
  walk(base);
  return {
    files,
    links,
    native,
    external_links: 0,
    method:
      'Physical copy with all link targets confined to isolated artifact root; cached modules/binaries are reused, not independently provisioned.',
  };
}
export function tool(name) {
  for (const dir of (process.env.PATH ?? '').split(':').filter(Boolean)) {
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      return resolve(p);
    } catch {
      /* continue PATH inspection only */
    }
  }
  fail('RC_TOOL_MISSING');
}
export function validateRC(options) {
  const input = realpathSync(options.artifact),
    artifact = inspectArtifact(readFileSync(input), options.sha256);
  const work = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'agentmind-p6-004-'))),
    logs = join(work, 'evidence');
  mkdirSync(logs, { mode: 0o700 });
  const home = join(work, 'home');
  mkdirSync(home, { mode: 0o700 });
  const source = extractVerified(artifact, join(work, 'source'));
  const pnpm = tool('pnpm');
  const env = {
    PATH: `${dirname(process.execPath)}:${dirname(pnpm)}:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: work,
    CI: '1',
    NO_COLOR: '1',
    LANG: 'C',
    NPM_CONFIG_USERCONFIG: join(home, 'absent.npmrc'),
    NPM_CONFIG_GLOBALCONFIG: join(home, 'absent-global.npmrc'),
    PNPM_HOME: join(home, 'pnpm'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_CACHE_HOME: join(home, 'cache'),
    CODEX_HOME: join(home, 'codex'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    GEMINI_CLI_HOME: home,
  };
  const commands = [];
  const run = (id, command, args, timeout = 120000) => {
    const start = performance.now(),
      r = spawnSync(command, args, {
        cwd: source,
        env,
        encoding: 'utf8',
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        detached: true,
      });
    if (r.error?.code === 'ETIMEDOUT' && r.pid) {
      try {
        process.kill(-r.pid, 'SIGKILL');
      } catch {
        /* already stopped */
      }
    }
    const log = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
      .replaceAll(work, '<RC_WORK>')
      .replaceAll(repository, '<SOURCE_REPO>');
    writeFileSync(join(logs, `${id}.log`), log, { mode: 0o600 });
    const item = {
      id,
      argv: [command, ...args].map((s) => s.replaceAll(work, '<RC_WORK>')),
      cwd: '<RC_ARTIFACT>',
      exit_code: r.status,
      signal: r.signal,
      error_code: r.error?.code ?? null,
      elapsed_ms: performance.now() - start,
      log: `evidence/${id}.log`,
    };
    commands.push(item);
    return r;
  };
  let completed = false;
  const report = {
    schema_version: 1,
    artifact_sha256: artifact.sha256,
    source_identity: artifact.manifest.source_identity,
    version: artifact.manifest.version,
    verification_level: 'L2_ARTIFACT_DISPOSABLE_HOME_COPIED_DEPENDENCIES',
    clean_machine: 'NOT_VERIFIED',
    release_approved: false,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      node_executable_sha256: hash(readFileSync(process.execPath)),
      pnpm_executable_sha256: hash(readFileSync(pnpm)),
      toolchain: 'EXPLICIT_HOST_NODE_AND_PNPM_NOT_A_CLEAN_OS_IMAGE',
    },
    commands,
    dependency_installation: 'NOT_RUN',
    dependency_audit: null,
    independent_snapshot_rebuild: null,
    selected_suites: [],
    native_models: 'NOT_VERIFIED_NOT_AUTHORIZED',
    protected_operator: 'NOT_VERIFIED',
    sandbox_isolation: 'NOT_VERIFIED',
  };
  const save = () =>
    writeFileSync(join(work, 'results.json'), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
  try {
    const fresh = run(
      'fresh-offline-install',
      pnpm,
      ['install', '--offline', '--frozen-lockfile', '--store-dir', join(work, 'empty-store')],
      30000,
    );
    report.dependency_installation =
      fresh.status === 0
        ? 'FRESH_OFFLINE_INSTALL_COMPLETED_L2'
        : 'BLOCKED_OFFLINE_STORE_MISS_OR_ENVIRONMENT';
    if (fresh.status !== 0) {
      if (existsSync(join(source, 'node_modules')))
        rmSync(join(source, 'node_modules'), { recursive: true, force: true });
      // Existing dependency cache is explicit; never symlink to developer source/dependencies.
      for (const rel of [
        'node_modules',
        'packages/core/node_modules',
        'packages/mcp-server/node_modules',
      ]) {
        const target = join(source, rel);
        if (existsSync(target)) rmSync(target, { recursive: true, force: true });
        cpSync(join(repository, rel), target, { recursive: true, verbatimSymlinks: true });
      }
    }
    if (fresh.status === 0)
      report.verification_level = 'L2_ARTIFACT_FRESH_OFFLINE_DEPENDENCIES_NOT_CLEAN_OS';
    // pnpm's copied shell shims/metadata embed the original absolute NODE_PATH.
    // Rebase only those generated text files; never alter library source/native bytes.
    const rebased = [];
    const rebase = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) rebase(p);
        else if (e.isFile() && (dir.endsWith(`${sep}.bin`) || e.name === '.modules.yaml')) {
          const text = readFileSync(p, 'utf8');
          if (text.includes(repository)) {
            writeFileSync(p, text.replaceAll(repository, source));
            rebased.push(relative(source, p));
          }
        }
      }
    };
    rebase(join(source, 'node_modules'));
    for (const pkg of ['core', 'mcp-server']) rebase(join(source, 'packages', pkg, 'node_modules'));
    report.rebased_generated_dependency_metadata = rebased;
    report.dependency_audit = auditDependencyTree(source);
    save();
    if (run('artifact-build', pnpm, ['build']).status !== 0) fail('RC_BUILD_FAILED');
    if (run('artifact-docs', process.execPath, ['scripts/docs-check.mjs']).status !== 0)
      fail('RC_DOCS_FAILED');
    if (run('artifact-contract', process.execPath, ['scripts/architecture.mjs']).status !== 0)
      fail('RC_CONTRACT_FAILED');
    const rebuilt = join(work, 'independent-snapshot.tar.gz');
    if (
      run('independent-snapshot-rebuild', process.execPath, [
        'scripts/release.mjs',
        'build',
        '--output',
        rebuilt,
      ]).status !== 0
    )
      fail('RC_REBUILD_FAILED');
    report.independent_snapshot_rebuild = {
      sha256: hash(readFileSync(rebuilt)),
      matches: hash(readFileSync(rebuilt)) === artifact.sha256,
      level: 'L2_EXTRACTED_SOURCE_SNAPSHOT_SAME_HOST_TOOLCHAIN_NOT_CLEAN_CHECKOUT',
    };
    if (!report.independent_snapshot_rebuild.matches) fail('RC_REBUILD_DIFFERENCE');
    if (run('artifact-smoke', process.execPath, ['scripts/smoke.mjs']).status !== 0)
      fail('RC_SMOKE_FAILED');
    const suites = {
      core: [
        'tests/integration/mcp.test.ts',
        'tests/integration/experience-mcp.test.ts',
        'tests/integration/continuous-learning.test.ts',
        'tests/unit/authoring.test.ts',
        'tests/integration/authoring.test.ts',
        'tests/integration/learning-review.test.ts',
        'tests/acceptance/release-workflow.test.ts',
      ],
      retrieval: [
        'tests/unit/hybrid.test.ts',
        'tests/unit/hybrid-selection.test.ts',
        'tests/unit/routing-quality.test.ts',
        'tests/integration/retrieval.test.ts',
        'tests/unit/routing.test.ts',
      ],
      installation: ['tests/unit/installer.test.ts', 'tests/integration/installer.test.ts'],
      storage: [
        'tests/unit/database-reliability.test.ts',
        'tests/integration/database-reliability.test.ts',
        'tests/integration/database-cli.test.ts',
        'tests/unit/gemini-migration.test.ts',
      ],
      security: [
        'tests/integration/privacy-boundaries.test.ts',
        'tests/unit/privacy-hardening.test.ts',
        'tests/unit/behavioral-no-execution.test.ts',
        'tests/unit/sandbox-assurance.test.ts',
        'tests/unit/architecture.test.ts',
        'tests/integration/architecture-boundary.test.ts',
      ],
      distribution: [
        'tests/unit/distribution-reliability.test.ts',
        'tests/integration/distribution-reliability.test.ts',
        'tests/integration/skill-distribution.test.ts',
      ],
    };
    for (const [id, files] of Object.entries(suites)) {
      const output = join(logs, `${id}.json`),
        r = run(
          `artifact-${id}`,
          process.execPath,
          [
            'node_modules/vitest/vitest.mjs',
            'run',
            ...files,
            '--maxWorkers=2',
            '--reporter=json',
            `--outputFile=${output}`,
          ],
          240000,
        );
      let totals = null;
      try {
        const j = JSON.parse(readFileSync(output, 'utf8'));
        totals = {
          passed: j.numPassedTests,
          failed: j.numFailedTests,
          skipped: j.numPendingTests,
          total: j.numTotalTests,
        };
        writeFileSync(output, JSON.stringify(j).replaceAll(work, '<RC_WORK>'), { mode: 0o600 });
      } catch {
        /* Missing report never becomes success. */
      }
      report.selected_suites.push({
        id,
        exit_code: r.status,
        totals,
        classification:
          'ARTIFACT_SOURCE_TESTS_WITH_COPIED_DEPENDENCIES_FIXTURE_AUTHORITY_NOT_NATIVE_OS_OR_SANDBOX',
      });
      save();
    }
    completed = true;
    return { work, report };
  } finally {
    report.completed = completed;
    save();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({
      strict: true,
      allowPositionals: true,
      options: {
        artifact: { type: 'string' },
        sha256: { type: 'string' },
        run: { type: 'boolean' },
      },
    });
    if (positionals.length || !values.artifact || !values.sha256) fail('RC_ARGUMENTS');
    if (values.run) {
      const r = validateRC(values);
      console.log(JSON.stringify({ work: r.work, report: r.report }, null, 2));
      process.exitCode = r.report.selected_suites.some((s) => s.exit_code !== 0) ? 1 : 2;
    } else {
      const a = inspectArtifact(readFileSync(values.artifact), values.sha256);
      console.log(
        JSON.stringify(
          {
            sha256: a.sha256,
            manifest: a.manifest,
            verification_level: 'ARTIFACT_BYTES_ONLY',
            license_present: [...a.entries.keys()].some((p) => /\/(LICENSE|COPYING)(\.|$)/.test(p)),
            release_approved: false,
          },
          null,
          2,
        ),
      );
    }
  } catch (error) {
    console.error(
      `RC validation refused: ${/^[A-Z][A-Z0-9_]+$/.test(error.message ?? '') ? error.message : 'RC_INPUT_OR_ENVIRONMENT_FAILURE'}. No native model, privileged deployment or release authorized.`,
    );
    process.exitCode = 1;
  }
}

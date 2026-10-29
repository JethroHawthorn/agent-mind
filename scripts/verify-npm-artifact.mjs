// Developer-only pack/normalization/install verification; publish is always an explicit dry-run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = realpathSync(mkdtempSync(join(tmpdir(), 'agentmind-npm-remediation-')));
for (const path of ['home', 'cache', 'prefix', 'project', 'unpacked'])
  mkdirSync(join(work, path), { mode: 0o700 });
const env = {
  PATH: process.env.PATH,
  HOME: join(work, 'home'),
  LANG: 'C',
  NO_COLOR: '1',
  npm_config_cache: join(work, 'cache'),
  npm_config_prefix: join(work, 'prefix'),
  npm_config_userconfig: join(work, 'empty.npmrc'),
  npm_config_globalconfig: join(work, 'empty-global.npmrc'),
};
writeFileSync(env.npm_config_userconfig, '');
writeFileSync(env.npm_config_globalconfig, '');
const commands = [];
function run(command, args, options = {}) {
  const r = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  commands.push({
    command,
    args,
    cwd: options.cwd ?? root,
    exit_code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    error: r.error?.code,
  });
  writeFileSync(join(work, 'commands.json'), JSON.stringify(commands, null, 2));
  assert.equal(r.status, 0, `${command} failed: ${r.error?.code ?? r.stderr}`);
  return r.stdout;
}
try {
  const npmVersion = run('npm', ['--version']).trim();
  const npmPath = (process.env.PATH ?? '')
    .split(delimiter)
    .map((dir) => join(dir, 'npm'))
    .find((p) => {
      try {
        accessSync(p, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  assert(npmPath);
  const npmRoot = dirname(dirname(realpathSync(npmPath)));
  const require = createRequire(import.meta.url),
    PackageJson = require(join(npmRoot, 'node_modules/@npmcli/package-json'));
  const before = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  run('npm', ['pack', '--dry-run', '--json']);
  const metadata = JSON.parse(run('npm', ['pack', '--pack-destination', work, '--json']));
  const archive = join(work, metadata[0].filename);
  writeFileSync(join(work, 'pack.json'), JSON.stringify(metadata, null, 2));
  run('/usr/bin/tar', ['-xzf', archive, '-C', join(work, 'unpacked')]);
  const packedRoot = join(work, 'unpacked/package'),
    packed = JSON.parse(readFileSync(join(packedRoot, 'package.json'), 'utf8'));
  assert.equal(packed.bin.agentmind, 'dist/runtime/packages/mcp-server/dist/agentmind.js');
  assert.equal(packed.name, before.name);
  assert.equal(packed.version, before.version);
  const entry = metadata[0].files.find((f) => f.path === packed.bin.agentmind);
  assert(entry && (entry.mode & 0o111) === 0o111);
  assert(
    readFileSync(join(packedRoot, packed.bin.agentmind), 'utf8').startsWith(
      '#!/usr/bin/env node\n',
    ),
  );
  const prepared = await PackageJson.load(packedRoot),
    changes = [];
  await prepared.fix({ changes });
  await prepared.prepare();
  assert.deepEqual(prepared.content.bin, packed.bin);
  assert(!changes.some((c) => c.includes('bin[')));
  const publish = run('npm', ['publish', archive, '--dry-run', '--ignore-scripts', '--json']);
  const publishMetadata = JSON.parse(publish);
  assert.equal((publishMetadata[packed.name] ?? publishMetadata).name, packed.name);
  const global = run(
    process.execPath,
    [
      join(root, 'scripts/verify-global-cli.mjs'),
      '--archive',
      archive,
      '--pack-metadata',
      join(work, 'pack.json'),
    ],
    {
      env: {
        ...env,
        ...(process.env.AGENTMIND_ANTIGRAVITY_EXECUTABLE
          ? { AGENTMIND_ANTIGRAVITY_EXECUTABLE: process.env.AGENTMIND_ANTIGRAVITY_EXECUTABLE }
          : {}),
      },
    },
  );
  const globalWork = global.match(/Evidence retained: (.+)/)?.[1];
  assert(globalWork);
  const execEnv = { ...env, npm_config_cache: join(globalWork, 'cache') };
  const version = run(
    'npm',
    ['exec', '--offline', '--yes', '--package', archive, '--', 'agentmind', '--version'],
    { cwd: join(work, 'project'), env: execEnv },
  );
  assert.equal(version.trim(), packed.version);
  const help = run('npx', ['--offline', '--yes', '--package', archive, 'agentmind', '--help'], {
    cwd: join(work, 'project'),
    env: execEnv,
  });
  assert(help.includes('Usage: agentmind'));
  for (const asset of ['antigravity/adapter.js', 'antigravity/setup.js'])
    assert(existsSync(join(packedRoot, 'dist/runtime/packages/mcp-server/dist', asset)));
  const evidence = {
    schema_version: 1,
    npm: npmVersion,
    node: process.version,
    name: packed.name,
    version: packed.version,
    source_revision: run('git', ['rev-parse', 'HEAD']).trim(),
    dirty_tree: run('git', ['status', '--porcelain']),
    archive,
    sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
    npm_integrity: metadata[0].integrity,
    bin_before: before.bin,
    bin_packed: packed.bin,
    bin_publish_prepared: prepared.content.bin,
    normalization_changes: changes,
    bin_mode: entry.mode,
    shebang: true,
    publish_dry_run: true,
    published: false,
    global_installation: globalWork,
    global_executable: join(globalWork, 'prefix/bin/agentmind'),
    npm_exec_version: version.trim(),
    npx_help: true,
    native_discovery_executable: process.env.AGENTMIND_ANTIGRAVITY_EXECUTABLE ?? null,
    global_command_evidence: JSON.parse(readFileSync(join(globalWork, 'commands.json'), 'utf8')),
    commands,
  };
  writeFileSync(join(work, 'evidence.json'), JSON.stringify(evidence, null, 2));
  const destination = join(root, 'dist/artifacts/P6-005D.1');
  mkdirSync(destination, { recursive: true });
  for (const file of [metadata[0].filename, 'pack.json', 'evidence.json', 'commands.json'])
    copyFileSync(join(work, file), join(destination, file));
  writeFileSync(join(destination, 'SHA256SUMS'), `${evidence.sha256}  ${metadata[0].filename}\n`);
  console.log(
    JSON.stringify(
      {
        status: 'PASS',
        version: packed.version,
        sha256: evidence.sha256,
        artifact: join(destination, metadata[0].filename),
        evidence: join(destination, 'evidence.json'),
        work,
        global_installation: globalWork,
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.error(String(e));
  console.error(`Evidence retained: ${work}`);
  process.exitCode = 1;
}

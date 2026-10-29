// Local source RC preparation only. No install, publish, authentication or live configuration.
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

export const releaseRoot = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const files = [
  'README.md',
  'SECURITY.md',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.json',
  'tsconfig.check.json',
  'vitest.config.ts',
  'biome.json',
  'native/peer.c',
];
const trees = [
  'packages/core/src',
  'packages/mcp-server/src',
  'scripts',
  'skills',
  'tests',
  'contracts',
  'docs/v1',
];
export function sourceEntries(root = releaseRoot) {
  const paths = [...files];
  const add = (p) => {
    const st = lstatSync(join(root, p));
    if (st.isSymbolicLink() || (st.nlink > 1 && st.isFile())) throw Error('RELEASE_LINK_REFUSED');
    if (st.isDirectory()) {
      for (const name of readdirSync(join(root, p)).sort()) add(`${p}/${name}`);
    } else if (st.isFile()) paths.push(p);
    else throw Error('RELEASE_SPECIAL_FILE_REFUSED');
  };
  for (const tree of trees) add(tree);
  for (const p of ['core', 'mcp-server'])
    for (const name of ['package.json', 'tsconfig.json']) paths.push(`packages/${p}/${name}`);
  if (paths.length > 10000) throw Error('RELEASE_TOO_MANY_INPUTS');
  let total = 0;
  return paths.sort().map((path) => {
    if (
      path
        .split('/')
        .some((s) => s.startsWith('.') || ['node_modules', 'dist', 'bin'].includes(s)) ||
      /\.(db|sqlite|pem|key|log|tgz)$/.test(path)
    )
      throw Error('RELEASE_UNEXPECTED_INPUT');
    const full = join(root, path),
      st = lstatSync(full);
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.nlink !== 1 ||
      st.size > 8 * 1024 * 1024 ||
      realpathSync(full) !== full
    )
      throw Error('RELEASE_INPUT_INVALID');
    total += st.size;
    if (total > 128 * 1024 * 1024) throw Error('RELEASE_INPUT_BUDGET');
    const bytes = readFileSync(full);
    return { path, bytes, sha256: sha(bytes), mode: 0o644 };
  });
}
export function releasePlan(root = releaseRoot) {
  const entries = sourceEntries(root),
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(pkg.version))
    throw Error('RELEASE_VERSION_INVALID');
  return {
    schema_version: 1,
    artifact_type: 'SOURCE_WORKSPACE_RC',
    version: pkg.version,
    node: pkg.engines.node,
    build_environment: { node: process.version, platform: process.platform, arch: process.arch },
    package_manager: pkg.packageManager,
    source_identity: sha(JSON.stringify(entries.map(({ path, sha256 }) => ({ path, sha256 })))),
    file_count: entries.length,
    source_bytes: entries.reduce((n, e) => n + e.bytes.length, 0),
    files: entries.map(({ path, sha256, bytes }) => ({ path, sha256, bytes: bytes.length })),
    entrypoint: 'node packages/mcp-server/dist/agentmind.js',
    build_required: true,
    dependencies_bundled: false,
    native_binaries_bundled: false,
    install: ['pnpm install --frozen-lockfile', 'pnpm build'],
    license: 'NO_LICENSE_GRANT_PRESENT',
    public_distribution_authorized: false,
    native_model_execution: 'NOT_VERIFIED',
    protected_operator: 'NOT_VERIFIED',
    behavioral_sandbox: 'NOT_VERIFIED',
    release_approved: false,
    clean_machine_installation: 'NOT_VERIFIED',
  };
}
// POSIX ustar: stable order, uid/gid/mtime zero; no links/devices/executable payloads.
export function sourceArchive(root = releaseRoot) {
  const plan = releasePlan(root),
    entries = sourceEntries(root);
  if (
    sha(JSON.stringify(entries.map(({ path, sha256 }) => ({ path, sha256 })))) !==
    plan.source_identity
  )
    throw Error('RELEASE_SOURCE_CHANGED');
  const manifest = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`);
  const rows = [...entries, { path: 'RELEASE-MANIFEST.json', bytes: manifest, mode: 0o644 }].sort(
    (a, b) => a.path.localeCompare(b.path, 'en'),
  );
  const chunks = [];
  for (const row of rows) {
    const name = `agentmind-${plan.version}/${row.path}`,
      header = Buffer.alloc(512);
    let leaf = name,
      prefix = '';
    if (Buffer.byteLength(name) > 100) {
      const i = name.lastIndexOf('/');
      prefix = name.slice(0, i);
      leaf = name.slice(i + 1);
    }
    if (Buffer.byteLength(prefix) > 155 || Buffer.byteLength(leaf) > 100)
      throw Error('RELEASE_PATH_TOO_LONG');
    header.write(leaf, 0);
    header.write(prefix, 345);
    const oct = (offset, size, n) =>
      header.write(`${n.toString(8).padStart(size - 1, '0')}\0`, offset, size, 'ascii');
    oct(100, 8, row.mode);
    oct(108, 8, 0);
    oct(116, 8, 0);
    oct(124, 12, row.bytes.length);
    oct(136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257);
    header.write('00', 263);
    const sum = header.reduce((n, b) => n + b, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    chunks.push(header, row.bytes, Buffer.alloc((512 - (row.bytes.length % 512)) % 512));
  }
  const bytes = gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]), { level: 9 });
  return { bytes, plan, sha256: sha(bytes) };
}
export function buildRelease(output, root = releaseRoot) {
  const target = resolve(output),
    parent = dirname(target),
    st = lstatSync(parent);
  if (
    realpathSync(parent) !== parent ||
    !st.isDirectory() ||
    st.mode & 0o077 ||
    (process.getuid && st.uid !== process.getuid())
  )
    throw Error('RELEASE_PRIVATE_OUTPUT_REQUIRED');
  const archive = sourceArchive(root);
  const stage = join(parent, `.agentmind-source-${randomUUID()}`);
  const fd = openSync(stage, 'wx', 0o600);
  try {
    writeFileSync(fd, archive.bytes);
    fsyncSync(fd);
    const current = lstatSync(parent);
    if (
      current.dev !== st.dev ||
      current.ino !== st.ino ||
      realpathSync(parent) !== parent ||
      current.mode & 0o077 ||
      current.uid !== st.uid
    )
      throw Error('RELEASE_OUTPUT_CHANGED');
    // Same-filesystem hard-link publication fails if destination already exists.
    linkSync(stage, target);
  } finally {
    closeSync(fd);
    unlinkSync(stage);
  }
  return {
    schema_version: 1,
    artifact: relative(parent, target),
    sha256: archive.sha256,
    bytes: archive.bytes.length,
    source_identity: archive.plan.source_identity,
    release_approved: false,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values, positionals } = parseArgs({
      strict: true,
      allowPositionals: true,
      options: { output: { type: 'string' } },
    });
    if (
      positionals.length !== 1 ||
      !['plan', 'build'].includes(positionals[0]) ||
      (positionals[0] === 'build') !== !!values.output
    )
      throw Error('RELEASE_ARGUMENTS');
    console.log(
      JSON.stringify(
        positionals[0] === 'build' ? buildRelease(values.output) : releasePlan(),
        null,
        2,
      ),
    );
  } catch {
    console.error(
      'Release preparation refused. Use: node scripts/release.mjs plan | build --output NEW_FILE_IN_PRIVATE_DIRECTORY. No overwrite, installation or publication is performed.',
    );
    process.exitCode = 1;
  }
}

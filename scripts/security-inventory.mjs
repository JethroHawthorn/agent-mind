// Offline implementation-audit preparation. No registry, credentials, network or model access.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(resolve('packages/core/package.json'));
const { parse } = require('yaml');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const lockText = readFileSync('pnpm-lock.yaml', 'utf8'),
  lock = parse(lockText),
  workspace = parse(readFileSync('pnpm-workspace.yaml', 'utf8'));
const mismatches = [],
  importers = [];
for (const directory of ['.', 'packages/core', 'packages/mcp-server']) {
  const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')),
    importer = lock.importers[directory];
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'])
    for (const [name, specifier] of Object.entries(manifest[section] ?? {}))
      if (importer?.[section]?.[name]?.specifier !== specifier)
        mismatches.push({ directory, section, name });
  importers.push({
    directory,
    name: manifest.name,
    package_manager: manifest.packageManager ?? null,
    dependencies: importer,
    script_names: Object.keys(manifest.scripts ?? {}),
    scripts_digest: hash(JSON.stringify(manifest.scripts ?? {})),
  });
}
const packages = Object.entries(lock.packages ?? {});
const tools = readFileSync('packages/mcp-server/src/server.ts', 'utf8');
const registered = [...tools.matchAll(/registerTool\(\s*'([^']+)'/g)].map((match) => match[1]);
const report = {
  schema_version: 1,
  method: 'OFFLINE_SOURCE_AND_LOCK_INSPECTION',
  node: process.version,
  lockfile_version: lock.lockfileVersion,
  lockfile_sha256: hash(lockText),
  manifest_lock_consistency: mismatches.length ? 'FAIL' : 'PASS',
  mismatches,
  package_count: packages.length,
  packages_with_integrity: packages.filter(([, p]) => p.resolution?.integrity).length,
  build_allowlist: workspace.allowBuilds,
  importers,
  registered_local_tool_names: registered,
  registered_local_tool_count: registered.length,
  advisory_intelligence: 'NOT_VERIFIED',
  registry_signatures: 'NOT_VERIFIED',
  installed_binary_integrity: 'NOT_VERIFIED',
  limitations: [
    'A lockfile checksum is not a registry signature or an absence-of-vulnerabilities assessment.',
    'No npmrc, credential file, user database, CLI authentication or remote advisory endpoint was read.',
    'No packages, binaries or lifecycle scripts were installed or executed.',
  ],
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = mismatches.length ? 1 : 0;

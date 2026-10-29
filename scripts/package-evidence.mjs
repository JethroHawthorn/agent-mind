// Audit an npm pack manifest against the exact local tarball and retain its identity.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const metadata = JSON.parse(readFileSync(process.argv[2], 'utf8'))[0];
const archive = resolve(process.argv[3]);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const files = [];
for (const file of metadata.files) {
  assert(!file.path.includes('..'));
  assert(
    /^(?:package\.json|README\.md|SECURITY\.md|LICENSE|docs\/v1\/[A-Z0-9_]+\.md|dist\/runtime\/)/.test(
      file.path,
    ),
  );
  assert(!/(?:node_modules|\/src\/|\.env|\.db$|\.map$|\.node$|\.pem$|\.key$)/.test(file.path));
  const result = spawnSync('/usr/bin/tar', ['-xOf', archive, `package/${file.path}`], {
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0);
  const text = result.stdout.toString('utf8');
  assert(!text.includes(process.cwd()), `Absolute checkout path: ${file.path}`);
  assert(
    !/(?:-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|sk-proj-[A-Za-z0-9_-]{40,})/.test(
      text,
    ),
    `Secret pattern: ${file.path}`,
  );
  files.push({ ...file, sha256: sha(result.stdout) });
}
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
assert(files.some((file) => file.path === manifest.bin.agentmind && (file.mode & 0o111) !== 0));
const packed = spawnSync('/usr/bin/tar', ['-xOf', archive, 'package/package.json']);
const pkg = JSON.parse(packed.stdout.toString('utf8'));
assert(!/workspace:|file:|link:/.test(JSON.stringify(pkg.dependencies)));
assert.equal(pkg.license, 'MIT');
assert(
  files.some((file) => file.path === 'LICENSE' && file.sha256 === sha(readFileSync('LICENSE'))),
);
const evidence = {
  schema_version: 1,
  artifact: archive,
  sha256: sha(readFileSync(archive)),
  npm_integrity: metadata.integrity,
  bytes: metadata.size,
  unpacked_bytes: metadata.unpackedSize,
  package: pkg,
  files,
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  audit:
    'Explicit file allowlist, source-path and known secret-pattern scan; not exhaustive credential or dependency provenance certification.',
  clean_machine: 'NOT VERIFIED',
  publication: 'NO-GO',
  previous_rc_certification:
    'STALE for executable, runtime packaging, dependency layout and documentation; independent recertification required',
};
writeFileSync(
  join(dirname(archive), `${metadata.filename.replace(/\.tgz$/, '')}.manifest.json`),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
writeFileSync(join(dirname(archive), 'SHA256SUMS'), `${evidence.sha256}  ${metadata.filename}\n`);
console.log(
  JSON.stringify({ sha256: evidence.sha256, files: files.length, bytes: evidence.bytes }),
);

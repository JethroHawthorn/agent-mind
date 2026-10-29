import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import {
  auditDependencyTree,
  extractVerified,
  inspectArtifact,
  tool,
} from '../../scripts/rc-validation.mjs';
import { sourceArchive } from '../../scripts/release.mjs';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
function mutation(offset: number, text: string) {
  const original = sourceArchive().bytes,
    tar = gunzipSync(original);
  tar.fill(0, offset, offset + 100);
  tar.write(text, offset);
  tar.fill(32, 148, 156);
  const sum = tar.subarray(0, 512).reduce((n, b) => n + b, 0);
  tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return gzipSync(tar);
}
it('verifies complete generated archive and copied snapshot source identity before extraction', () => {
  const a = sourceArchive(),
    v = inspectArtifact(a.bytes, a.sha256);
  expect(v.manifest.source_identity).toBe(a.plan.source_identity);
  expect(v.entries.size).toBe(a.plan.file_count + 1);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentmind-rc-unit-')));
  try {
    const output = join(root, 'extract'),
      source = extractVerified(v, output);
    expect(source).toBe(join(output, `agentmind-${a.plan.version}`));
    expect(() => extractVerified(v, output)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it('rejects corrupt digest, truncated gzip/tar and symlink/type headers before any extraction', () => {
  const a = sourceArchive();
  expect(() => inspectArtifact(a.bytes, '0'.repeat(64))).toThrow('RC_DIGEST_MISMATCH');
  expect(() => inspectArtifact(a.bytes.subarray(0, 80), sha(a.bytes.subarray(0, 80)))).toThrow();
  const tar = gunzipSync(a.bytes);
  tar[156] = 50;
  tar.fill(32, 148, 156);
  const sum = tar.subarray(0, 512).reduce((n, b) => n + b, 0);
  tar.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  const bad = gzipSync(tar);
  expect(() => inspectArtifact(bad, sha(bad))).toThrow('RC_TAR_HEADER');
});
it.each(['../outside', '/absolute', 'C:/host', 'evil\\path'])(
  'rejects malicious archive path %s',
  (path) => {
    const b = mutation(0, path);
    expect(() => inspectArtifact(b, sha(b))).toThrow('RC_PATH_OR_DUPLICATE');
  },
);
it('rejects substituted content even when outer archive checksum has been recomputed', () => {
  const a = sourceArchive(),
    tar = gunzipSync(a.bytes);
  tar[512] = (tar[512] ?? 0) ^ 1;
  const bad = gzipSync(tar);
  expect(() => inspectArtifact(bad, sha(bad))).toThrow('RC_FILE_INTEGRITY');
});
it('rejects dependency links escaping artifact and allows only confined links', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentmind-rc-deps-')));
  try {
    mkdirSync(join(root, 'inside'));
    writeFileSync(join(root, 'inside', 'file'), 'synthetic');
    symlinkSync('inside/file', join(root, 'good'));
    expect(auditDependencyTree(root).external_links).toBe(0);
    symlinkSync('/usr/bin', join(root, 'bad'));
    expect(() => auditDependencyTree(root)).toThrow('RC_EXTERNAL_DEPENDENCY_LINK');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('retains a pnpm-named executable on the controlled build PATH for nested documented commands', () => {
  const executable = tool('pnpm');
  if (!executable) throw Error('PNPM_REQUIRED');
  const result = spawnSync('/bin/sh', ['-c', 'pnpm --version'], {
    env: { PATH: `${dirname(process.execPath)}:${dirname(executable)}:/usr/bin:/bin` },
    encoding: 'utf8',
    timeout: 10000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('11.6.0');
});

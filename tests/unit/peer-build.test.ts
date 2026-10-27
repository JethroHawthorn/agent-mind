import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { firstCompatible, installedSdks } from '../../scripts/lib/peer-build.mjs';

it('probes installed SDKs in deterministic selected-first order and deduplicates aliases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'peer-sdk-'));
  try {
    for (const n of ['MacOSX27.0.sdk', 'MacOSX26.5.sdk', 'NotAnSDK']) mkdirSync(join(dir, n));
    symlinkSync(join(dir, 'MacOSX27.0.sdk'), join(dir, 'MacOSX.sdk'));
    expect(installedSdks(join(dir, 'MacOSX.sdk'))).toEqual([
      realpathSync(join(dir, 'MacOSX27.0.sdk')),
      realpathSync(join(dir, 'MacOSX26.5.sdk')),
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('tries the next installed SDK after compiler/linker failure, not weaker security checks', () => {
  const attempts: string[] = [];
  expect(
    firstCompatible(['default27', 'installed26'], (sdk: string) => {
      attempts.push(sdk);
      return sdk === 'installed26';
    }),
  ).toBe('installed26');
  expect(attempts).toEqual(['default27', 'installed26']);
});
it('explicit SDK stays pinned and failure does not select an unrelated SDK', () =>
  expect(firstCompatible(['explicit'], () => false)).toBeNull());
it('caps attempts and does not retry forever', () => {
  let count = 0;
  expect(
    firstCompatible(
      Array.from({ length: 20 }, (_, i) => `${i}`),
      () => {
        count++;
        return false;
      },
    ),
  ).toBeNull();
  expect(count).toBe(6);
});

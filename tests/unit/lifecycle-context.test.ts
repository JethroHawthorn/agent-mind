import * as os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { localOperatorIdentity, nextTimestamp } from '../../packages/core/src/index.js';
import { skillFixture } from '../helpers/skill-fixture.js';

vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  return { ...actual, userInfo: vi.fn(actual.userInfo) };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it('advances time within the same millisecond and through a regressing wall clock', () => {
  const previous = '2026-10-24T00:00:00.123Z';
  expect(nextTimestamp(previous, Date.parse(previous))).toBe('2026-10-24T00:00:00.124Z');
  expect(nextTimestamp(previous, 0)).toBe('2026-10-24T00:00:00.124Z');
  expect(nextTimestamp(previous, Date.parse(previous) + 100)).toBe('2026-10-24T00:00:00.223Z');
});
it.each(['invalid', '2026-10-24', '2026-10-24T00:00:00Z'])(
  'rejects invalid prior lifecycle timestamps: %s',
  (previous) => {
    expect(() => nextTimestamp(previous)).toThrow('canonical UTC');
  },
);
it.each([NaN, Infinity, 0.5, 8640000000000001])('rejects an unusable wall clock', (clock) => {
  expect(() => nextTimestamp(undefined, clock)).toThrow('valid lifecycle timestamp');
});
it('uses the shared timestamp helper for real SQL lifecycle records under a frozen wall clock', () => {
  vi.spyOn(Date, 'now').mockReturnValue(1792800000123);
  const f = skillFixture();
  try {
    const id = f.identity();
    const version = f.version(id);
    f.evaluation(version);
    f.review(version);
    f.transition(id, version);
    expect(f.store.getIdentity(id).active_version_id).toBe(version);
    const entries = [
      f.store.getVersion(version).version.created_at,
      (f.db.prepare('SELECT created_at FROM skill_evaluations').get() as { created_at: string })
        .created_at,
      (f.db.prepare('SELECT created_at FROM skill_reviews').get() as { created_at: string })
        .created_at,
      (f.db.prepare('SELECT created_at FROM skill_promotions').get() as { created_at: string })
        .created_at,
    ];
    expect(entries).toEqual([...entries].sort());
    expect(new Set(entries).size).toBe(4);
  } finally {
    f.close();
  }
});
it('derives future operator attribution from OS credentials, ignoring USER environment spoofing', () => {
  vi.stubEnv('USER', 'forged-admin');
  vi.mocked(os.userInfo).mockReturnValue({
    uid: 1234,
    gid: 1234,
    username: 'actual-user',
    homedir: '/tmp',
    shell: '/bin/sh',
  });
  expect(localOperatorIdentity()).toBe('uid:1234:actual-user');
});
it('fails safely when OS identity cannot be derived', () => {
  vi.mocked(os.userInfo).mockImplementationOnce(() => {
    throw new Error('private OS error');
  });
  expect(() => localOperatorIdentity()).toThrow('operating system');
});

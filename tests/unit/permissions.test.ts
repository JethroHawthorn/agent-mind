import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openDatabase } from '../../packages/core/src/database.js';

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, chmodSync: vi.fn(actual.chmodSync) };
});
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  vi.restoreAllMocks();
});
function path() {
  const dir = fs.mkdtempSync(join(tmpdir(), 'agentmind-permissions-'));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'memory.db');
}
it.each(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'])(
  'starts with a safe warning if chmod returns %s',
  (code) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fs.chmodSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('sensitive path'), { code });
    });
    const db = openDatabase(path());
    try {
      expect(db.pragma('quick_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
    }
    expect(log).toHaveBeenCalledWith(expect.stringContaining('FILE_PERMISSIONS_UNSUPPORTED'));
    expect(JSON.stringify(log.mock.calls)).not.toContain('sensitive path');
  },
);
it.each(['EIO', 'EACCES'])('fails safely for unexpected chmod error %s', (code) => {
  vi.mocked(fs.chmodSync).mockImplementationOnce(() => {
    throw Object.assign(new Error('sensitive path'), { code });
  });
  expect(() => openDatabase(path())).toThrow('Cannot initialize SQLite');
});

import type Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { verifySqliteDriver } from '../../packages/mcp-server/src/installer/sqlite-driver.js';

it('loads the actual declared native SQLite driver and probes an in-memory FTS5 index', async () => {
  expect(await verifySqliteDriver()).toEqual({ status: 'PASS', code: 'SQLITE_DRIVER_FTS5_READY' });
});
it.each([
  ['ERR_MODULE_NOT_FOUND', 'Cannot find package better-sqlite3', 'SQLITE_DRIVER_MISSING'],
  ['', 'Could not locate the bindings file', 'SQLITE_BINDING_MISSING'],
  [
    'ERR_DLOPEN_FAILED',
    'compiled against a different NODE_MODULE_VERSION',
    'SQLITE_NATIVE_INCOMPATIBLE',
  ],
  ['', 'unsupported platform or architecture', 'SQLITE_PLATFORM_UNSUPPORTED'],
  ['EACCES', 'private path not printed', 'SQLITE_DRIVER_PERMISSION'],
] as const)(
  'classifies %s / %s without reflecting raw driver errors',
  async (code, message, expected) => {
    const result = await verifySqliteDriver(async () => {
      throw Object.assign(Error(message), { code });
    });
    expect(result).toEqual({ status: 'FAIL', code: expected });
    expect(JSON.stringify(result)).not.toContain(message);
  },
);
it('closes the disposable connection even when FTS5 is unavailable', async () => {
  let closed = false;
  class Probe {
    prepare() {
      return { get: () => ({ value: 1 }) };
    }
    exec() {
      throw Error('no such module: fts5 with private native diagnostics');
    }
    close() {
      closed = true;
    }
  }
  const result = await verifySqliteDriver(async () => ({
    default: Probe as unknown as typeof Database,
  }));
  expect(result).toEqual({ status: 'FAIL', code: 'SQLITE_FTS5_UNAVAILABLE' });
  expect(closed).toBe(true);
});
it('rejects a driver returning an unexpected basic query result and closes it', async () => {
  let closed = false;
  class Probe {
    prepare() {
      return { get: () => ({ value: 0 }) };
    }
    close() {
      closed = true;
    }
  }
  expect(
    await verifySqliteDriver(async () => ({ default: Probe as unknown as typeof Database })),
  ).toEqual({ status: 'FAIL', code: 'SQLITE_DRIVER_CONNECTION_FAILED' });
  expect(closed).toBe(true);
});

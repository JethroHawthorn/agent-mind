import { afterEach, expect, it, vi } from 'vitest';
import { createShutdown } from '../../packages/mcp-server/src/shutdown.js';

const originalExitCode = process.exitCode;
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.exitCode = originalExitCode;
});
it('preserves a fatal exit code when a second shutdown arrives during cleanup', async () => {
  vi.useFakeTimers();
  let release: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const closeDatabase = vi.fn();
  const shutdown = createShutdown({ closeServer: () => closed, closeDatabase });
  const first = shutdown();
  await shutdown(1);
  await shutdown();
  release();
  await first;
  expect(process.exitCode).toBe(1);
  expect(closeDatabase).toHaveBeenCalledOnce();
});
it('still closes storage and fails safely if transport cleanup rejects', async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const closeDatabase = vi.fn();
  await createShutdown({
    closeServer: async () => {
      throw new Error('sensitive transport data');
    },
    closeDatabase,
  })();
  expect(process.exitCode).toBe(1);
  expect(closeDatabase).toHaveBeenCalledOnce();
  expect(log).toHaveBeenCalledWith('[agentmind] SHUTDOWN_ERROR');
  expect(JSON.stringify(log.mock.calls)).not.toContain('sensitive transport data');
});

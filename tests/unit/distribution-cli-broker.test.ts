import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../../packages/core/dist/index.js', async (original) => ({
  ...(await original<typeof import('../../packages/core/dist/index.js')>()),
  loadBrokerClient: vi.fn(() => ({
    schema_version: 1,
    broker_uid: 201,
    helper: '/fixture/helper',
    socket_directory: '/fixture/socket',
  })),
  brokerRequest: vi.fn(async () => ({ schema_version: 1, readonly: true })),
}));

import { brokerRequest } from '../../packages/core/dist/index.js';
import { runDistributionCLI } from '../../packages/mcp-server/src/distribution.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
it('F07 uses authenticated operator reads without opening a direct protected database', async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const id = '11111111-1111-4111-8111-111111111111';
  for (const [action, op] of [
    ['history', 'distribution_history'],
    ['rollback', 'distribution_rollback_plan'],
    ['verify', 'distribution_plan'],
  ]) {
    await runDistributionCLI([
      action ?? '',
      id,
      '--client-config',
      '/fixture/client.json',
      '--project',
      'a',
      '--json',
      ...(action === 'rollback' ? ['--dry-run'] : []),
    ]);
    expect(brokerRequest).toHaveBeenLastCalledWith(
      expect.anything(),
      'operator',
      expect.objectContaining({ op, project: 'a' }),
    );
  }
});
it('F07 rejects mixing trusted broker selection with local database/root overrides', async () => {
  await expect(
    runDistributionCLI([
      'history',
      '11111111-1111-4111-8111-111111111111',
      '--client-config',
      '/fixture/client.json',
      '--project',
      'a',
      '--db',
      '/other.db',
    ]),
  ).rejects.toThrow(/without local/);
  expect(brokerRequest).not.toHaveBeenCalled();
});

it('F10 broker conflict/repair plans use the same exit3 as local inspection', async () => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const previous = process.exitCode;
  try {
    for (const action of ['CONFLICT', 'REPAIR']) {
      vi.mocked(brokerRequest).mockResolvedValueOnce({ entries: [{ action }] });
      await runDistributionCLI([
        'status',
        '11111111-1111-4111-8111-111111111111',
        '--client-config',
        '/fixture/client.json',
        '--project',
        'a',
        '--json',
      ]);
      expect(process.exitCode).toBe(3);
    }
  } finally {
    process.exitCode = previous;
  }
});

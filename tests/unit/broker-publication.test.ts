import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../../packages/core/src/operator-confirmation.js', async (original) => ({
  ...(await original<typeof import('../../packages/core/src/operator-confirmation.js')>()),
  consumeOperatorGrant: (_: unknown, digest: string) => ({
    operator: 'synthetic-publication-test',
    session: randomUUID(),
    digest,
  }),
}));

import { SkillDistributionService } from '../../packages/core/src/index.js';
import { distributionFixture } from '../helpers/distribution-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
it('materializes exact approved files as group-readable, agent-nonwritable copies without changing private-mode defaults', () => {
  const f = distributionFixture();
  cleanup.push(f.close);
  const gid = process.getgid?.();
  if (gid === undefined) throw new Error('POSIX test required');
  const service = new SkillDistributionService(f.db, f.scope, f.home, { gid });
  service.commit(f.request, {});
  expect(lstatSync(join(f.root, '.agentmind')).mode & 0o777).toBe(0o700);
  expect(lstatSync(join(f.root, '.agentmind', 'distribution-v1')).mode & 0o777).toBe(0o700);
  for (const target of ['.agents', '.claude']) {
    const root = join(f.root, target, 'skills', f.candidate.identity.name);
    expect(lstatSync(root).mode & 0o777).toBe(0o750);
    expect(lstatSync(root).gid).toBe(gid);
    const file = join(root, 'SKILL.md');
    expect(lstatSync(file).mode & 0o777).toBe(0o640);
    expect(readFileSync(file, 'utf8')).toBe(
      f.candidate.version.files.find((f) => f.path === 'SKILL.md')?.content,
    );
  }
  expect(service.plan(f.request).entries.map((e) => e.action)).toEqual(['SKIP', 'SKIP']);
});

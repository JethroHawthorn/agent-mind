import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { distributionFixture } from '../helpers/distribution-fixture.js';
import { operatorTTY } from '../helpers/operator-pty.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
/** Actual local test PTY grant; simulated protected marker, NOT an OS denial. */
it.each(['protected', 'protected-distribution'])(
  'rejects a local TTY grant after protected-registry attribution: %s',
  async (scenario) => {
    const f = distributionFixture(scenario === 'protected-distribution');
    cleanup.push(f.close);
    if (scenario === 'protected') f.evaluate(f.candidate.version.id);
    const before = f.db.prepare('SELECT * FROM skill_operator_events ORDER BY id').all();
    const p = operatorTTY(
      f.root,
      [
        '--project-root',
        f.root,
        '--db',
        f.path,
        '--version',
        f.candidate.version.id,
        '--scenario',
        scenario,
      ],
      resolve('tests/fixtures/operator-grant.mjs'),
    );
    expect((await p.ready).event).toBe('ready');
    p.respond();
    const result = await p.exit;
    expect(result.status, result.output.slice(-2000)).toBe(0);
    expect(result.output).toContain('PROTECTED_OPERATOR_REQUIRED');
    expect(f.db.prepare('SELECT * FROM skill_operator_events ORDER BY id').all()).toEqual(before);
  },
  20000,
);

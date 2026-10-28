import { describe, expect, it } from 'vitest';
import { dailySafe } from '../../packages/core/src/daily/projection.js';
import {
  AgentMindError,
  assertSafeSummary,
  redactReview,
  redactSecrets,
  safeError,
} from '../../packages/core/src/index.js';
import { diagnosticText } from '../../packages/mcp-server/src/installer/files.js';

const canary = 'fixture-private-value-4937';
describe('P5-005 synthetic credential boundaries (application layer)', () => {
  it.each([
    'password',
    'client_secret',
    'AWS_SECRET_ACCESS_KEY',
    'Cookie',
    'refresh_token',
    'private-key',
    'credentials',
    'ＧＩＴＨＵＢ＿ＴＯＫＥＮ',
  ])('redacts structured %s values across terminal and JSON views', (key) => {
    const original = { ordinary: 'bounded public guidance', nested: { [key]: canary } };
    const before = JSON.stringify(original);
    expect(diagnosticText(original)).not.toContain(canary);
    expect(JSON.stringify(dailySafe(original))).not.toContain(canary);
    expect(JSON.stringify(redactReview(original))).not.toContain(canary);
    expect(JSON.stringify(original)).toBe(before);
  });
  it.each(['token', 'secret', 'cookie', 'aws_secret_access_key', 'private_key', 'passphrase'])(
    'rejects credential assignment %s in durable memory/skill summaries',
    (key) => {
      expect(() => assertSafeSummary(`${key}=${canary}`)).toThrow();
      expect(redactSecrets(`${key}=${canary}`)).not.toContain(canary);
    },
  );
  it('rejects JSON transcript exports in Phase 0 as well as experiences', () => {
    expect(() =>
      assertSafeSummary(
        JSON.stringify({ messages: [{ role: 'user', content: 'synthetic private conversation' }] }),
      ),
    ).toThrow(/transcript/i);
  });
  it('allows explicit documentation placeholders, but rejects wrapped real vendor keys', () => {
    expect(() => assertSafeSummary('token=<YOUR_TOKEN> private_key=<PRIVATE_KEY>')).not.toThrow();
    expect(() => assertSafeSummary(`api_key=<sk-proj-${'a'.repeat(32)}>`)).toThrow();
  });
  it('does not expose arbitrary errors or injected sensitive operator messages', () => {
    expect(JSON.stringify(safeError(new Error(canary)))).not.toContain(canary);
    expect(
      JSON.stringify(safeError(new AgentMindError('INJECTED\nAPPROVED', `password=${canary}`))),
    ).not.toContain(canary);
    expect(safeError(new AgentMindError('INJECTED\nAPPROVED', 'fake approved')).code).not.toContain(
      '\n',
    );
  });
});
it('bounds cyclic/deep diagnostic graphs without rewriting canonical objects', () => {
  const cycle: Record<string, unknown> = { value: 'ordinary' };
  cycle.self = cycle;
  expect(diagnosticText(cycle)).toContain('CIRCULAR');
  expect(cycle.self).toBe(cycle);
});
it('redacts legacy memory and experience search views without rewriting their stored evidence', async () => {
  const { skillFixture } = await import('../helpers/skill-fixture.js');
  const { MemoryService } = await import('../../packages/core/src/index.js');
  const f = skillFixture();
  try {
    const memory = new MemoryService(f.db, f.scope, 'codex'),
      m = memory.save({
        title: 'Legacy privacy marker',
        content: 'Ordinary synthetic memory before corruption injection.',
      });
    f.db
      .prepare('UPDATE memories SET content=? WHERE id=?')
      .run(`Privacy marker token=${canary}`, m.id);
    expect(JSON.stringify(memory.search({ query: 'Privacy marker' }))).not.toContain(canary);
    const e = f.experiences.record({
      problem: 'Legacy privacy marker',
      solution: 'Ordinary fixture solution',
      outcome: { status: 'unknown', summary: 'Synthetic; not independently verified' },
    }).experience;
    f.db.prepare('UPDATE experiences SET solution=? WHERE id=?').run(`token=${canary}`, e.id);
    expect(JSON.stringify(f.experiences.search({ query: 'Legacy privacy marker' }))).not.toContain(
      canary,
    );
    expect(f.db.prepare('SELECT content FROM memories WHERE id=?').get(m.id)).toEqual({
      content: `Privacy marker token=${canary}`,
    });
    expect(f.db.prepare('SELECT solution FROM experiences WHERE id=?').get(e.id)).toEqual({
      solution: `token=${canary}`,
    });
  } finally {
    f.close();
  }
});
it('ordinary writer entry points refuse broker-marked state before migration or local grants', async () => {
  const { skillFixture } = await import('../helpers/skill-fixture.js');
  const { initializeProtectedRegistry } = await import(
    '../../packages/core/src/broker/registry.js'
  );
  const { openDatabase, openUsageDatabase } = await import('../../packages/core/src/index.js');
  const f = skillFixture();
  try {
    initializeProtectedRegistry(f.db, 'synthetic-deployment');
    const before = f.db.prepare('SELECT * FROM skill_operator_events').all();
    expect(() => openDatabase(f.path, { supervisedOnly: true })).toThrow(/protected broker/);
    expect(() => openUsageDatabase(f.path)).toThrow(/protected broker/);
    expect(f.db.prepare('SELECT * FROM skill_operator_events').all()).toEqual(before);
  } finally {
    f.close();
  }
});
it('preserves public authorization-policy labels without accepting them as authority', () => {
  expect(dailySafe({ authorization: 'NONE', password: 'NONE' })).toEqual({
    authorization: 'NONE',
    password: '[REDACTED]',
  });
});

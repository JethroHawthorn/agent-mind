import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import {
  initializeProtectedRegistry,
  openDatabase,
  releaseBoundaryStatus,
} from '../../packages/core/src/index.js';
import {
  consumeOperatorGrant,
  issueBrokerGrant,
} from '../../packages/core/src/operator-confirmation.js';
import { checkArchitecture, cycles, serialize } from '../../scripts/architecture.mjs';

const before = process.env.AGENTMIND_UNSAFE_BYPASS;
afterEach(() => {
  if (before === undefined) delete process.env.AGENTMIND_UNSAFE_BYPASS;
  else process.env.AGENTMIND_UNSAFE_BYPASS = before;
});
it('freezes actual SDK MCP schemas, core exports, CLI options and database/package contracts', async () => {
  const result = await checkArchitecture();
  expect(result.status).toBe('PASS');
  expect(result.contract_matches).toBe(true);
  expect(result.mcp_tools).toBe(42);
  expect(result.forbidden_mcp_tools).toEqual([]);
  expect(result.violations).toEqual([]);
  expect(result.grant_consumers).toHaveLength(5);
  expect(result.grant_consumers.every((x) => x.args === 3)).toBe(true);
  // Output JSON schemas are an explicitly recorded legacy gap, not manufactured verification.
  expect(result.missing_output_schemas.length).toBe(42);
}, 20000);
it('detects new cycles and keeps type-only cycles distinct from runtime initialization', () => {
  expect(
    cycles(
      new Map([
        ['a', ['b']],
        ['b', ['c']],
        ['c', ['a']],
        ['leaf', []],
      ]),
    ),
  ).toEqual([['a', 'b', 'c']]);
  expect(cycles(new Map([['a', ['a']]]))).toEqual([['a']]);
  expect(
    cycles(
      new Map([
        ['a', ['b']],
        ['b', []],
      ]),
    ),
  ).toEqual([]);
});
it('freeze serialization is deterministic and any contract change is visible', () => {
  const frozen = JSON.parse(readFileSync('contracts/v1.json', 'utf8'));
  expect(serialize({ b: 1, a: 2 })).toBe(serialize({ a: 2, b: 1 }));
  const changed = structuredClone(frozen);
  changed.mcp[0].inputSchema.additionalProperties = true;
  expect(serialize(changed)).not.toBe(serialize(frozen));
});
it('release diagnostics cannot convey authority or enable unverified capabilities', () => {
  process.env.AGENTMIND_UNSAFE_BYPASS = 'true';
  const status = releaseBoundaryStatus();
  expect(status.release_approved).toBe(false);
  expect(status.capabilities.autonomous_activation).toBe('DISABLED');
  expect(status.capabilities.protected_approval_promotion).toContain('DISABLED');
  expect(status.capabilities.sandbox_execution).toContain('DISABLED');
  expect(status.capabilities.legacy_local_lifecycle).toContain('OUTSIDE_V1_PROFILE');
  (status.capabilities as Record<string, string>).autonomous_activation = 'ENABLED';
  expect(releaseBoundaryStatus().capabilities.autonomous_activation).toBe('DISABLED');
});
it('protected registry accepts only an internal one-use broker grant, not serialized authority', () => {
  const db = openDatabase(':memory:');
  try {
    initializeProtectedRegistry(db, 'ba688c5f-38ab-4dfc-a035-3297e130077e');
    const digest = 'c'.repeat(64);
    // Issuance is test-internal: this is not a peer-authentication/OS deployment claim.
    const grant = issueBrokerGrant(digest, {
      uid: process.getuid?.() ?? 501,
      gid: process.getgid?.() ?? 20,
    });
    expect(() => consumeOperatorGrant(JSON.parse(JSON.stringify(grant)), digest, db)).toThrow();
    expect(consumeOperatorGrant(grant, digest, db).broker_peer).toBeDefined();
    expect(() => consumeOperatorGrant(grant, digest, db)).toThrow();
  } finally {
    db.close();
  }
});

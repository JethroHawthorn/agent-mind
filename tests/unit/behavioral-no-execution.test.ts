import { afterEach, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>();
  const blocked = () => {
    throw new Error('Behavioral evaluation must not start host execution.');
  };
  return {
    ...real,
    spawn: vi.fn(blocked),
    spawnSync: vi.fn(blocked),
    exec: vi.fn(blocked),
    execSync: vi.fn(blocked),
    execFile: vi.fn(blocked),
    execFileSync: vi.fn(blocked),
    fork: vi.fn(blocked),
  };
});

import * as processTools from 'node:child_process';
import { SkillEvaluationService } from '../../packages/core/src/index.js';
import { distributionFixture } from '../helpers/distribution-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
it('never runs generated task code, scripts, hooks, containers or subprocesses on the host', () => {
  const f = distributionFixture();
  cleanup.push(f.close);
  const p = f.propose('Behavioral execution request.');
  const result = new SkillEvaluationService(f.db, f.scope).evaluate({
    version_id: p.version.id,
    expected_content_hash: p.version.content_hash,
    expected_state_revision: p.state.revision,
    mode: 'behavioral',
  });
  expect(result.evaluation.result).toBe('NOT_VERIFIED');
  for (const tool of [
    processTools.spawn,
    processTools.spawnSync,
    processTools.exec,
    processTools.execSync,
    processTools.execFile,
    processTools.execFileSync,
    processTools.fork,
  ])
    expect(tool).not.toHaveBeenCalled();
  expect(result.behavioral?.execution).toMatchObject({
    backend: 'disabled',
    candidate_result: 'NOT_VERIFIED',
    baseline_result: 'NOT_VERIFIED',
    candidate_observation: null,
    baseline_observation: null,
  });
});

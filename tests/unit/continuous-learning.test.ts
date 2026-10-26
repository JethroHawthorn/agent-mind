import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { continuousToolEvidence } from '../../scripts/continuous-evidence.mjs';
import {
  loadContinuousFixture,
  prepareContinuousFixture,
  runContinuousTask,
  verifyContinuousTask,
} from '../../scripts/continuous-fixture.mjs';
import { cleanupLearningFixture, saveLearningFixture } from '../../scripts/learning-fixture.mjs';
import { AcceptanceTrace } from '../helpers/continuous-learning.js';

const roots: string[] = [];
function fixture() {
  const f = prepareContinuousFixture();
  roots.push(f.root);
  return f;
}
afterEach(() => {
  for (const root of roots.splice(0)) cleanupLearningFixture(root);
});
it('executes only finite code-owned primary and independent-task assertions, distinguishing baseline failure', () => {
  const f = fixture();
  for (const task of ['primary', 'transfer'] as const) {
    expect(runContinuousTask(f.root, task, 'baseline')).toMatchObject({
      status: 'FAIL',
      exit_code: 1,
      assertions: 4,
    });
    expect(runContinuousTask(f.root, task, 'reference')).toMatchObject({
      status: 'PASS',
      exit_code: 0,
      assertions: 4,
    });
  }
});
it('never executes unrecognized project/model source or modified acceptance criteria', () => {
  const f = fixture();
  const marker = join(f.root, 'executed');
  writeFileSync(
    join(f.root, 'clamp.ts'),
    `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'unsafe');`,
  );
  expect(verifyContinuousTask(f.root, 'primary').status).toBe('NOT VERIFIED');
  expect(existsSync(marker)).toBe(false);
  runContinuousTask(f.root, 'primary', 'reference');
  writeFileSync(join(f.root, 'clamp.test.mjs'), 'process.exit(0)');
  expect(verifyContinuousTask(f.root, 'primary').status).toBe('NOT VERIFIED');
});
it('rejects symlink and hardlink substitution without truncating the linked file', () => {
  const f = fixture(),
    source = join(f.root, 'clamp.ts'),
    sentinel = join(f.root, 'sentinel');
  writeFileSync(sentinel, 'preserve');
  unlinkSync(source);
  symlinkSync(sentinel, source);
  expect(() => runContinuousTask(f.root, 'primary', 'reference')).toThrow();
  expect(readFileSync(sentinel, 'utf8')).toBe('preserve');
  unlinkSync(source);
  linkSync(sentinel, source);
  expect(() => runContinuousTask(f.root, 'primary', 'reference')).toThrow();
  expect(readFileSync(sentinel, 'utf8')).toBe('preserve');
});
it('fails closed for altered suite versions and non-disposable roots', () => {
  const f = fixture();
  Object.assign(f, {
    continuous: { ...loadContinuousFixture(f.root).continuous, suite_digest: '0'.repeat(64) },
  });
  saveLearningFixture(f);
  expect(() => loadContinuousFixture(f.root)).toThrow();
  expect(() => loadContinuousFixture(process.cwd())).toThrow();
});
it('exports whitelisted bounded trace data and does not accept arbitrary transcript fields', () => {
  const f = fixture(),
    directory = join(f.root, 'traces');
  mkdirSync(directory);
  const t = new AcceptanceTrace('safe');
  const event = {
    stage: 'validation',
    principal: 'SERVICE' as const,
    input_id: null,
    output_id: null,
    content_digest: 'a'.repeat(64),
    evidence: 'CODE_OWNED_TEST',
    expected: 'PASS',
    actual: 'PASS',
    status: 'PASS' as const,
    transcript: 'DO_NOT_STORE',
  };
  t.record(event);
  t.export(directory, 'PASS');
  expect(readFileSync(join(directory, 'safe.json'), 'utf8')).not.toContain('DO_NOT_STORE');
  expect(() => t.record({ ...event, content_digest: 'tampered' })).toThrow();
  expect(() => t.record({ ...event, actual: 'x'.repeat(1025) })).toThrow();
  rmSync(directory, { recursive: true });
});
it('native evidence requires completed successful scoped MCP results rather than model prose or failed calls', () => {
  const event = {
    type: 'item.completed',
    item: {
      type: 'mcp_tool_call',
      server: 'agentmind',
      tool: 'learning_signal_record',
      status: 'completed',
      result: { content: [{ type: 'text', text: JSON.stringify({ id: 'reference-only' }) }] },
    },
  };
  const result = { exit_code: 0, failure: null, events: [event] };
  expect(continuousToolEvidence(result)).toEqual([
    { tool: 'learning_signal_record', id: 'reference-only' },
  ]);
  expect(continuousToolEvidence({ ...result, exit_code: 1 })).toEqual([]);
  expect(continuousToolEvidence({ ...result, failure: 'timeout' })).toEqual([]);
  for (const item of [
    { ...event.item, server: 'other' },
    { ...event.item, status: 'failed' },
    { ...event.item, error: {} },
    { ...event.item, result: { isError: true } },
    { type: 'agent_message', text: 'I learned successfully' },
  ]) {
    expect(continuousToolEvidence({ ...result, events: [{ ...event, item }] })).toEqual([]);
  }
});

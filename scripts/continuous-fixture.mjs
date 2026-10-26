// Code-owned finite acceptance fixtures. Never execute text obtained from an agent or skill.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUG,
  createLearningFixture,
  FIX,
  loadLearningFixture,
  saveLearningFixture,
  TEST,
} from './learning-fixture.mjs';
export const CONTINUOUS_SUITE = 'p3-007-boundary-fixtures-v1';
export const TRANSFER_BUG =
  'export function retryDelay(value, min, max) { return Math.min(value, max); }\n';
export const TRANSFER_FIX =
  'export function retryDelay(value, min, max) { return Math.min(Math.max(value, min), max); }\n';
export const TRANSFER_TEST = `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {retryDelay} from './retry-delay.mjs';
test('independent retry-delay inputs retain both bounds',()=>{
 assert.equal(retryDelay(-12,5,60),5);
 assert.equal(retryDelay(95,5,60),60);
 assert.equal(retryDelay(13,5,60),13);
 assert.equal(retryDelay(0,0,60),0);
});\n`;
const TASKS = {
  primary: { source: 'clamp.ts', test: 'clamp.test.mjs', bug: BUG, fix: FIX, tests: TEST },
  transfer: {
    source: 'retry-delay.mjs',
    test: 'retry-delay.test.mjs',
    bug: TRANSFER_BUG,
    fix: TRANSFER_FIX,
    tests: TRANSFER_TEST,
  },
};
export const continuousDigest = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
export const CONTINUOUS_SUITE_DIGEST = continuousDigest({ policy: CONTINUOUS_SUITE, tasks: TASKS });
function writeOwned(root, name, text) {
  const fd = openSync(
    join(root, name),
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1) throw Error('Unsafe fixture file.');
    ftruncateSync(fd, 0);
    writeFileSync(fd, text);
  } finally {
    closeSync(fd);
  }
}
export function prepareContinuousFixture() {
  const fixture = createLearningFixture();
  fixture.continuous = {
    schema: 1,
    suite: CONTINUOUS_SUITE,
    suite_digest: CONTINUOUS_SUITE_DIGEST,
    stage: 'task',
    native: 'NOT VERIFIED',
    capture: 'explicitly instructed; not natural learning',
    human_approval: 'NOT VERIFIED',
    cross_cli: 'NOT VERIFIED',
  };
  writeOwned(fixture.root, TASKS.transfer.source, TRANSFER_BUG);
  writeOwned(fixture.root, TASKS.transfer.test, TRANSFER_TEST);
  saveLearningFixture(fixture);
  return fixture;
}
export function loadContinuousFixture(root) {
  const f = loadLearningFixture(root);
  if (
    f.continuous?.schema !== 1 ||
    f.continuous.suite !== CONTINUOUS_SUITE ||
    f.continuous.suite_digest !== CONTINUOUS_SUITE_DIGEST
  )
    throw Error('Not a compatible continuous-learning fixture.');
  return f;
}
export function runContinuousTask(root, task, implementation) {
  loadContinuousFixture(root);
  const spec = TASKS[task];
  if (!spec || !['baseline', 'reference'].includes(implementation))
    throw Error('Unsupported controlled task.');
  writeOwned(root, spec.source, implementation === 'reference' ? spec.fix : spec.bug);
  writeOwned(root, spec.test, spec.tests);
  return verifyContinuousTask(root, task, implementation);
}
export function verifyContinuousTask(root, task, implementation = 'reference') {
  loadContinuousFixture(root);
  const spec = TASKS[task];
  if (!spec || !['baseline', 'reference'].includes(implementation))
    throw Error('Unsupported controlled task.');
  const source = implementation === 'reference' ? spec.fix : spec.bug;
  for (const [name, expected] of [
    [spec.source, source],
    [spec.test, spec.tests],
  ]) {
    const s = lstatSync(join(root, name));
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      s.nlink !== 1 ||
      readFileSync(join(root, name), 'utf8') !== expected
    )
      return {
        status: 'NOT VERIFIED',
        exit_code: null,
        reason: 'UNRECOGNIZED_SOURCE_OR_TEST',
        suite: CONTINUOUS_SUITE,
        suite_digest: CONTINUOUS_SUITE_DIGEST,
        source_digest: null,
        assertions: 4,
      };
  }
  // Execute only repository-owned constants in a fresh runner, never project/model bytes.
  const runner = mkdtempSync(join(tmpdir(), 'agentmind-continuous-check-'));
  let r;
  try {
    writeFileSync(join(runner, spec.source), source, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(runner, spec.test), spec.tests, { flag: 'wx', mode: 0o600 });
    r = spawnSync(process.execPath, ['--experimental-strip-types', '--test', spec.test], {
      cwd: runner,
      env: { PATH: process.env.PATH ?? '', HOME: runner, LANG: 'C' },
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 32768,
    });
  } finally {
    rmSync(runner, { recursive: true, force: true });
  }

  return {
    status: r.status === 0 ? 'PASS' : r.status === null ? 'NOT VERIFIED' : 'FAIL',
    exit_code: r.status,
    reason: r.error ? 'CONTROLLED_TEST_UNAVAILABLE' : null,
    suite: CONTINUOUS_SUITE,
    suite_digest: CONTINUOUS_SUITE_DIGEST,
    source_digest: continuousDigest(source),
    assertions: 4,
  };
}

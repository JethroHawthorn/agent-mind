// Code-owned harmless fixture. Never execute commands or files supplied by a skill.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export const BUG =
  'export function clamp(value: number, min: number, max: number): number { return Math.min(value, max); }\n';
export const FIX =
  'export function clamp(value: number, min: number, max: number): number { return Math.min(Math.max(value, min), max); }\n';
export const TEST = `import {test} from 'node:test';
import assert from 'node:assert/strict';
import {clamp} from './clamp.ts';
test('lower bound, upper bound, zero and in-range values',()=>{
  assert.equal(clamp(-4,0,10),0);
  assert.equal(clamp(14,0,10),10);
  assert.equal(clamp(0,0,10),0);
  assert.equal(clamp(6,0,10),6);
});\n`;
const MARKER = '.agentmind-e2e.json';
export function createLearningFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentmind-e2e-')));
  const data = {
    schema: 1,
    kind: 'agentmind-disposable-e2e',
    root,
    nonce: randomUUID(),
    name: 'clamp-bounds',
    created_at: new Date().toISOString(),
  };
  data.name = `agentmind-e2e-${data.nonce.slice(0, 8)}`;
  try {
    for (const directory of ['fake-home', 'other-project'])
      mkdirSync(join(root, directory), { mode: 0o700 });
    const git = spawnSync(
      'git',
      ['-c', 'init.templateDir=', '-c', 'core.hooksPath=/dev/null', 'init', '-q', root],
      { encoding: 'utf8', timeout: 5000 },
    );
    if (git.status !== 0) throw new Error('Cannot initialize disposable Git fixture.');
    writeFileSync(join(root, MARKER), JSON.stringify(data), { mode: 0o600 });
    writeFileSync(join(root, 'package.json'), ' {"type":"module","private":true}\n');
    writeFileSync(join(root, 'clamp.ts'), BUG);
    writeFileSync(join(root, 'clamp.test.mjs'), TEST);
    return data;
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
}
export function loadLearningFixture(root) {
  const canonical = realpathSync(root);
  if (
    resolve(root) !== canonical ||
    !basename(canonical).startsWith('agentmind-e2e-') ||
    !canonical.startsWith(`${realpathSync(tmpdir())}/`) ||
    lstatSync(join(canonical, MARKER)).isSymbolicLink()
  )
    throw new Error('Refusing a non-disposable verification root.');
  const value = JSON.parse(readFileSync(join(canonical, MARKER), 'utf8'));
  if (
    value.schema !== 1 ||
    value.kind !== 'agentmind-disposable-e2e' ||
    value.root !== canonical ||
    !/^[a-f0-9-]{36}$/.test(value.nonce) ||
    value.name !== `agentmind-e2e-${value.nonce.slice(0, 8)}`
  )
    throw new Error('Invalid disposable fixture marker.');
  return value;
}
export function saveLearningFixture(data) {
  loadLearningFixture(data.root);
  writeFileSync(join(data.root, MARKER), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}
export function cleanupLearningFixture(root) {
  const data = loadLearningFixture(root);
  rmSync(data.root, { recursive: true, force: true });
}
export function runLearningTest(root, fixed = false) {
  loadLearningFixture(root);
  // Only replace/run exact code-owned fixture files. No arbitrary command/module selector.
  writeFileSync(join(root, 'clamp.ts'), fixed ? FIX : BUG);
  writeFileSync(join(root, 'clamp.test.mjs'), TEST);
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--test', 'clamp.test.mjs'],
    { cwd: root, encoding: 'utf8', timeout: 5000 },
  );
  return {
    exit_code: result.status,
    passed: result.status === 0,
    expected: fixed ? 'PASS' : 'FAIL',
    test: 'lower/upper/zero/in-range clamp fixture',
  };
}
export function verifyLearningSolution(root) {
  loadLearningFixture(root);
  if (
    readFileSync(join(root, 'clamp.ts'), 'utf8') !== FIX ||
    readFileSync(join(root, 'clamp.test.mjs'), 'utf8') !== TEST
  )
    return {
      exit_code: null,
      passed: false,
      expected: 'PASS',
      test: 'exact code-owned solution required before execution',
    };
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--test', 'clamp.test.mjs'],
    { cwd: root, encoding: 'utf8', timeout: 5000 },
  );
  return {
    exit_code: result.status,
    passed: result.status === 0,
    expected: 'PASS',
    test: 'verified exact lower/upper/zero/in-range fixture',
  };
}
export function skillFixtureFiles(data, revision = 1) {
  return [
    {
      path: 'SKILL.md',
      content: `---\nname: ${data.name}\ndescription: Check lower and upper bounds in a numeric clamp utility\n---\n# Goal\nCorrect numeric clamping at both bounds.\n# When to use\nWhen a clamp utility ignores its lower bound.\n# Procedure\nInspect the failing lower-bound case. Use Math.min(Math.max(value, min), max). Read [fixture notes](references/notes.md).\n# Verification\nCheck lower-bound, upper-bound, zero and in-range cases. Report only observed results.\n${revision === 2 ? 'Also inspect already-clamped boundary values explicitly.\n' : ''}`,
    },
    {
      path: 'references/notes.md',
      content: `Verification marker CLAMP_${data.nonce}_V${revision}.\nRevision ${revision}; fixture tests are controlled by the verifier, not this skill.\n`,
    },
  ];
}

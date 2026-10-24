import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { skillFixture } from '../helpers/skill-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

it('atomically accepts only one competing active-pointer event from separate processes', async () => {
  const f = skillFixture();
  cleanup.push(f.close);
  const skill = f.identity();
  const versions = [f.version(skill), f.version(skill)];
  const approvals = versions.map((version) => {
    f.evaluation(version);
    return f.review(version);
  });
  const results = await Promise.all(
    versions.map(
      (version, index) =>
        new Promise<{ code: number | null; stderr: string }>((resolveResult, reject) => {
          const child = spawn(
            process.execPath,
            [
              resolve('tests/fixtures/skill-pointer.mjs'),
              f.path,
              JSON.stringify({
                id: randomUUID(),
                skill_id: skill,
                project_id: f.scope.id,
                from_version_id: null,
                to_version_id: version,
                approval_id: approvals[index],
                created_at: f.now(),
              }),
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
          );
          cleanup.push(() => {
            if (child.exitCode === null) child.kill('SIGKILL');
          });
          let stderr = '';
          child.stderr.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          child.stdout.resume();
          child.once('error', reject);
          child.once('close', (code) => resolveResult({ code, stderr }));
        }),
    ),
  );
  expect(results.map((result) => result.code).sort()).toEqual([0, 2]);
  expect(results.find((result) => result.code === 2)?.stderr).toContain('POINTER_CONFLICT');
  expect(versions).toContain(f.store.getIdentity(skill).active_version_id);
  expect(f.store.getIdentity(skill).revision).toBe(1);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_promotions').get()).toEqual({ n: 1 });
  expect(f.db.pragma('foreign_key_check')).toEqual([]);
});

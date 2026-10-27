import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { agentWrite } from '../../packages/core/src/write-transaction.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agentmind-retry-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'db.sqlite');
  const db = new Database(path);
  cleanup.push(() => db.close());
  db.exec('CREATE TABLE events(id INTEGER PRIMARY KEY)');
  db.pragma('busy_timeout=1234');
  return { db, root, path };
}
it('retries transient real-process writer contention and commits exactly once', async () => {
  const { db, root, path } = fixture();
  const ready = join(root, 'ready');
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    const DB=require('better-sqlite3'),fs=require('node:fs');
    const db=new DB(process.argv[1]); db.exec('BEGIN IMMEDIATE');
    fs.writeFileSync(process.argv[2], 'ready');
    setTimeout(()=>{db.exec('ROLLBACK');db.close()},280);
  `,
      path,
      ready,
    ],
    { stdio: 'ignore' },
  );
  cleanup.push(() => child.kill());
  const finished = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(Error(`child exit ${code}`))));
  });
  const deadline = Date.now() + 5000;
  while (!existsSync(ready) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(existsSync(ready)).toBe(true);
  let calls = 0;
  agentWrite(db, () => {
    calls++;
    db.prepare('INSERT INTO events VALUES(1)').run();
  });
  await finished;
  expect(calls).toBe(1);
  expect(db.prepare('SELECT * FROM events').all()).toEqual([{ id: 1 }]);
  expect(db.pragma('busy_timeout', { simple: true })).toBe(1234);
});
it('exhausts retries within a bounded interval, preserves data and restores timeout', () => {
  const { db, path } = fixture();
  const blocker = new Database(path);
  cleanup.push(() => blocker.close());
  blocker.exec('BEGIN IMMEDIATE');
  const start = performance.now();
  expect(() => agentWrite(db, () => db.exec('INSERT INTO events VALUES(1)'))).toThrow();
  expect(performance.now() - start).toBeLessThan(2000);
  blocker.exec('ROLLBACK');
  expect(db.prepare('SELECT * FROM events').all()).toEqual([]);
  expect(db.pragma('busy_timeout', { simple: true })).toBe(1234);
});
it('rolls back callback failure without replay, even if it reports BUSY', () => {
  const { db } = fixture();
  let calls = 0;
  expect(() =>
    agentWrite(db, () => {
      calls++;
      db.exec('INSERT INTO events VALUES(1)');
      throw Object.assign(Error('busy'), { code: 'SQLITE_BUSY' });
    }),
  ).toThrow('busy');
  expect(calls).toBe(1);
  expect(db.prepare('SELECT * FROM events').all()).toEqual([]);
  let failed = 0;
  expect(() =>
    agentWrite(db, () => {
      failed++;
      throw Error('unrelated');
    }),
  ).toThrow('unrelated');
  expect(failed).toBe(1);
  expect(db.pragma('busy_timeout', { simple: true })).toBe(1234);
});
it('nested transactions never independently replay partially executed operations', () => {
  const { db } = fixture();
  let calls = 0;
  expect(() =>
    db
      .transaction(() =>
        agentWrite(db, () => {
          calls++;
          db.exec('INSERT INTO events VALUES(1)');
          throw Object.assign(Error('busy'), { code: 'SQLITE_BUSY' });
        }),
      )
      .immediate(),
  ).toThrow('busy');
  expect(calls).toBe(1);
  expect(db.inTransaction).toBe(false);
  expect(db.prepare('SELECT * FROM events').all()).toEqual([]);
});

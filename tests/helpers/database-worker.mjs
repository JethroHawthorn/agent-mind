// Trusted disposable multi-process harness. Never runs candidate content.
import fs, { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import Database from 'better-sqlite3';
import {
  backupDatabase,
  MemoryService,
  migrate,
  openDatabase,
  rebuildDatabaseIndexes,
  resolveProject,
} from '../../packages/core/dist/index.js';

const [action, path, root, label = 'worker'] = process.argv.slice(2);
if (
  ![
    'write',
    'read',
    'migrate',
    'kill-transaction',
    'kill-migration',
    'lock',
    'kill-index',
    'kill-backup',
  ].includes(action)
)
  throw new Error('Invalid fixture action');
if (action === 'kill-backup') {
  const link = fs.linkSync;
  fs.linkSync = (from, to) => {
    link(from, to);
    if (String(to).endsWith('/registry.sqlite')) process.kill(process.pid, 'SIGKILL');
  };
  syncBuiltinESMExports();
  await backupDatabase(path, label);
} else if (action === 'kill-migration') {
  const db = new Database(path);
  migrate(db, () => {
    db.exec('CREATE TABLE interrupted_migration(id)');
    process.kill(process.pid, 'SIGKILL');
  });
} else if (action === 'kill-index') {
  // Kill between DELETE and rebuild INSERT inside the real maintenance transaction.
  const exec = Database.prototype.exec;
  Database.prototype.exec = function (sql) {
    if (sql.startsWith('DELETE FROM skill_version_retrieval_fts')) {
      exec.call(this, 'DELETE FROM skill_version_retrieval_fts');
      process.kill(process.pid, 'SIGKILL');
    }
    return exec.call(this, sql);
  };
  rebuildDatabaseIndexes(path);
} else {
  const db = openDatabase(path);
  const service = new MemoryService(
    db,
    resolveProject(root, root),
    label === 'reader' ? 'gemini' : 'codex',
  );
  if (action === 'write') {
    for (let n = 0; n < 60; n++)
      service.save({
        kind: 'fact',
        title: `${label} record ${n}`,
        content: 'reproducible concurrency canary',
      });
  } else if (action === 'read') {
    for (let n = 0; n < 80; n++) service.search({ query: 'concurrency', limit: 5 });
  } else if (action === 'kill-transaction' || action === 'lock') {
    db.exec('BEGIN IMMEDIATE');
    service.save({
      kind: 'fact',
      title: 'uncommitted sentinel',
      content: 'must disappear after crash',
    });
    if (action === 'kill-transaction') process.kill(process.pid, 'SIGKILL');
    writeFileSync(`${path}.ready`, 'locked');
    setInterval(() => {}, 1000);
  }
  if (action !== 'lock') db.close();
}

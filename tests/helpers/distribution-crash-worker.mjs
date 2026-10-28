// Trusted disposable fault harness, not a production fault flag or candidate script runner.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  confirmOperatorReview,
  openDatabase,
  SkillDistributionService,
} from '../../packages/core/dist/index.js';

const [root, database, home, skill, point] = process.argv.slice(2);
if (
  !root ||
  !database ||
  !home ||
  !skill ||
  !['after-publish', 'after-backup', 'before-final-status'].includes(point)
)
  throw Error('Invalid fixture arguments');
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  rename(from, to);
  if (
    (point === 'after-publish' && String(from).endsWith('.stage')) ||
    (point === 'after-backup' && String(to).endsWith('.backup'))
  )
    process.kill(process.pid, 'SIGKILL');
};
syncBuiltinESMExports();
const { resolveProject } = await import('../../packages/core/dist/index.js');
const db = openDatabase(database),
  service = new SkillDistributionService(db, resolveProject(root, process.cwd()), home);
if (point === 'before-final-status') {
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    if (sql.includes('UPDATE skill_distribution_intents SET status='))
      process.kill(process.pid, 'SIGKILL');
    return prepare(sql);
  };
}
const request = { skill_id: skill, target: 'codex', scope: 'project', operation: 'sync' };
try {
  service.commit(request, await confirmOperatorReview(service.plan(request)));
} finally {
  db.close();
}

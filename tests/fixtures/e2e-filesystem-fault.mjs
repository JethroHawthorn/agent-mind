// TEST ONLY: fault the owned disposable installer process, never authorize an operation.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadLearningFixture } from '../../scripts/learning-fixture.mjs';

const args = process.argv.slice(2);
const index = args.indexOf('--e2e-fault');
const fault = args[index + 1];
if (index < 0 || !['permission', 'interrupted'].includes(fault))
  throw new Error('Unknown test fault.');
args.splice(index, 2);
const root = args[args.indexOf('--project-root') + 1];
loadLearningFixture(root);
const mkdir = fs.mkdirSync;
const rename = fs.renameSync;
if (fault === 'permission')
  fs.mkdirSync = (path, ...rest) => {
    if (
      String(path).startsWith(`${root}/.agentmind/distribution-v1/`) &&
      String(path).endsWith('.stage')
    ) {
      const error = new Error('Disposable EACCES fixture');
      error.code = 'EACCES';
      throw error;
    }
    return mkdir(path, ...rest);
  };
if (fault === 'interrupted')
  fs.renameSync = (source, target) => {
    if (
      String(source).startsWith(`${root}/.agentmind/distribution-v1/`) &&
      String(source).endsWith('.stage')
    )
      process.kill(process.pid, 'SIGKILL');
    return rename(source, target);
  };
syncBuiltinESMExports();
const entry = new URL('../../packages/mcp-server/dist/skill-distribute.js', import.meta.url);
process.argv = [process.execPath, fileURLToPath(entry), ...args];
await import(entry.href);

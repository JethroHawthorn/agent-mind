// Explicit network/native dependency installation into a disposable global prefix.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = realpathSync(mkdtempSync(join(tmpdir(), 'agentmind-global-')));
for (const directory of ['home', 'prefix', 'cache', 'project'])
  mkdirSync(join(work, directory), { mode: 0o700 });
const env = {
  PATH: process.env.PATH,
  HOME: join(work, 'home'),
  npm_config_cache: join(work, 'cache'),
  npm_config_prefix: join(work, 'prefix'),
  npm_config_userconfig: join(work, 'empty.npmrc'),
  npm_config_globalconfig: join(work, 'empty-global.npmrc'),
};
writeFileSync(env.npm_config_userconfig, '');
writeFileSync(env.npm_config_globalconfig, '');
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 300000,
    ...options,
  });
  if (result.status !== 0)
    throw Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
try {
  const metadata = JSON.parse(run('npm', ['pack', '--pack-destination', work, '--json']));
  const archive = join(work, metadata[0].filename);
  const installLog = run('npm', ['install', '--global', '--no-audit', '--no-fund', archive], {
    cwd: join(work, 'project'),
  });
  writeFileSync(join(work, 'install.log'), installLog);
  for (const item of ['.agentmind', '.codex', '.claude', '.gemini']) {
    if (existsSync(join(work, 'home', item)) || existsSync(join(work, 'project', item)))
      throw Error('UNEXPECTED_INSTALL_CONFIGURATION');
  }
  const result = run(
    process.execPath,
    [
      join(root, 'node_modules/vitest/vitest.mjs'),
      'run',
      'tests/integration/global-cli.test.ts',
      '--maxWorkers=1',
    ],
    { env: { ...process.env, AGENTMIND_GLOBAL_PREFIX: join(work, 'prefix') } },
  );
  writeFileSync(join(work, 'test-results.txt'), result);
  writeFileSync(join(work, 'pack.json'), JSON.stringify(metadata, null, 2));
  console.log(result);
  console.log(`Evidence retained: ${work}`);
} catch (error) {
  console.error(String(error));
  console.error(`Incomplete evidence: ${work}`);
  process.exitCode = 1;
}

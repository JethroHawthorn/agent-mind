import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import {
  runnerCommand,
  runnerEnvironment,
  validateRunnerPolicy,
} from '../../packages/core/src/index.js';

it.each(['codex', 'claude', 'gemini'] as const)(
  'executes an offline %s Node-entry contract under sanitized environment, not native model verification',
  (cli) => {
    const root = mkdtempSync(join(tmpdir(), 'protected-cli-env-'));
    try {
      mkdirSync(join(root, 'modules'));
      writeFileSync(join(root, 'modules', 'provider.cjs'), 'exports.value="fixture-only";');
      const entry = join(root, 'cli.cjs');
      writeFileSync(
        entry,
        'console.log(JSON.stringify({dependency:require("./modules/provider.cjs").value,args:process.argv.slice(2),home:process.env.HOME,node:process.env.PATH.split(":")[0],forwarded:process.env.ANTHROPIC_AUTH_TOKEN??null,ssh:process.env.SSH_AUTH_SOCK??null}));',
      );
      const policy = validateRunnerPolicy({
        schema_version: 1,
        runner_uid: 203,
        broker_uid: 201,
        operator_uids: [202],
        allowed_gids: [303],
        home: root,
        workspace: root,
        helper: '/root/helper',
        client_config: '/root/client',
        executables: { [cli]: { node_entry: entry } },
      });
      const spec = runnerCommand(policy, cli);
      const env = runnerEnvironment(policy);
      expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TERM']);
      const r = spawnSync(spec.command, [...spec.prefix_args, 'literal;$(never-execute)'], {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 3000,
      });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({
        dependency: 'fixture-only',
        args: ['literal;$(never-execute)'],
        home: root,
        node: dirname(process.execPath),
        forwarded: null,
        ssh: null,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
it('rejects node command flags or shell wrappers supplied as structured configuration', () => {
  const base = {
    schema_version: 1,
    runner_uid: 203,
    broker_uid: 201,
    operator_uids: [202],
    allowed_gids: [303],
    home: '/h',
    workspace: '/w',
    helper: '/helper',
    client_config: '/client',
  };
  for (const value of [
    { node_entry: '../escape' },
    { node_entry: '/cli.js', args: ['--eval', 'bad'] },
    { command: 'sh', script: 'bad' },
  ])
    expect(() => validateRunnerPolicy({ ...base, executables: { gemini: value } })).toThrow();
});

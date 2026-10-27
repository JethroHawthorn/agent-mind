#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { loadRunnerPolicy, runnerEnvironment } from '@agentmind/core';

try {
  const split = process.argv.indexOf('--');
  const { values } = parseArgs({
    args: process.argv.slice(2, split < 0 ? undefined : split),
    strict: true,
    allowPositionals: false,
    options: {
      policy: { type: 'string' },
      cli: { type: 'string' },
      check: { type: 'boolean' },
      probe: { type: 'boolean' },
    },
  });
  if (!values.policy || !['codex', 'claude', 'gemini'].includes(values.cli ?? '')) throw Error();
  const { policy, command, prefix_args } = loadRunnerPolicy(
    values.policy,
    values.cli as 'codex' | 'claude' | 'gemini',
  );
  if (values.check && values.probe) throw Error('Choose check or probe.');
  if (values.probe) {
    const result = spawnSync(command, [...prefix_args, '--version'], {
      cwd: policy.workspace,
      env: runnerEnvironment(policy),
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 8192,
    });
    const success = result.status === 0;
    process.stdout.write(
      `${JSON.stringify({ schema_version: 1, cli: values.cli, uid: process.getuid?.(), version_probe: success ? 'PASS' : 'FAIL', version: success ? (result.stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? null) : null, model_execution: 'NOT_VERIFIED', protected_native_workflow: 'NOT_VERIFIED' })}\n`,
    );
    process.exitCode = success ? 0 : 1;
  } else if (values.check)
    process.stdout.write(
      `${JSON.stringify({
        schema_version: 1,
        identity_check: 'PASS',
        uid: process.getuid?.(),
        deployment: 'NOT_VERIFIED',
        delegated_privilege_audit: 'NOT_VERIFIED',
        cli: values.cli,
      })}\n`,
    );
  else {
    // No token/environment copying; CLI authenticates using its own restricted home.
    const child = spawn(
      command,
      [...prefix_args, ...(split < 0 ? [] : process.argv.slice(split + 1))],
      {
        cwd: policy.workspace,
        env: runnerEnvironment(policy),
        stdio: ['inherit', 'inherit', 'inherit'],
      },
    );
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.on(signal, () => child.kill(signal));
    child.on('error', () => {
      process.stderr.write('PROTECTED_RUNNER_LAUNCH_DENIED\n');
      process.exitCode = 1;
    });
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
    });
  }
} catch {
  process.stderr.write(
    'PROTECTED_RUNNER_DENIED: use an enrolled restricted account and its own session; no identity switching or fallback.\n',
  );
  process.exitCode = 1;
}

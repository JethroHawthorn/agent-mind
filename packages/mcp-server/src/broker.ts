#!/usr/bin/env node
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { chmodSync, chownSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import {
  BrokerService,
  checkPublication,
  checkRegistry,
  loadProtectedConfig,
  openDatabase,
  required,
  safeError,
  verifyPaths,
} from '@agentmind/core';

async function main() {
  process.umask(0o077);
  const { values } = parseArgs({
    options: { config: { type: 'string' }, preflight: { type: 'boolean' } },
    strict: true,
    allowPositionals: false,
  });
  if (!values.config) throw new Error('Protected --config is required.');
  const config = loadProtectedConfig(values.config, values.preflight ? 'preflight' : 'start');
  const helper = join(config.runtime_root, 'native/bin/agentmind-peer');
  for (const project of config.projects)
    if (project.distribution === 'protected') checkPublication(config, project, helper);
  if (values.preflight) {
    console.log(
      JSON.stringify({
        preflight: 'PASS',
        read_only: true,
        os_isolation_acceptance: 'NOT VERIFIED',
        deployed: false,
      }),
    );
    return;
  }
  const operatorDirectory = join(config.socket_directory, 'operator');
  try {
    mkdirSync(operatorDirectory, { mode: 0o700 });
    chownSync(operatorDirectory, -1, required(config.operator_gid));
    chmodSync(operatorDirectory, 0o710);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const operatorStat = lstatSync(operatorDirectory);
  if (
    !operatorStat.isDirectory() ||
    operatorStat.isSymbolicLink() ||
    operatorStat.uid !== config.broker_uid ||
    operatorStat.gid !== config.operator_gid ||
    (operatorStat.mode & 0o777) !== 0o710
  )
    throw new Error('Unsafe operator directory');
  verifyPaths(helper, [operatorDirectory]);
  const db = openDatabase(join(config.registry_directory, 'registry.db'));
  const broker = new BrokerService(db, config, helper);
  checkRegistry(config, helper);
  const children: ChildProcessWithoutNullStreams[] = [];
  const sockets = new Map<string, { dev: number; ino: number }>();
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    for (const child of children) child.kill('SIGTERM');
    for (const [path, identity] of sockets) {
      try {
        const s = lstatSync(path);
        if (
          s.isSocket() &&
          s.uid === config.broker_uid &&
          s.dev === identity.dev &&
          s.ino === identity.ino
        )
          unlinkSync(path);
      } catch {}
    }
    db.close();
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
  for (const channel of ['agent', 'operator'] as const) {
    const path =
      channel === 'operator'
        ? join(operatorDirectory, 'operator.sock')
        : join(config.socket_directory, 'agent.sock');
    const child = spawn(helper, ['listen', path, channel === 'operator' ? '0660' : '0666'], {
      env: {},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    child.stdin.on('error', () => {});
    child.stderr.resume();
    child.on('error', () => {
      process.exitCode = 1;
      close();
    });
    child.on('exit', () => {
      if (!closing) {
        console.error('[agentmind] BROKER_TRANSPORT_STOPPED');
        process.exitCode = 1;
        close();
      }
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let ready = false;
    lines.on('line', (line) => {
      if (closing) return;
      try {
        if (line.length > 262400) throw new Error('frame limit');
        const frame = JSON.parse(line) as {
          ready?: boolean;
          uid?: number;
          gid?: number;
          hex?: string;
        };
        if (!ready) {
          if (frame.ready !== true) throw new Error('transport initialization');
          ready = true;
          const s = lstatSync(path);
          if (!s.isSocket() || s.uid !== config.broker_uid) throw new Error('socket substitution');
          sockets.set(path, { dev: s.dev, ino: s.ino });
          console.error(`[agentmind] BROKER_${channel.toUpperCase()}_READY`);
          return;
        }
        if (
          typeof frame.uid !== 'number' ||
          typeof frame.gid !== 'number' ||
          !Number.isSafeInteger(frame.uid) ||
          !Number.isSafeInteger(frame.gid) ||
          typeof frame.hex !== 'string' ||
          !/^([0-9a-f]{2}){1,131072}$/.test(frame.hex)
        )
          throw new Error('transport credentials');
        checkRegistry(config, helper);
        const request: unknown = JSON.parse(Buffer.from(frame.hex, 'hex').toString('utf8'));
        const result = broker.handle(channel, { uid: frame.uid, gid: frame.gid }, request);
        const response = JSON.stringify({ ok: true, result });
        if (Buffer.byteLength(response) > 1048575) throw new Error('response limit');
        child.stdin.write(`${response}\n`);
      } catch (error) {
        const failure = safeError(error);
        console.error(`[agentmind] BROKER_REQUEST_FAILED ${failure.code}`);
        child.stdin.write(
          `${JSON.stringify({ ok: false, error: { code: 'BROKER_DENIED', message: 'Request denied or unavailable; inspect protected operator diagnostics.' } })}\n`,
        );
      }
    });
  }
}
main().catch((error) => {
  const failure = safeError(error);
  console.error(`[agentmind] PROTECTED_BROKER_STARTUP_DENIED ${failure.code}: ${failure.message}`);
  process.exitCode = 1;
});

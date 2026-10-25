// Invoked only by the explicit administrator-run disposable OS test harness, after setuid/setgroups.

import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, renameSync } from 'node:fs';
import { brokerRequest, loadBrokerClient } from '../../packages/core/dist/index.js';

const job = JSON.parse(readFileSync(0, 'utf8'));
if (job.kind === 'rpc') {
  try {
    console.log(
      JSON.stringify({
        ok: true,
        result: await brokerRequest(loadBrokerClient(job.client), job.channel, job.request),
      }),
    );
  } catch {
    console.log(JSON.stringify({ ok: false }));
  }
} else if (job.kind === 'deny-write' || job.kind === 'deny-read') {
  try {
    const fd = openSync(job.path, job.kind === 'deny-write' ? 'r+' : 'r');
    closeSync(fd);
    console.log(JSON.stringify({ denied: false }));
  } catch (e) {
    console.log(JSON.stringify({ denied: ['EACCES', 'EPERM'].includes(e.code) }));
  }
} else if (job.kind === 'deny-replace') {
  try {
    renameSync(job.path, `${job.path}.attack`);
    console.log(JSON.stringify({ denied: false }));
  } catch (e) {
    console.log(JSON.stringify({ denied: ['EACCES', 'EPERM'].includes(e.code) }));
  }
} else if (job.kind === 'read-copy') {
  try {
    console.log(JSON.stringify({ ok: true, text: readFileSync(job.path, 'utf8') }));
  } catch {
    console.log(JSON.stringify({ ok: false }));
  }
} else if (job.kind === 'pty') {
  const r = spawnSync(
    '/usr/bin/script',
    [
      '-q',
      '/dev/null',
      process.execPath,
      job.operator,
      '--client-config',
      job.client,
      '--project',
      'a',
      '--request',
      job.requestFile,
    ],
    { encoding: 'utf8', timeout: 7000, maxBuffer: 8192, env: {} },
  );
  console.log(
    JSON.stringify({
      denied:
        r.stdout?.includes('BROKER_OPERATOR_DENIED') === true ||
        r.stderr?.includes('BROKER_OPERATOR_DENIED') === true,
    }),
  );
} else throw new Error('Unsupported isolated test action.');

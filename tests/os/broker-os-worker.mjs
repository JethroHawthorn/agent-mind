// Administrator-authorized disposable fixture only. No transcript/environment ingestion.
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { createConnection } from 'node:net';
import { brokerRequest, loadBrokerClient } from '../../packages/core/dist/index.js';

const raw = readFileSync(0, 'utf8');
if (Buffer.byteLength(raw) > 131072) throw Error('Worker input limit');
const job = JSON.parse(raw);
const emit = (r) =>
  console.log(
    JSON.stringify({
      ...r,
      executing_uid: process.getuid(),
      executing_euid: process.geteuid(),
      operation: job.kind,
    }),
  );
if (job.kind === 'rpc') {
  try {
    emit({
      ok: true,
      result: await brokerRequest(loadBrokerClient(job.client), job.channel, job.request),
      rejection_layer: null,
    });
  } catch {
    emit({ ok: false, rejection_layer: 'UNDETERMINED_IPC_OR_APPLICATION' });
  }
} else if (['deny-write', 'deny-read', 'deny-replace', 'deny-symlink'].includes(job.kind)) {
  try {
    if (job.kind === 'deny-replace') renameSync(job.path, `${job.path}.attack`);
    else if (job.kind === 'deny-symlink') {
      symlinkSync('/dev/null', job.path);
      unlinkSync(job.path);
    } else {
      const fd = openSync(job.path, job.kind === 'deny-write' ? 'r+' : 'r');
      closeSync(fd);
    }
    emit({ denied: false, rejection_layer: null });
  } catch (e) {
    emit({
      denied: ['EACCES', 'EPERM'].includes(e.code),
      error_code: e.code,
      rejection_layer: ['EACCES', 'EPERM'].includes(e.code) ? 'OS_PERMISSION' : 'OTHER_ERROR',
    });
  }
} else if (job.kind === 'deny-connect') {
  const s = createConnection(job.path);
  s.setTimeout(3000, () => {
    s.destroy();
    emit({ denied: false, error_code: 'TIMEOUT', rejection_layer: 'UNDETERMINED' });
  });
  s.on('connect', () => {
    s.end();
    emit({ denied: false, rejection_layer: null });
  });
  s.on('error', (e) =>
    emit({
      denied: ['EACCES', 'EPERM'].includes(e.code),
      error_code: e.code,
      rejection_layer: ['EACCES', 'EPERM'].includes(e.code) ? 'OS_PERMISSION' : 'OTHER_ERROR',
    }),
  );
} else if (job.kind === 'read-copy') {
  try {
    emit({ ok: true, text: readFileSync(job.path, 'utf8') });
  } catch {
    emit({ ok: false });
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
    {
      encoding: 'utf8',
      timeout: 7000,
      maxBuffer: 8192,
      env: { APPROVED_BY: 'operator', AGENTMIND_PROTECTED: 'true' },
    },
  );
  emit({
    denied:
      r.stdout?.includes('BROKER_OPERATOR_DENIED') === true ||
      r.stderr?.includes('BROKER_OPERATOR_DENIED') === true,
    rejection_layer: 'APPLICATION_WITH_OS_PEER_CHECK',
    timed_out: r.error?.code === 'ETIMEDOUT',
  });
} else throw Error('Unsupported isolated action');

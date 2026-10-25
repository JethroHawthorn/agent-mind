import { spawn } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { denied, verifyPaths } from './policy.js';

const clientSchema = z.strictObject({
  schema_version: z.literal(1),
  broker_uid: z.number().int().positive(),
  helper: z.string().startsWith('/'),
  socket_directory: z.string().startsWith('/'),
});
export type BrokerClientConfig = z.infer<typeof clientSchema>;
export function loadBrokerClient(path: string): BrokerClientConfig {
  if (process.platform !== 'darwin')
    denied('Protected broker clients currently support macOS only.');
  const protect = (file: string, owners: number[]) => {
    if (realpathSync(file) !== file) denied('Unsafe broker client path.');
    for (let p = file; ; p = dirname(p)) {
      const s = lstatSync(p);
      if (!owners.includes(s.uid) || s.mode & 0o6022 || s.isSymbolicLink())
        denied('Unsafe broker client ownership.');
      if (p === dirname(p)) break;
    }
  };
  protect(path, [0]);
  if (lstatSync(path).size > 32768) denied();
  const c = clientSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  protect(c.helper, [0]);
  protect(c.socket_directory, [0, c.broker_uid]);
  const paths = [path, c.helper, c.socket_directory];
  for (const file of [...paths])
    for (let p = dirname(file); ; p = dirname(p)) {
      paths.push(p);
      if (p === dirname(p)) break;
    }
  verifyPaths(c.helper, [...new Set(paths)]);
  return c;
}
/** Native client authenticates the server UID before sending any review/confirmation. */
export function brokerRequest(
  c: BrokerClientConfig,
  channel: 'agent' | 'operator',
  request: unknown,
): Promise<unknown> {
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 131072) denied('Broker request exceeds limit.');
  return new Promise((resolve, reject) => {
    const child = spawn(
      c.helper,
      [
        'request',
        channel === 'operator'
          ? `${c.socket_directory}/operator/operator.sock`
          : `${c.socket_directory}/agent.sock`,
        String(c.broker_uid),
      ],
      { env: {}, stdio: ['pipe', 'pipe', 'ignore'] },
    );
    let bytes = 0;
    const parts: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), 21000);
    child.stdout.on('data', (b: Buffer) => {
      bytes += b.length;
      if (bytes > 1048576) child.kill('SIGKILL');
      else parts.push(b);
    });
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('BROKER_UNAVAILABLE'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('BROKER_UNAVAILABLE'));
      try {
        const r = JSON.parse(Buffer.concat(parts).toString('utf8')) as {
          ok: boolean;
          result: unknown;
        };
        if (r.ok !== true) throw new Error('BROKER_REQUEST_DENIED');
        resolve(r.result);
      } catch {
        reject(new Error('BROKER_REQUEST_DENIED'));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(`${input}\n`);
  });
}

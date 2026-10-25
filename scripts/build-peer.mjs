import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

if (process.platform !== 'darwin') throw new Error('Unsupported peer credential platform.');
mkdirSync('native/bin', { recursive: true });
const args = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror'];
// Optional explicit SDK for hosts whose default SDK/linker pairing is incompatible. No automatic fallback.
if (process.argv[2]) args.push('-isysroot', resolve(process.argv[2]));
args.push('native/peer.c', '-o', 'native/bin/agentmind-peer');
const result = spawnSync('cc', args, { stdio: 'inherit' });
process.exitCode = result.status ?? 1;

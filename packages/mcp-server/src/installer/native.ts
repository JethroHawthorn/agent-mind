import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Provider } from './model.js';
/** Reuse marked-disposable native harnesses; explicit model opt-in only. Never reflect raw output. */
export async function nativeDoctor(id: Provider, script: string, timeoutMs = 45000) {
  if (!existsSync(script))
    return { cli: id, status: 'NOT_VERIFIED', reason: 'NATIVE_HARNESS_UNAVAILABLE' };
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [script, '--probe', '--scenario', 'A', '--native-timeout-seconds', '30'],
      {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      },
    );
    let out = '',
      bytes = 0,
      timed = false;
    const stop = () => {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* already stopped */
      }
    };
    const cancel = () => {
      timed = true;
      stop();
    };
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    const release = () => {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    };
    const timer = setTimeout(
      () => {
        timed = true;
        stop();
      },
      Math.max(10, Math.min(45000, timeoutMs)),
    );
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length;
      if (bytes > 262144) stop();
      else out += data.toString('utf8');
    });
    child.stderr.on('data', () => {});
    child.on('error', () => {
      clearTimeout(timer);
      release();
      resolve({ cli: id, status: 'NOT_VERIFIED', reason: 'NATIVE_LAUNCH_FAILED' });
    });
    child.on('close', () => {
      clearTimeout(timer);
      release();
      let pass = false,
        ran = false;
      try {
        const r = JSON.parse(out.trim());
        pass = (r.native_scenarios ?? r.scenarios)?.A === 'PASS';
        ran =
          r.reason === 'CORRELATED_NATIVE_EVIDENCE' ||
          r.reason === 'MISSING_CORRELATED_EVIDENCE' ||
          pass;
      } catch {
        /* No native evidence inferred from exit code or prose. */
      }
      resolve({
        cli: id,
        status: timed || !ran ? 'NOT_VERIFIED' : pass ? 'PASS' : 'FAIL',
        reason: timed
          ? 'NATIVE_TIMEOUT'
          : pass
            ? 'HARNESS_CORRELATED_SCENARIO_A'
            : 'NATIVE_EVIDENCE_INCOMPLETE',
        evidence: ran ? 'NATIVE_AUTHENTICATED' : 'INSPECTION',
        router_discovery: 'NOT_VERIFIED',
        router_use: 'NOT_VERIFIED',
        note: 'Scenario A only; disposable fixtures may remain for inspection. No approval or skill-use proof is inferred.',
      });
    });
  });
}

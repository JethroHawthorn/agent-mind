import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { codexDiscoveryEvidence } from './skills-evidence.mjs';

export function nativeTimeoutMs(value) {
  if (value === undefined) return 40000;
  if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) < 5 || Number(value) > 180)
    throw new Error('Native timeout must be 5–180 whole seconds.');
  return Number(value) * 1000;
}
function progressSummary(output) {
  const progress = {
    json_events: 0,
    initializations: 0,
    tool_calls: 0,
    tool_results: 0,
    final_results: 0,
    result_errors: 0,
  };
  const calls = new Set();
  const results = new Set();
  for (const line of output.split('\n')) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
    progress.json_events++;
    if (event.type === 'system' && event.subtype === 'init') progress.initializations++;
    if (event.type === 'result') {
      progress.final_results++;
      if (event.is_error === true) progress.result_errors++;
    }
    for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use' && typeof block.id === 'string') calls.add(block.id);
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string')
        results.add(block.tool_use_id);
    }
    if (event.item?.type === 'mcp_tool_call' && typeof event.item.id === 'string') {
      calls.add(event.item.id);
      if (event.type === 'item.completed') results.add(event.item.id);
    }
  }
  progress.tool_calls = calls.size;
  progress.tool_results = results.size;
  return progress;
}

/** @param {Record<string, string | undefined> | undefined} [env] */
export function nativeProcess(command, args, root, timeoutMs = 40000, env = undefined) {
  return new Promise((resolve) => {
    const started = Date.now();
    const c = spawn(command, args, {
      cwd: root,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let diagnostic = '';
    let failure = null;
    c.stdout.setEncoding('utf8');
    c.stderr.setEncoding('utf8');
    const stop = () => {
      try {
        if (process.platform !== 'win32' && c.pid) process.kill(-c.pid, 'SIGKILL');
        else c.kill('SIGKILL');
      } catch {
        /* already exited */
      }
    };
    const timer = setTimeout(() => {
      failure = 'timeout';
      stop();
    }, timeoutMs);
    c.stdout.on('data', (d) => {
      output += d;
      if (output.length > 4 * 1024 * 1024) {
        failure = 'output_limit';
        stop();
      }
    });
    c.stderr.on('data', (d) => {
      if (diagnostic.length < 65536) diagnostic += String(d).slice(0, 65536 - diagnostic.length);
    });
    c.once('error', () => {
      failure = 'unavailable';
    });
    c.once('close', (code, signal) => {
      clearTimeout(timer);
      stop();
      let events = [];
      if (code === 0 && !failure) {
        try {
          events = output
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l));
        } catch {
          failure = 'unsupported_json_output';
        }
      }
      const category =
        failure ??
        (code === 0
          ? null
          : /operation not permitted|EPERM|EACCES|permission denied/i.test(diagnostic)
            ? 'local_permissions'
            : /unauthorized|not logged in|authentication|401/i.test(diagnostic + output)
              ? 'native_authentication'
              : 'native_configuration_or_connectivity');
      resolve({
        exit_code: code,
        signal,
        failure: category,
        events,
        elapsed_ms: Math.max(0, Date.now() - started),
        timeout_ms: timeoutMs,
        progress: progressSummary(output),
      });
    });
  });
}
/** @param {Record<string, string | undefined> | undefined} [env] */
export function discoverCodex(root, name, path, env = undefined) {
  return new Promise((resolve) => {
    const c = spawn('codex', ['app-server', '--stdio'], {
      cwd: root,
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let done = false;
    let size = 0;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (process.platform !== 'win32' && c.pid) process.kill(-c.pid, 'SIGKILL');
        else c.kill();
      } catch {
        /* exited */
      }
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ discovery: 'NOT VERIFIED', failure: 'app_server_timeout' }),
      10000,
    );
    c.stderr.on('data', () => {});
    createInterface({ input: c.stdout }).on('line', (line) => {
      size += line.length;
      if (size > 4 * 1024 * 1024) {
        finish({ discovery: 'NOT VERIFIED', failure: 'output_limit' });
        return;
      }
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        finish({ discovery: 'NOT VERIFIED', failure: 'unsupported_protocol' });
        return;
      }
      if (r.id === 1 && r.result) {
        c.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
        c.stdin.write(
          `${JSON.stringify({ id: 2, method: 'skills/list', params: { cwds: [root], forceReload: true } })}\n`,
        );
      }
      if (r.id === 2) {
        try {
          finish(codexDiscoveryEvidence(r.result, root, name, path));
        } catch {
          finish({ discovery: 'NOT VERIFIED', failure: 'skill_not_recognized' });
        }
      }
    });
    c.once('error', () => finish({ discovery: 'NOT VERIFIED', failure: 'unavailable' }));
    c.once('close', (code) =>
      finish({ discovery: 'NOT VERIFIED', exit_code: code, failure: 'app_server_exit' }),
    );
    c.stdin.on('error', () => {});
    c.stdin.write(
      `${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agentmind_e2e_verifier', version: '1' }, capabilities: { explicitGatewayOauth: true } } })}\n`,
    );
  });
}

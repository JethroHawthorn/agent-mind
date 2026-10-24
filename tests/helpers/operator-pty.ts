import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';

type Reply = { event: string; status: number; output: string };
export function operatorTTY(
  root: string,
  args: string[],
  script = resolve('packages/mcp-server/dist/skill-operator.js'),
) {
  const child = spawn(
    'python3',
    [resolve('tests/helpers/operator-pty.py'), process.execPath, script, ...args],
    { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let resolveReady: (v: Reply) => void = () => {};
  let resolveExit: (v: Reply) => void = () => {};
  let rejectReady: (e: Error) => void = () => {};
  let rejectExit: (e: Error) => void = () => {};
  const ready = new Promise<Reply>((yes, no) => {
    resolveReady = yes;
    rejectReady = no;
  });
  const exit = new Promise<Reply>((yes, no) => {
    resolveExit = yes;
    rejectExit = no;
  });
  // A process may exit before prompting; ready resolves to the exit reply too.
  let stderr = '';
  let completed = false;
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const reply = JSON.parse(line) as Reply;
    if (reply.event === 'ready') resolveReady(reply);
    else if (reply.event === 'exit') {
      completed = true;
      resolveReady(reply);
      resolveExit(reply);
    }
  });
  child.on('error', (error) => {
    rejectReady(error);
    rejectExit(error);
  });
  child.on('close', (code) => {
    lines.close();
    if (!completed) {
      const error = new Error(`PTY fixture failed (${code}): ${stderr}`);
      rejectReady(error);
      rejectExit(error);
    }
  });
  return {
    ready,
    exit,
    respond: (response = 'exact') => child.stdin.write(`${JSON.stringify({ response })}\n`),
  };
}

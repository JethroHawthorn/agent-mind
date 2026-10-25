import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, expect, it } from 'vitest';
import { brokerRequest, loadProtectedConfig } from '../../packages/core/src/index.js';

const helper = resolve('native/bin/agentmind-peer');
const native = it.runIf(existsSync(helper) && process.platform === 'darwin');
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f();
});
async function listener() {
  const root = mkdtempSync(join(tmpdir(), 'am-peer-'));
  const path = join(root, 'agent.sock');
  const child = spawn(helper, ['listen', path], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  cleanup.push(() => {
    child.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  });
  const frames: Array<{ uid: number; gid: number; hex: string }> = [];
  await new Promise<void>((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => reject(new Error('native startup timeout')), 3000);
    child.on('error', reject);
    let diagnostic = '';
    child.stderr.on('data', (b) => {
      diagnostic += String(b).slice(0, 256);
    });
    child.on('exit', () => reject(new Error(`native exit: ${diagnostic}`)));
    lines.on('line', (line) => {
      const f = JSON.parse(line);
      if (f.ready) {
        clearTimeout(timer);
        resolve();
      } else {
        frames.push(f);
        child.stdin.write('{"ok":true,"result":{"transport_only":true}}\n');
      }
    });
  });
  return { root, path, child, frames };
}
native('accepts ordinary files without extended ACLs and rejects symlink inspection', () => {
  const root = mkdtempSync(join(tmpdir(), 'am-acl-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'file');
  writeFileSync(path, 'fixture');
  expect(
    spawnSync(helper, ['check'], { input: `${path}\n`, encoding: 'utf8', timeout: 2000 }).status,
  ).toBe(0);
  const link = join(root, 'link');
  symlinkSync(path, link);
  expect(
    spawnSync(helper, ['check'], { input: `${link}\n`, encoding: 'utf8', timeout: 2000 }).status,
  ).toBe(1);
});
native('verifies the installed platform credential API on a real socket pair', () => {
  const r = spawnSync(helper, ['selftest'], { encoding: 'utf8', timeout: 2000 });
  expect(r.status).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ uid: process.getuid?.(), gid: process.getgid?.() });
});
native(
  'uses actual kernel peer UID/GID for sockets; payload metadata cannot change it',
  async () => {
    const f = await listener();
    const result = await brokerRequest(
      { schema_version: 1, helper, broker_uid: process.getuid?.() ?? -1, socket_directory: f.root },
      'agent',
      { uid: 0, gid: 0, peer: { uid: 0 }, op: 'approve' },
    );
    expect(result).toEqual({ transport_only: true });
    expect(f.frames[0]).toMatchObject({ uid: process.getuid?.(), gid: process.getgid?.() });
    expect(JSON.parse(Buffer.from(f.frames[0]?.hex ?? '', 'hex').toString())).toMatchObject({
      uid: 0,
    });
    // This is transport evidence, deliberately NOT a successful broker authorization or UID isolation test.
  },
);
native('authenticates server UID and refuses a forged server identity', async () => {
  const f = await listener();
  await expect(
    brokerRequest(
      {
        schema_version: 1,
        helper,
        broker_uid: (process.getuid?.() ?? 501) + 1,
        socket_directory: f.root,
      },
      'agent',
      {},
    ),
  ).rejects.toThrow();
  expect(f.frames).toHaveLength(0);
});
native(
  'refuses existing socket paths, files and symlink substitution without deleting them',
  async () => {
    const f = await listener();
    const duplicate = spawnSync(helper, ['listen', f.path], { encoding: 'utf8', timeout: 2000 });
    expect(duplicate.status).toBe(1);
    const target = join(f.root, 'user-file');
    writeFileSync(target, 'preserve');
    const link = join(f.root, 'operator.sock');
    symlinkSync(target, link);
    expect(spawnSync(helper, ['listen', link], { encoding: 'utf8', timeout: 2000 }).status).toBe(1);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(spawnSync(helper, ['listen', target], { encoding: 'utf8', timeout: 2000 }).status).toBe(
      1,
    );
  },
);
native(
  'survives an incomplete client frame and serves subsequent connections within bounds',
  async () => {
    const f = await listener();
    const stalled = createConnection(f.path);
    stalled.on('error', () => {});
    cleanup.push(() => stalled.destroy());
    await new Promise<void>((resolve) => stalled.once('connect', resolve));
    stalled.write('{');
    const result = await brokerRequest(
      { schema_version: 1, helper, broker_uid: process.getuid?.() ?? -1, socket_directory: f.root },
      'agent',
      { op: 'read' },
    );
    expect(result).toEqual({ transport_only: true });
    expect(f.child.exitCode).toBe(null);
  },
);
native('fails closed on unavailable IPC paths and rejects ACL inspection of symlinks', async () => {
  const f = await listener();
  await expect(
    brokerRequest(
      {
        schema_version: 1,
        helper,
        broker_uid: process.getuid?.() ?? -1,
        socket_directory: join(f.root, 'missing'),
      },
      'agent',
      {},
    ),
  ).rejects.toThrow();
  const link = join(f.root, 'link');
  symlinkSync(f.path, link);
  expect(
    spawnSync(helper, ['check'], { input: `${link}\n`, encoding: 'utf8', timeout: 2000 }).status,
  ).toBe(1);
});
it('refuses shared-user/unprotected startup rather than claiming an authenticated broker deployment', () => {
  const root = mkdtempSync(join(tmpdir(), 'am-policy-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'config.json');
  writeFileSync(file, '{}');
  expect(() => loadProtectedConfig(file)).toThrow();
  const result = spawnSync(
    process.execPath,
    [resolve('packages/mcp-server/dist/broker.js'), '--config', file],
    { encoding: 'utf8', timeout: 3000 },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('PROTECTED_BROKER_STARTUP_DENIED');
  const preflight = spawnSync(
    process.execPath,
    [resolve('packages/mcp-server/dist/broker.js'), '--config', file, '--preflight'],
    { encoding: 'utf8', timeout: 3000 },
  );
  expect(preflight.status).toBe(1);
  expect(preflight.stdout).toBe('');
  expect(existsSync(join(root, 'registry.db'))).toBe(false);
});

native('fails closed when peer credentials are requested on an invalid descriptor', () => {
  expect(spawnSync(helper, ['selftest-invalid'], { encoding: 'utf8', timeout: 2000 }).status).toBe(
    0,
  );
});
native(
  'recovers an owned stale socket after a crashed listener without replacing a live listener',
  async () => {
    const f = await listener();
    f.child.kill('SIGKILL');
    await new Promise((resolve) => f.child.once('exit', resolve));
    const replacement = spawn(helper, ['listen', f.path], {
      env: {},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    cleanup.push(() => replacement.kill('SIGKILL'));
    await new Promise<void>((resolve, reject) => {
      const lines = createInterface({ input: replacement.stdout });
      const timeout = setTimeout(() => reject(new Error('restart timeout')), 3000);
      lines.once('line', (line) => {
        clearTimeout(timeout);
        expect(JSON.parse(line)).toMatchObject({ ready: true });
        resolve();
      });
      replacement.once('exit', () => reject(new Error('replacement failed')));
    });
    expect(spawnSync(helper, ['listen', f.path], { encoding: 'utf8', timeout: 2000 }).status).toBe(
      1,
    );
  },
);

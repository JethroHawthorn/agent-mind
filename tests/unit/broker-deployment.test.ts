import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('renders a plan and valid launchd XML without deploying or initializing a registry', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentmind-plan-'));
  try {
    const file = join(root, 'config.json');
    writeFileSync(
      file,
      JSON.stringify({
        schema_version: 1,
        broker_uid: 201,
        operator_gid: 301,
        runtime_root: root,
        registry_directory: join(root, 'data'),
        socket_directory: join(root, 'run'),
        projects: [
          {
            name: 'a',
            root: join(root, 'work'),
            project_key: 'protected-plan-key',
            distribution_home: root,
          },
        ],
        agents: [{ uid: 203, project: 'a', source: 'codex' }],
        operators: [{ uid: 202, projects: ['a'] }],
      }),
    );
    const args = [
      resolve('scripts/broker-deployment.mjs'),
      '--config',
      file,
      '--broker-user',
      '_agentmind_broker',
    ];
    const plan = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 3000 });
    expect(plan.status).toBe(0);
    expect(JSON.parse(plan.stdout)).toMatchObject({
      status: 'PLAN ONLY',
      deployed: false,
      changes_performed: false,
      os_isolation: 'NOT VERIFIED',
    });
    const xml = spawnSync(process.execPath, [...args, '--plist'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    expect(xml.status).toBe(0);
    expect(xml.stdout).toContain('<key>UserName</key><string>_agentmind_broker</string>');
    if (process.platform === 'darwin')
      expect(
        spawnSync('/usr/bin/plutil', ['-lint', '-'], {
          input: xml.stdout,
          encoding: 'utf8',
          timeout: 3000,
        }).status,
      ).toBe(0);
    expect(readdirSync(root)).toEqual(['config.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('rejects privileged operations through the read-only CLI before loading any configuration', () => {
  for (const op of ['operator_prepare', 'operator_commit']) {
    const r = spawnSync(
      process.execPath,
      [
        resolve('packages/mcp-server/dist/broker-operator.js'),
        '--client-config',
        '/never/read/config',
        '--project',
        'a',
        '--request',
        '/never/read/request',
        '--read',
        op,
      ],
      { encoding: 'utf8', timeout: 3000 },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('BROKER_READ_OPERATION_DENIED');
  }
});

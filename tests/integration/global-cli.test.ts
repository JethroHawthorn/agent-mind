import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import { installerFixture } from '../helpers/installer-fixture.js';

const prefix = process.env.AGENTMIND_GLOBAL_PREFIX;
it.skipIf(!prefix)(
  'runs an npm-installed CLI without workspace modules or pnpm; preserves all provider integrations and knowledge',
  async () => {
    const f = installerFixture();
    try {
      const bin = join(prefix as string, 'bin/agentmind');
      const entry = realpathSync(bin);
      expect(entry.startsWith(`${prefix}/lib/node_modules/agentmind/`)).toBe(true);
      expect(readFileSync(entry, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
      expect(statSync(entry).mode & 0o111).not.toBe(0);
      const runtime = resolve(dirname(entry), '../../..');
      expect(existsSync(join(runtime, 'skills/agentmind-router/SKILL.md'))).toBe(true);
      const path = join(f.root, 'bin');
      mkdirSync(path);
      symlinkSync(process.execPath, join(path, 'node'));
      symlinkSync('/usr/bin/git', join(path, 'git'));
      for (const id of ['codex', 'claude', 'gemini'] as const)
        symlinkSync(f.options.executables[id], join(path, id));
      const env = {
        HOME: f.home,
        PATH: `${path}:${join(prefix as string, 'bin')}`,
        CODEX_HOME: join(f.root, '.codex'),
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(f.home, 'system.json'),
        GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(f.home, 'defaults.json'),
      };
      const run = (args: string[], codes = [0]) => {
        const result = spawnSync('agentmind', args, {
          cwd: f.root,
          env,
          encoding: 'utf8',
          timeout: 30000,
        });
        expect(codes, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`).toContain(
          result.status,
        );
        return result.stdout;
      };
      expect(run(['--help'])).toContain('Usage: agentmind');
      expect(run(['--help'])).not.toContain('pnpm');
      expect(run(['--version']).trim()).toBe(
        JSON.parse(readFileSync(resolve(runtime, '../../package.json'), 'utf8')).version,
      );
      run(['--unknown'], [4]);
      expect(existsSync(join(f.root, '.agentmind'))).toBe(false);
      run(['setup', '--cli', 'all', '--dry-run']);
      expect(existsSync(join(f.root, '.agentmind'))).toBe(false);
      run(['setup', '--cli', 'all', '--apply']);
      expect(existsSync(join(f.home, '.agentmind/agentmind.db'))).toBe(true);
      const ready = JSON.parse(run(['setup', '--cli', 'all', '--apply', '--json']));
      expect(ready.ready).toBe(true);
      expect(ready.registry.created).toBe(false);
      expect(
        ready.checks.some(
          (c: { id: string; status: string }) => c.id === 'fts' && c.status === 'PASS',
        ),
      ).toBe(true);
      for (const id of ['codex', 'claude', 'gemini']) {
        const enrollment = join(f.root, `.agentmind/${id}/enrollment.json`);
        expect(readFileSync(enrollment, 'utf8')).not.toContain(resolve('packages/mcp-server/dist'));
        const receipt = readFileSync(join(f.root, `.agentmind/${id}/installation.json`), 'utf8');
        expect(receipt).toContain(runtime);
        let launch: { command: string; args: string[] };
        if (id === 'codex') {
          const config = readFileSync(join(f.root, '.codex/config.toml'), 'utf8');
          launch = {
            command: JSON.parse(config.match(/^command = (.+)$/m)?.[1] ?? 'null'),
            args: JSON.parse(config.match(/^args = (.+)$/m)?.[1] ?? 'null'),
          };
        } else {
          const config = JSON.parse(
            readFileSync(
              join(f.root, id === 'claude' ? '.mcp.json' : '.gemini/settings.json'),
              'utf8',
            ),
          );
          launch = Object.values(config.mcpServers)[0] as typeof launch;
        }
        expect(launch.command).toBe(realpathSync(process.execPath));
        expect(launch.args).toEqual([
          join(runtime, `packages/mcp-server/dist/${id}/adapter.js`),
          '--enrollment',
          enrollment,
        ]);
        const client = new Client({ name: 'installed-global-cli', version: '1' });
        try {
          await client.connect(
            new StdioClientTransport({
              command: launch.command,
              args: launch.args,
              cwd: f.root,
              env,
              stderr: 'pipe',
            }),
          );
          const tools = (await client.listTools()).tools.map((tool) => tool.name);
          expect(tools).toContain('memory_save');
          expect(tools).not.toContain('skill_approve');
          expect(
            (
              await client.callTool({
                name: 'memory_save',
                arguments: {
                  title: `sqlite ${id}`,
                  content: 'sqlite persisted through installed MCP and FTS5',
                },
              })
            ).isError,
          ).not.toBe(true);
          const found = await client.callTool({
            name: 'memory_search',
            arguments: { query: 'sqlite' },
          });
          expect(found.isError).not.toBe(true);
          expect(JSON.stringify(found)).toContain('persisted');
        } finally {
          await client.close();
        }
      }
      expect(run(['status'])).toContain('CONFIGURED');
      run(['doctor'], [2]);
      run(['doctor', '--connect'], [2]);
      for (const action of ['repair', 'update']) run([action, '--cli', 'all', '--dry-run']);
      for (const args of [
        ['memory', 'search', 'sqlite'],
        ['experience', 'search', 'sqlite'],
        ['skills', 'list'],
        ['skills', 'search', 'sqlite'],
        ['learning', 'inbox'],
        ['review', 'list'],
        ['proposals', 'list'],
        ['activity'],
      ])
        run(args);
      for (const group of ['evaluation', 'distribution', 'db']) run([group, '--help']);
      const database = join(f.home, '.agentmind/agentmind.db');
      expect(statSync(database).size).toBeGreaterThan(0);
      // Shared router ownership requires Gemini removal before Codex.
      for (const id of ['gemini', 'claude', 'codex']) run(['uninstall', '--cli', id, '--apply']);
      expect(existsSync(database)).toBe(true);
      expect(run(['memory', 'search', 'sqlite'])).toContain('Page items: 3');
      expect(existsSync(join(f.home, '.claude'))).toBe(false);
      // Installed-package loader and native binding failures must stop setup before configuration.
      const packageRoot = resolve(runtime, '../..');
      const sqlite = join(packageRoot, 'node_modules/better-sqlite3');
      const binding = join(sqlite, 'build/Release/better_sqlite3.node');
      renameSync(binding, `${binding}.disabled`);
      try {
        const failed = JSON.parse(run(['setup', '--cli', 'claude', '--apply', '--json'], [5]));
        expect(failed.error.code).toBe('SQLITE_BINDING_MISSING');
        expect(existsSync(join(f.root, '.mcp.json'))).toBe(false);
      } finally {
        renameSync(`${binding}.disabled`, binding);
      }
      renameSync(sqlite, `${sqlite}.disabled`);
      try {
        const failed = JSON.parse(run(['setup', '--cli', 'claude', '--apply', '--json'], [5]));
        expect(failed.error.code).toBe('SQLITE_DRIVER_MISSING');
        expect(existsSync(join(f.root, '.mcp.json'))).toBe(false);
      } finally {
        renameSync(`${sqlite}.disabled`, sqlite);
      }
    } finally {
      f.cleanup();
    }
  },
  120000,
);

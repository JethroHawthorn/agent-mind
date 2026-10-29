import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { detectCli } from '../../packages/mcp-server/src/installer/detection.js';
import { UnifiedInstaller } from '../../packages/mcp-server/src/installer/service.js';
import { completeSetup } from '../../packages/mcp-server/src/installer/setup.js';
import { installerFixture } from '../helpers/installer-fixture.js';

const executable = process.env.AGENTMIND_ANTIGRAVITY_EXECUTABLE;
it.skipIf(!executable).each(['project', 'user'] as const)(
  'real agy: %s scope is either explicitly refused or natively discovered through verified user registration',
  async (scope) => {
    const f = installerFixture();
    try {
      const detected = detectCli('antigravity', executable);
      expect(detected.state).toBe('DETECTED');
      const list = () => {
        const path = join(f.root, 'native-list.txt'),
          fd = openSync(path, 'w', 0o600);
        let result: ReturnType<typeof spawnSync>;
        try {
          result = spawnSync(detected.executable as string, ['mcp', 'list'], {
            cwd: f.root,
            env: { PATH: process.env.PATH, HOME: f.home, LANG: 'C', NO_COLOR: '1' },
            stdio: ['ignore', fd, fd],
            timeout: 10000,
          });
        } finally {
          closeSync(fd);
        }
        expect(result.status).toBe(0);
        return readFileSync(path, 'utf8');
      };
      expect(list()).not.toContain('antigravity/adapter.js');
      const service = new UnifiedInstaller({
        ...f.options,
        scope,
        executables: { antigravity: detected.executable as string },
      });
      const result = await completeSetup(service, ['antigravity'], true);
      if (scope === 'project') {
        expect(result).toMatchObject({
          ready: false,
          exit_code: 3,
          error: { code: 'ANTIGRAVITY_SCOPE_UNSUPPORTED' },
        });
        expect(existsSync(join(f.root, '.agents/mcp_config.json'))).toBe(false);
        expect(existsSync(join(f.home, '.gemini/config/mcp_config.json'))).toBe(false);
        expect(existsSync(f.options.database)).toBe(false);
        expect(list()).not.toContain('antigravity/adapter.js');
      } else {
        expect(result.ready, JSON.stringify(result)).toBe(true);
        expect(list()).toContain('antigravity/adapter.js');
        expect(list()).toContain(join(f.root, '.agentmind/antigravity/enrollment.json'));
        expect((await completeSetup(service, ['antigravity'], true)).results[0]?.action).toBe(
          'SKIP',
        );
        service.apply(service.plan('uninstall', ['antigravity']));
        expect(list()).not.toContain('antigravity/adapter.js');
        expect(existsSync(f.options.database)).toBe(true);
      }
      // No project plugin success or native model workflow is inferred from this test.
    } finally {
      f.cleanup();
    }
  },
  30000,
);

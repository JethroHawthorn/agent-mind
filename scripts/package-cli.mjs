// Assemble the existing compiled CLI; no command handlers or native binaries are bundled.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export function packageCLI(build = false) {
  if (build) {
    for (const name of ['core', 'mcp-server']) {
      const result = spawnSync(
        process.execPath,
        [join(root, 'node_modules/typescript/bin/tsc'), '-p', `packages/${name}/tsconfig.json`],
        { cwd: root, stdio: 'inherit' },
      );
      if (result.status !== 0) throw Error(`CLI_BUILD_FAILED: ${name}`);
    }
  }
  const target = join(root, 'dist/runtime');
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  writeFileSync(
    join(target, 'package.json'),
    `${JSON.stringify({ name: metadata.name, version: metadata.version, license: metadata.license, type: 'module', private: true }, null, 2)}\n`,
  );
  cpSync(join(root, 'LICENSE'), join(target, 'LICENSE'));
  for (const name of ['core', 'mcp-server']) {
    const destination = join(target, `packages/${name}/dist`);
    cpSync(join(root, `packages/${name}/dist`), destination, {
      recursive: true,
      filter: (p) => !p.endsWith('.map') && !p.endsWith('.d.ts'),
    });
    function rewrite(directory) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) rewrite(path);
        else if (path.endsWith('.js')) {
          const core = relative(dirname(path), join(target, 'packages/core/dist/index.js'))
            .split('\\')
            .join('/');
          const text = readFileSync(path, 'utf8')
            .replace(
              /(['"])@agentmind\/core\1/g,
              JSON.stringify(core.startsWith('.') ? core : `./${core}`),
            )
            .replace(/^\/\/# sourceMappingURL=.*$/gm, '');
          writeFileSync(path, text);
        }
      }
    }
    rewrite(destination);
  }
  cpSync(join(root, 'skills/agentmind-router'), join(target, 'skills/agentmind-router'), {
    recursive: true,
  });
  // Preserve opt-in doctor probes and their finite local helper closure.
  for (const name of [
    'verify-codex-daily',
    'verify-claude-daily',
    'verify-gemini-daily',
    'continuous-fixture',
    'learning-fixture',
    'native-process',
    'skills-evidence',
    'cli-evidence',
    'gemini-evidence',
  ]) {
    mkdirSync(join(target, 'scripts'), { recursive: true });
    cpSync(join(root, `scripts/${name}.mjs`), join(target, `scripts/${name}.mjs`));
  }
  chmodSync(join(target, 'packages/mcp-server/dist/agentmind.js'), 0o755);
  return target;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  packageCLI(process.argv.includes('--build'));

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CodexSetup } from '../../packages/mcp-server/src/codex/setup.js';
import { prepareContinuousFixture } from '../../scripts/continuous-fixture.mjs';
import { cleanupLearningFixture } from '../../scripts/learning-fixture.mjs';
export function codexFixture(suffix = '') {
  const f = prepareContinuousFixture();
  if (suffix) {
    const old = f.root;
    f.root = old + suffix;
    renameSync(old, f.root);
    writeFileSync(join(f.root, '.agentmind-e2e.json'), JSON.stringify(f));
  }
  const options = {
    root: f.root,
    database: join(f.root, 'registry.db'),
    adapter: resolve('packages/mcp-server/dist/codex/adapter.js'),
    router: readFileSync('skills/agentmind-router/SKILL.md', 'utf8'),
  };
  const setup = new CodexSetup(options);
  return {
    ...f,
    options,
    setup,
    config: join(f.root, '.codex/config.toml'),
    routerFile: join(f.root, '.agents/skills/agentmind-router/SKILL.md'),
    enrollment: join(f.root, '.agentmind/codex/enrollment.json'),
    state: join(f.root, '.agentmind/codex/installation.json'),
    cleanup: () => cleanupLearningFixture(f.root),
  };
}

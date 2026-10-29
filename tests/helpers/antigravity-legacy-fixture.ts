import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AntigravitySetup } from '../../packages/mcp-server/src/antigravity/setup.js';
import { projectScope } from '../../packages/mcp-server/src/codex/project.js';
import type { installerFixture } from './installer-fixture.js';
/** Exact historical receipt/config fixture; never a supported project install or native proof. */
export function legacyAntigravity(f: ReturnType<typeof installerFixture>, owned = true) {
  const s = new AntigravitySetup({
    ...f.options,
    scope: 'project',
    adapter: f.options.adapters.antigravity,
  });
  const id = randomUUID(),
    enrollment = JSON.stringify({
      schema_version: 1,
      integration: 'agentmind-antigravity-v1',
      installation_id: id,
      project_root: f.root,
      project_id: projectScope(f.root).id,
      database: f.options.database,
      mode: 'supervised-local',
    });
  const receipt = {
    schema: 1,
    id,
    root: f.root,
    database: f.options.database,
    scope: 'project',
    phase: 'installed',
    entry: s.entry(),
    enrollment,
    router: { root: f.root, path: s.routerPath, owned },
    router_content: f.options.router,
    before: null,
  };
  for (const [path, text] of [
    [s.statePath, JSON.stringify(receipt)],
    [s.enrollment, enrollment],
    [s.routerPath, f.options.router],
    [s.config, JSON.stringify({ mcpServers: { agentmind: s.entry() } })],
  ]) {
    mkdirSync(join(path as string, '..'), { recursive: true, mode: 0o700 });
    writeFileSync(path as string, text as string, { mode: 0o600 });
  }
  return { setup: s, receipt };
}

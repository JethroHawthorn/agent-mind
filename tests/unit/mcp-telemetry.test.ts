import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it, vi } from 'vitest';
import {
  MemoryService,
  SkillProposalService,
  SkillStore,
  SkillUsageService,
} from '../../packages/core/dist/index.js';
import { createServer } from '../../packages/mcp-server/src/server.js';
import { authoringFixture } from '../helpers/authoring-fixture.js';

it.each([true, false])(
  'legacy read annotation matches telemetry enabled=%s; observation failure cannot break authorized retrieval',
  async (enabled) => {
    const f = authoringFixture(true);
    const usage = new SkillUsageService(f.db, f.scope, 'codex', enabled);
    const observe = vi.spyOn(usage, 'observeMcpDiscovery').mockImplementation(() => {
      throw Error('Synthetic telemetry outage');
    });
    const server = createServer(new MemoryService(f.db, f.scope, 'codex'), undefined, true, {
      store: new SkillStore(f.db, f.scope),
      proposals: new SkillProposalService(f.db, f.scope, 'codex'),
      proposalEnabled: true,
      usage,
    });
    const c = new Client({ name: 'legacy-telemetry-contract', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a);
      await c.connect(b);
      const t = (await c.listTools()).tools.find((t) => t.name === 'skill_get');
      expect(t?.annotations?.readOnlyHint).toBe(!enabled);
      const r = await c.callTool({ name: 'skill_get', arguments: { version_id: f.base } });
      expect(r.isError).not.toBe(true);
      expect(observe).toHaveBeenCalledTimes(enabled ? 1 : 0);
      expect(
        f.store.getIdentity(f.store.getVersion(f.base as string).version.skill_id)
          .active_version_id,
      ).toBe(f.base);
    } finally {
      await c.close();
      await server.close();
      f.close();
    }
  },
);

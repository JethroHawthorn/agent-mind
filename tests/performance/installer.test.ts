import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { inspectRegistry } from '../../packages/core/src/index.js';
import { mcpDocument } from '../../packages/mcp-server/src/claude/configuration.js';
import { runtimeDoctor } from '../../packages/mcp-server/src/installer/doctor.js';
import { diagnosticText } from '../../packages/mcp-server/src/installer/files.js';
import { installerFixture } from '../helpers/installer-fixture.js';

it('measures isolated setup/status/doctor costs with contract doubles and actual MCP', async () => {
  const f = installerFixture();
  try {
    let t = performance.now();
    const cold = f.service.status();
    const statusCold = performance.now() - t;
    const warm: number[] = [],
      plans: number[] = [];
    const heap = process.memoryUsage().heapUsed;
    for (let i = 0; i < 5; i++) {
      t = performance.now();
      f.service.status();
      warm.push(performance.now() - t);
      t = performance.now();
      f.service.plan('setup');
      plans.push(performance.now() - t);
    }
    const p = f.service.plan('setup');
    f.service.apply(p);
    t = performance.now();
    const checks = await runtimeDoctor(f.service, 'claude');
    const handshake = performance.now() - t;
    t = performance.now();
    f.service.diagnostics();
    const registry = inspectRegistry(f.options.database, f.service.project);
    const doctor = performance.now() - t;
    t = performance.now();
    for (let i = 0; i < 100; i++) mcpDocument('{"mcpServers":{"other":{"command":"node"}}}');
    const parse = (performance.now() - t) / 100;
    const report = {
      method:
        'Public executable contract doubles, real MCP server/SQLite. Warm within one command/service only. No model or native integration verification.',
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      samples: 5,
      status_cold_ms: statusCold,
      status_warm_ms: warm,
      planning_ms: plans,
      offline_doctor_ms: doctor,
      mcp_probe_ms: handshake,
      json_parse_mean_ms: parse,
      status_bytes: Buffer.byteLength(diagnosticText(cold, false)),
      plan_bytes: Buffer.byteLength(diagnosticText(p, false)),
      diagnostics_bytes: Buffer.byteLength(diagnosticText(checks, false)),
      heap_delta_bytes: process.memoryUsage().heapUsed - heap,
      process_peak_rss: process.resourceUsage().maxRSS,
      registry,
    };
    writeFileSync(
      join(tmpdir(), 'agentmind-p4-004-performance.json'),
      JSON.stringify(report, null, 2),
    );
    expect(checks.every((c) => c.status === 'PASS')).toBe(true);
    expect(registry.status).toBe('PASS');
  } finally {
    f.cleanup();
  }
}, 60000);

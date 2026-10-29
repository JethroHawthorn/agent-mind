import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  migrateDatabase,
  openDatabase,
  planDatabaseMigration,
} from '../../packages/core/src/index.js';
import { releasePlan, sourceArchive } from '../../scripts/release.mjs';
import { upgradePlan } from '../../scripts/upgrade-plan.mjs';
import { installerFixture } from '../helpers/installer-fixture.js';

it('records raw release planning/build and disposable installation costs without model usage', async () => {
  const f = installerFixture(),
    root = realpathSync(mkdtempSync(join(tmpdir(), 'agentmind-rc-bench-')));
  try {
    const samples: Record<string, number[]> = {};
    const measure = (key: string, fn: () => unknown) => {
      const start = performance.now();
      const result = fn();
      samples[key] ??= [];
      samples[key].push(performance.now() - start);
      return result;
    };
    for (let i = 0; i < 3; i++) {
      measure('source_plan_ms', () => releasePlan());
      measure('source_archive_ms', () => sourceArchive());
    }
    const plan = measure('installation_plan_ms', () => f.service.plan('setup')) as ReturnType<
      typeof f.service.plan
    >;
    measure('setup_ms', () => f.service.apply(plan));
    measure('ordinary_doctor_ms', () => f.service.diagnostics());
    measure('uninstall_ms', () => f.service.apply(f.service.plan('uninstall')));
    const privateDir = join(root, 'private');
    mkdirSync(privateDir, { mode: 0o700 });
    const path = join(privateDir, 'db.sqlite');
    measure('database_initialize_ms', () => openDatabase(path).close());
    const start = performance.now();
    const preflight = await upgradePlan(path);
    samples.upgrade_preflight_ms = [performance.now() - start];
    measure('current_schema_migration_check_ms', () =>
      migrateDatabase(path, planDatabaseMigration(path).digest),
    );
    const artifact = sourceArchive();
    console.log(
      `P6003_PERFORMANCE ${JSON.stringify({ schema_version: 1, node: process.version, platform: process.platform, arch: process.arch, method: 'Raw samples on developer host; source creation, public CLI doubles and actual SQLite, no dependency install/native model/OS isolation proof. No statistically reliable p95 from these small samples.', samples, source_files: artifact.plan.file_count, source_bytes: artifact.plan.source_bytes, archive_bytes: artifact.bytes.length, rss_bytes: process.memoryUsage().rss, upgrade_state: preflight.status })}`,
    );
    expect(artifact.bytes.length).toBeGreaterThan(0);
    expect(preflight.status).toBe('BLOCKED');
  } finally {
    f.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);

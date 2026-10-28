import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, it } from 'vitest';
import { backupDatabase, inspectDatabase, openDatabase } from '../../packages/core/src/index.js';

function stats(samples: number[]) {
  const s = samples.sort((a, b) => a - b);
  return {
    p50_ms: s[Math.floor(s.length * 0.5)],
    p95_ms: s[Math.floor(s.length * 0.95)],
    iterations: s.length,
  };
}
function measure(f: () => unknown, n = 50) {
  const values = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    f();
    values.push(performance.now() - start);
  }
  return stats(values);
}
it('records deterministic multi-project SQLite baseline and scoped-list index experiment', async () => {
  const results = [];
  for (const count of [100, 10_000, 100_000]) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentmind-db-bench-'))),
      path = join(root, 'registry.sqlite'),
      db = openDatabase(path);
    try {
      db.prepare('INSERT INTO projects VALUES(?,?)').run('a', root);
      db.prepare('INSERT INTO projects VALUES(?,?)').run('b', root);
      const memory = db.prepare(
        "INSERT INTO memories VALUES(?,?,'fact',?,'unicode 日本語 recovery workflow','codex','unverified',?)",
      );
      const experience = db.prepare(
        "INSERT INTO experiences(id,project_id,source_agent,problem,solution,outcome_status,outcome_summary,evidence_json,provenance_json,fingerprint,redacted,created_at,updated_at) VALUES(?,?,'claude',?,'reproducible fixture','unknown','not verified','[]','{}',?,0,?,?)",
      );
      const seed = performance.now();
      db.transaction(() => {
        for (let n = 0; n < count; n++) {
          const id = String(n).padStart(8, '0'),
            project = n % 2 ? 'a' : 'b',
            stamp = new Date(1_700_000_000_000 + n * 1000).toISOString();
          memory.run(id, project, `recovery ${n}`, stamp);
          experience.run(id, project, `recovery ${n}`, id, stamp, stamp);
        }
      })();
      const seeded = performance.now() - seed;
      // Baseline is the exact existing P4-005 list query, unchanged projection/order.
      const sql =
        'SELECT id,project_id,title,created_at FROM memories WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 26';
      const xpSql =
        'SELECT id,project_id,problem,created_at FROM experiences WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 26';
      db.exec(
        'DROP INDEX IF EXISTS memories_scope_recent; DROP INDEX IF EXISTS experiences_scope_recent',
      );
      const before = db.prepare(sql).all('a'),
        beforeXp = db.prepare(xpSql).all('a');
      const insertTrial = () => {
        db.exec('SAVEPOINT insert_trial');
        try {
          memory.run('transient-benchmark', 'a', 'transient recovery', new Date().toISOString());
        } finally {
          db.exec('ROLLBACK TO insert_trial; RELEASE insert_trial');
        }
      };
      const baselineWrite = measure(insertTrial, 30);
      const baseline = {
        memory: measure(() => db.prepare(sql).all('a')),
        experience: measure(() => db.prepare(xpSql).all('a')),
        plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('a'),
      };
      const beforeBytes =
        (Number(db.pragma('page_count', { simple: true })) -
          Number(db.pragma('freelist_count', { simple: true }))) *
        Number(db.pragma('page_size', { simple: true }));
      const add = performance.now();
      db.exec(
        'CREATE INDEX memories_scope_recent ON memories(project_id,created_at DESC,id DESC); CREATE INDEX experiences_scope_recent ON experiences(project_id,created_at DESC,id DESC)',
      );
      const indexMs = performance.now() - add;
      const optimizedWrite = measure(insertTrial, 30);
      const optimized = {
        memory: measure(() => db.prepare(sql).all('a')),
        experience: measure(() => db.prepare(xpSql).all('a')),
        plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('a'),
      };
      expect(db.prepare(sql).all('a')).toEqual(before);
      expect(db.prepare(xpSql).all('a')).toEqual(beforeXp);
      const afterBytes =
        (Number(db.pragma('page_count', { simple: true })) -
          Number(db.pragma('freelist_count', { simple: true }))) *
        Number(db.pragma('page_size', { simple: true }));
      const fts = measure(() =>
        db
          .prepare('SELECT rowid FROM memories_fts WHERE memories_fts MATCH ? LIMIT 5')
          .all('"日本語"'),
      );
      const checkStart = performance.now();
      expect(inspectDatabase(path, true).status).toBe('PASS');
      const integrityMs = performance.now() - checkStart;
      const backupStart = performance.now();
      const manifest = await backupDatabase(path, join(root, 'backup'));
      const backupMs = performance.now() - backupStart;
      db.pragma('wal_checkpoint(TRUNCATE)');
      results.push({
        sqlite_version: db.prepare('SELECT sqlite_version() AS version').get(),
        memories: count,
        experiences: count,
        projects: 2,
        skills: 0,
        seed_ms: seeded,
        baseline,
        optimized,
        baseline_memory_insert_rollback: baselineWrite,
        optimized_memory_insert_rollback: optimizedWrite,
        index_creation_ms: indexMs,
        index_storage_bytes: afterBytes - beforeBytes,
        database_bytes: statSync(path).size,
        fts,
        integrity_ms: integrityMs,
        backup_ms: backupMs,
        backup_sha256: manifest.sha256,
      });
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
  const report = {
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      driver: createRequire(import.meta.url)('better-sqlite3/package.json').version,
      memory_rss_bytes: process.memoryUsage().rss,
    },
    methodology:
      'Synthetic two-project fixtures; 50 warm repetitions, no OS page-cache eviction; sequential before/after on identical rows. No model tokens. Large skills covered by existing hybrid-scale benchmark.',
    results,
  };
  console.log(`DATABASE_BENCHMARK ${JSON.stringify(report)}`);
  if (process.env.AGENTMIND_DATABASE_BENCHMARK_OUTPUT)
    writeFileSync(process.env.AGENTMIND_DATABASE_BENCHMARK_OUTPUT, JSON.stringify(report, null, 2));
}, 120_000);

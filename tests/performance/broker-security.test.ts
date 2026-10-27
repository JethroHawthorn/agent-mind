import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  BrokerService,
  openDatabase,
  validateBrokerConfig,
} from '../../packages/core/src/index.js';

it('measures synthetic broker transaction/audit cost separately from unverified protected IPC', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentmind-p5-perf-'));
  mkdirSync(join(root, 'work'));
  const db = openDatabase(join(root, 'registry.db'));
  try {
    const config = validateBrokerConfig({
      schema_version: 1,
      broker_uid: 201,
      runtime_root: root,
      registry_directory: root,
      socket_directory: root,
      projects: [
        {
          name: 'a',
          root: join(root, 'work'),
          project_key: 'synthetic-perf-project',
          distribution_home: root,
        },
      ],
      agents: [{ uid: 203, project: 'a', source: 'unknown' }],
      operators: [{ uid: 202, projects: ['a'] }],
    });
    let t = performance.now();
    const service = new BrokerService(db, config);
    const construction = performance.now() - t;
    const prepare: number[] = [],
      commit: number[] = [],
      record: number[] = [],
      helper: number[] = [];
    for (let i = 0; i < 10; i++) {
      t = performance.now();
      const event = service.handle(
        'agent',
        { uid: 203, gid: 303 },
        {
          schema_version: 1,
          op: 'experience_record',
          input: {
            problem: `Controlled boundary ${i}`,
            solution: 'Inspect both bounds.',
            outcome: { status: 'unknown', summary: 'Synthetic fixture, no verified task outcome.' },
          },
        },
      ) as { experience: { id: string; updated_at: string } };
      record.push(performance.now() - t);
      t = performance.now();
      const p = service.handle(
        'operator',
        { uid: 202, gid: 302 },
        {
          schema_version: 1,
          project: 'a',
          op: 'operator_prepare',
          input: {
            kind: 'experience',
            request: {
              id: event.experience.id,
              expected_updated_at: event.experience.updated_at,
              decision: 'approved',
              reason: 'Synthetic operator process contract only.',
            },
          },
        },
      ) as { challenge_id: string; digest: string };
      prepare.push(performance.now() - t);
      t = performance.now();
      service.handle(
        'operator',
        { uid: 202, gid: 302 },
        {
          schema_version: 1,
          project: 'a',
          op: 'operator_commit',
          input: { challenge_id: p.challenge_id, review_digest: p.digest },
        },
      );
      commit.push(performance.now() - t);
      if (process.platform === 'darwin') {
        t = performance.now();
        expect(
          spawnSync(resolve('native/bin/agentmind-peer'), ['selftest'], {
            encoding: 'utf8',
            timeout: 3000,
          }).status,
        ).toBe(0);
        helper.push(performance.now() - t);
      }
    }
    const stats = (values: number[]) => {
      values.sort((a, b) => a - b);
      return { samples: values.length, p50_ms: values[4] ?? null, p95_ms: values[9] ?? null };
    };
    const report = {
      schema_version: 1,
      layer:
        'A_SYNTHETIC_IDENTITIES; native helper spawn/socketpair primitive uses actual current UID only',
      environment: {
        node: process.version,
        platform: process.platform,
        uid: process.getuid?.(),
        arch: process.arch,
      },
      broker_construction_ms: construction,
      record_transaction: stats(record),
      operator_prepare_transaction: stats(prepare),
      operator_commit_and_audit_transaction: stats(commit),
      helper_spawn_and_socketpair: stats(helper),
      sqlite: {
        journal_mode: db.pragma('journal_mode', { simple: true }),
        synchronous: db.pragma('synchronous', { simple: true }),
      },
      audit_rows: (db.prepare('SELECT COUNT(*) n FROM broker_audit').get() as { n: number }).n,
      security_event_rows: (
        db.prepare('SELECT COUNT(*) n FROM broker_security_events').get() as { n: number }
      ).n,
      ipc_roundtrip: 'NOT_VERIFIED',
      actual_protected_operation: 'NOT_VERIFIED',
      service_restart: 'NOT_VERIFIED',
      separate_uid_concurrency: 'NOT_VERIFIED',
    };
    writeFileSync(
      join(tmpdir(), 'agentmind-p5-001-performance.json'),
      JSON.stringify(report, null, 2),
    );
    expect(report.audit_rows).toBe(40);
    expect(report.security_event_rows).toBe(30);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ExperienceService,
  MemoryService,
  migrate,
  normalizeExperienceText,
  openDatabase,
  resolveProject,
} from '../../packages/core/src/index.js';
import { removeSkillSchema } from '../helpers/skill-schema.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'agentmind-experience-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const a = join(dir, 'a');
  const b = join(dir, 'b');
  mkdirSync(a);
  mkdirSync(b);
  const path = join(dir, 'memory.db');
  const db = openDatabase(path);
  cleanup.push(() => {
    if (db.open) db.close();
  });
  const project = resolveProject(a, a);
  const service = new ExperienceService(db, project, 'codex');
  return { dir, a, b, path, db, project, service };
}
const input = {
  problem: 'SQLite concurrent startup failed',
  solution: 'Retry journal mode changes when SQLite is busy',
  outcome: {
    status: 'succeeded',
    summary: 'Local integration tests passed; other environments remain untested.',
  },
  evidence: [
    { kind: 'test', reference: 'tests/integration/mcp.test.ts', summary: 'Local run passed.' },
  ],
  provenance: { task_ref: 'P1-001', commit: 'abcdef1' },
};
function record(service: ExperienceService, fields = {}) {
  return service.record({ ...input, ...fields }).experience;
}
function review(service: ExperienceService, id: string, decision = 'approved') {
  return service.review({
    id,
    decision,
    expected_updated_at: service.inspect(id).updated_at,
    reviewer: 'local reviewer',
    reason: 'Inspected the source and test references.',
  });
}

describe('structured experience validation and privacy', () => {
  it('creates runtime-scoped unverified candidates, even for successful outcomes', () => {
    const { service, project, db } = fixture();
    const saved = record(service);
    expect(saved).toMatchObject({
      project_id: project.id,
      source_agent: 'codex',
      approval_status: 'candidate',
      verification_status: 'unverified',
      capture_method: 'explicit',
      redacted: false,
    });
    expect(saved.evidence[0]?.reference).toBe(input.evidence[0]?.reference);
    expect(saved.provenance.commit).toBe('abcdef1');
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });
  it.each([
    { project_id: 'foreign' },
    { project_key: 'foreign' },
    { source_agent: 'claude' },
    { approval_status: 'approved' },
    { verification_status: 'verified' },
    { id: 'forged' },
    { created_at: '2020-01-01' },
    { transcript: 'raw' },
    { scope: 'global' },
  ])('rejects client-selected authority/provenance fields: %j', (extra) => {
    const { service, db } = fixture();
    expect(() => service.record({ ...input, ...extra })).toThrow('Invalid experience');
    expect(db.prepare('SELECT COUNT(*) AS n FROM experiences').get()).toEqual({ n: 0 });
  });
  it.each([
    { problem: '' },
    { solution: ' ' },
    { problem: 'x'.repeat(2001) },
    { solution: 'x'.repeat(4001) },
    { outcome: { status: 'verified', summary: 'unsupported' } },
    { outcome: { status: 'succeeded', summary: 'x'.repeat(1001) } },
    { evidence: Array.from({ length: 9 }, () => input.evidence[0]) },
    { evidence: [{ kind: 'test', reference: 'x'.repeat(513) }] },
    { provenance: { commit: 'not-a-commit' } },
    { provenance: { source_agent: 'claude' } },
    { evidence: [{ kind: 'test', reference: 'x', verified: true }] },
    { problem: '...', solution: '***' },
  ])('rejects malformed and oversized inputs: %j', (extra) => {
    expect(() => fixture().service.record({ ...input, ...extra })).toThrow();
  });
  it('enforces an aggregate payload limit', () => {
    const { service } = fixture();
    expect(() =>
      record(service, {
        problem: 'p'.repeat(2000),
        solution: 's'.repeat(4000),
        outcome: { status: 'unknown', summary: 'o'.repeat(1000) },
        evidence: Array.from({ length: 8 }, () => ({
          kind: 'note',
          reference: '"'.repeat(512),
          summary: 's'.repeat(512),
        })),
        provenance: { task_ref: 't'.repeat(200) },
      }),
    ).toThrow('Invalid experience');
  });
  it('also enforces content limits after redaction expands short credential values', () => {
    const { service, db } = fixture();
    expect(() => record(service, { problem: 'token=a '.repeat(250) })).toThrow(
      'content size limits',
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM experiences').get()).toEqual({ n: 0 });
  });
  it('redacts all persisted text before indexing, fingerprinting or returning it', () => {
    const { service, db, path } = fixture();
    const secrets = [
      'sensitive-password-value',
      `sk-proj-${'a'.repeat(24)}`,
      `AIza${'b'.repeat(35)}`,
      `sk_live_${'c'.repeat(24)}`,
      'private-key-body',
      'evidence-token-value',
      'provenance-secret-value',
    ];
    const saved = record(service, {
      problem: `Login failed password="${secrets[0]}"`,
      solution: `Use the replacement ${secrets[1]}`,
      outcome: { status: 'partial', summary: `Google ${secrets[2]} and Stripe ${secrets[3]}` },
      evidence: [
        {
          kind: 'note',
          reference: `https://example.invalid/log?api_key=${secrets[5]}`,
          summary: `-----BEGIN RSA PRIVATE KEY-----\n${secrets[4]}\n-----END RSA PRIVATE KEY-----`,
        },
      ],
      provenance: { task_ref: `"api_key": "${secrets[6]}"` },
    });
    expect(saved.redacted).toBe(true);
    const rows = JSON.stringify(db.prepare('SELECT * FROM experiences').all());
    for (const secret of secrets) {
      expect(JSON.stringify(saved)).not.toContain(secret);
      expect(rows).not.toContain(secret);
      expect(service.search({ query: secret }).experiences).toEqual([]);
    }
    expect(saved.solution).toContain('[REDACTED]');
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    const bytes = readFileSync(path);
    for (const secret of secrets) expect(bytes.includes(Buffer.from(secret))).toBe(false);
    const reopened = openDatabase(path);
    try {
      expect(JSON.stringify(reopened.prepare('SELECT * FROM experiences').all())).toBe(rows);
    } finally {
      reopened.close();
    }
  });
  it.each([
    'user: raw conversation\nassistant: full response',
    '[{"role":"user","content":"raw conversation"},{"role":"assistant","content":"full response"}]',
    '{"messages":[{"role":"user","content":"raw conversation"}]}',
  ])('rejects transcript-like content', (problem) => {
    expect(() => record(fixture().service, { problem })).toThrow('short experience summary');
  });
  it('keeps capture disabled at the service boundary', () => {
    const { db, project } = fixture();
    expect(() => record(new ExperienceService(db, project, 'codex', false))).toThrow('disabled');
    expect(db.prepare('SELECT COUNT(*) AS n FROM experiences').get()).toEqual({ n: 0 });
  });
  it('computes duplicate fingerprints from redacted values rather than raw credentials', () => {
    const { service } = fixture();
    const first = record(service, { solution: 'Rotate api_key=first-secret-value' });
    const second = service.record({ ...input, solution: 'Rotate api_key=second-secret-value' });
    expect(second.possible_duplicates[0]).toMatchObject({
      match: 'exact',
      experience: { id: first.id },
    });
  });
});

describe('experience retrieval, duplicate suggestions and review', () => {
  it('finds similar duplicates whose technical keywords follow introductory alphabet noise', () => {
    const { service } = fixture();
    const technical = 'sqlite transaction wal write zod';
    const details = Array.from({ length: 40 }, (_, i) => `zmechanism${i}`).join(' ');
    const original = record(service, { problem: technical, solution: details });
    const duplicate = service.record({
      ...input,
      problem: `a b c d e f g h i j k l m n o p q r ${technical}`,
      solution: details,
    });
    expect(duplicate.possible_duplicates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          match: 'similar',
          experience: expect.objectContaining({ id: original.id }),
        }),
      ]),
    );
  });
  it.each([1024, 1100, 1500])(
    'retains a meaningful top preview within a %i-character budget',
    (max_chars) => {
      const { service } = fixture();
      const saved = record(service, {
        problem: `SQLite ${'😀"\\\n'.repeat(100)}`,
        solution: `Retry SQLite ${'"\\'.repeat(700)}`,
        outcome: { status: 'partial', summary: 'Observed '.repeat(100) },
        evidence: Array.from({ length: 2 }, () => ({
          kind: 'note',
          reference: 'r'.repeat(512),
          summary: 's'.repeat(512),
        })),
        provenance: { task_ref: 't'.repeat(200), commit: 'a'.repeat(64) },
      });
      const result = service.search({ query: 'SQLite', max_chars });
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(max_chars);
      expect(result.truncated).toBe(true);
      expect(result.experiences).toHaveLength(1);
      const top = result.experiences[0];
      expect(top).toMatchObject({
        id: saved.id,
        project_id: saved.project_id,
        source_agent: 'codex',
        approval_status: 'candidate',
        verification_status: 'unverified',
        content_truncated: true,
        created_at: saved.created_at,
      });
      expect(top?.problem).toContain('SQLite');
      expect(top?.solution).toContain('Retry');
    },
  );
  it('normalizes deterministically and returns exact/similar duplicates without overwriting', () => {
    const { service, db } = fixture();
    const original = record(service);
    const approved = review(service, original.id);
    expect(normalizeExperienceText('ＳＱＬｉｔｅ: WAL!')).toBe('sqlite wal');
    const duplicate = service.record({
      ...input,
      problem: ' SQLITE concurrent STARTUP failed!!! ',
      solution: `${input.solution}.`,
    });
    expect(duplicate.possible_duplicates[0]).toMatchObject({
      match: 'exact',
      score: 1,
      experience: { id: original.id, approval_status: 'approved' },
    });
    expect(duplicate.experience.approval_status).toBe('candidate');
    expect(service.inspect(original.id)).toEqual(approved);
    const similar = service.record({ ...input, solution: `${input.solution} with backoff` });
    expect(
      similar.possible_duplicates.some(
        (item) => item.match === 'similar' && item.experience.id === original.id,
      ),
    ).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM experiences').get()).toEqual({ n: 3 });
  });
  it('isolates search, duplicate matching and local reviews across projects', () => {
    const { service, db, b } = fixture();
    const saved = record(service);
    const other = new ExperienceService(db, resolveProject(b, b), 'claude');
    expect(other.search({ query: 'SQLite' }).experiences).toEqual([]);
    expect(other.record(input).possible_duplicates).toEqual([]);
    expect(() => other.inspect(saved.id)).toThrow('not available');
    expect(() => review(other, saved.id)).toThrow('not available');
    expect(() => other.search({ query: 'SQLite', project_id: saved.project_id })).toThrow();
  });
  it('distinguishes candidates and approvals, excludes rejected records and records human review', () => {
    const { service, db } = fixture();
    const candidate = record(service);
    const approved = review(service, record(service, { problem: 'SQLite approved fix' }).id);
    const rejected = review(
      service,
      record(service, { problem: 'SQLite rejected fix' }).id,
      'rejected',
    );
    const visible = service.search({ query: 'SQLite' }).experiences;
    expect(visible.map((item) => item.id).sort()).toEqual([candidate.id, approved.id].sort());
    expect(
      service.search({ query: 'SQLite', status: 'approved' }).experiences.map((item) => item.id),
    ).toEqual([approved.id]);
    expect(
      service.search({ query: 'SQLite', status: 'candidate' }).experiences.map((item) => item.id),
    ).toEqual([candidate.id]);
    expect(() => service.search({ query: 'SQLite', status: 'rejected' })).toThrow();
    expect(approved.verification_status).toBe('unverified');
    expect(
      service
        .record({ ...input, problem: 'SQLite rejected fix' })
        .possible_duplicates.some((item) => item.experience.id === rejected.id),
    ).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM experience_reviews').get()).toEqual({ n: 2 });
  });
  it('uses optimistic review checks and supports audited human revocation without editing content', () => {
    const { service, db } = fixture();
    const saved = record(service);
    review(service, saved.id);
    expect(() =>
      service.review({
        id: saved.id,
        decision: 'rejected',
        expected_updated_at: saved.updated_at,
        reviewer: 'human',
        reason: 'stale',
      }),
    ).toThrow('changed');
    const revoked = review(service, saved.id, 'rejected');
    expect(revoked.problem).toBe(saved.problem);
    expect(revoked.solution).toBe(saved.solution);
    expect(
      db
        .prepare('SELECT previous_status, decision FROM experience_reviews ORDER BY created_at')
        .all(),
    ).toEqual([
      { previous_status: 'candidate', decision: 'approved' },
      { previous_status: 'approved', decision: 'rejected' },
    ]);
  });
  it('rolls back approval if its audit entry cannot be committed', () => {
    const { service, db } = fixture();
    const saved = record(service);
    db.exec(
      "CREATE TRIGGER reject_review BEFORE INSERT ON experience_reviews BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    );
    expect(() => review(service, saved.id)).toThrow();
    expect(service.inspect(saved.id)).toEqual(saved);
    expect(db.prepare('SELECT COUNT(*) AS n FROM experience_reviews').get()).toEqual({ n: 0 });
  });
  it('bounds search payloads, clips previews and safely handles FTS operators', () => {
    const { service } = fixture();
    for (let i = 0; i < 12; i++)
      record(service, {
        problem: `SQLite context ${i}`,
        solution: `SQLite ${'detail '.repeat(500)}`,
      });
    const result = service.search({ query: 'SQLite', limit: 10, max_chars: 2048 });
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(2048);
    expect(result.truncated).toBe(true);
    expect(result.experiences[0]?.content_truncated).toBe(true);
    expect(service.search({ query: '" * : ()' }).experiences).toEqual([]);
    expect(service.search({ query: "' OR 1=1; DROP TABLE experiences" }).experiences).toEqual([]);
    expect(service.search({ query: 'SQLite' }).experiences.length).toBeLessThanOrEqual(3);
    for (const extra of [
      { limit: 11 },
      { max_chars: 50000 },
      { query: '' },
      { query: 'x'.repeat(501) },
    ])
      expect(() => service.search({ query: 'SQLite', ...extra })).toThrow();
  });
});

describe('migration and durability', () => {
  it('upgrades schema v2 without modifying Phase 0 memory and reopens experiences after restart', () => {
    const { db, service, project, path } = fixture();
    const memory = new MemoryService(db, project, 'codex').save({
      title: 'Legacy memory',
      content: 'SQLite Phase zero decision',
    });
    removeSkillSchema(db);
    db.exec(
      'DROP TABLE experience_reviews; DROP TABLE experiences_fts; DROP TABLE experiences; PRAGMA user_version = 2',
    );
    migrate(db);
    migrate(db);
    expect(db.pragma('user_version', { simple: true })).toBe(12);
    expect(new MemoryService(db, project).search({ query: 'SQLite' })).toEqual([memory]);
    const saved = review(service, record(service).id);
    db.close();
    const reopened = openDatabase(path);
    try {
      expect(new ExperienceService(reopened, project, 'claude').inspect(saved.id)).toEqual(saved);
      expect(
        new ExperienceService(reopened, project).search({ query: 'SQLite', status: 'approved' })
          .experiences[0]?.id,
      ).toBe(saved.id);
      expect(reopened.pragma('foreign_key_check')).toEqual([]);
    } finally {
      reopened.close();
    }
  });
  it('rolls back migration v3 failures and restores foreign-key enforcement', () => {
    const { db } = fixture();
    removeSkillSchema(db);
    db.exec(
      'DROP TABLE experience_reviews; DROP TABLE experiences_fts; DROP TABLE experiences; CREATE TABLE experience_reviews(id TEXT); PRAGMA user_version = 2',
    );
    expect(() => migrate(db)).toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'experiences'").get(),
    ).toBeUndefined();
  });
});

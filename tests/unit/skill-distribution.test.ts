import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const filesystemFaults = vi.hoisted(() => ({ stopStageRename: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (filesystemFaults.stopStageRename && String(args[0]).endsWith('.stage'))
        throw new Error('simulated interrupted publish');
      return actual.renameSync(...args);
    },
  };
});
// Only these filesystem tests simulate the already-verified operator grant. Production exposes no injectable authorizer.
vi.mock('../../packages/core/src/operator-confirmation.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../packages/core/src/operator-confirmation.js')>();
  return {
    ...actual,
    consumeOperatorGrant: (_grant: unknown, digest: string) => ({
      operator: 'synthetic-fs-test',
      session: randomUUID(),
      digest,
    }),
  };
});

import {
  migrate,
  openDatabaseReadOnly,
  SkillDistributionService,
} from '../../packages/core/src/index.js';
import { INSTALLATION_MANIFEST } from '../../packages/core/src/skill-distribution-files.js';
import { distributionFixture } from '../helpers/distribution-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  filesystemFaults.stopStageRename = false;
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture(active = true, name?: string) {
  const f = distributionFixture(active, name);
  cleanup.push(f.close);
  return f;
}
function sync(f: ReturnType<typeof fixture>, input: object = f.request) {
  return f.service.commit(input, {});
}
function codex(f: ReturnType<typeof fixture>) {
  return join(f.root, '.agents', 'skills', f.candidate.identity.name);
}

describe('P2-006 deterministic planning and faithful publication', () => {
  it('plans without filesystem or database mutations and publishes the exact approved package to both targets', () => {
    const f = fixture();
    const before = f.db.prepare('SELECT COUNT(*) AS n FROM skill_distribution_events').get();
    const first = f.service.plan(f.request);
    expect(f.service.plan(f.request)).toEqual(first);
    expect(first.entries.map((e) => e.action)).toEqual(['INSTALL', 'INSTALL']);
    expect(fs.existsSync(join(f.root, '.agents'))).toBe(false);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_distribution_events').get()).toEqual(
      before,
    );
    sync(f);
    for (const target of ['.agents', '.claude']) {
      const dest = join(f.root, target, 'skills', f.candidate.identity.name);
      for (const file of f.candidate.version.files)
        expect(readFileSync(join(dest, file.path), 'utf8')).toBe(file.content);
      const manifest = JSON.parse(readFileSync(join(dest, INSTALLATION_MANIFEST), 'utf8'));
      expect(manifest).toMatchObject({
        schema_version: 1,
        agentmind_managed: true,
        project_id: f.scope.id,
        version_id: f.candidate.version.id,
        registry_digest: f.candidate.version.content_hash,
        installed_digest: f.candidate.version.content_hash,
        destination: fs.realpathSync(dest),
      });
    }
    expect(f.service.plan(f.request).entries.map((e) => e.action)).toEqual(['SKIP', 'SKIP']);
  });
  it('is idempotent, records verification, and safely removes only managed packages', () => {
    const f = fixture();
    sync(f);
    const original = readFileSync(join(codex(f), INSTALLATION_MANIFEST), 'utf8');
    const unrelated = join(f.root, '.agents', 'skills', 'unrelated');
    mkdirSync(unrelated);
    writeFileSync(join(unrelated, 'SKILL.md'), 'user-owned');
    sync(f);
    expect(readFileSync(join(codex(f), INSTALLATION_MANIFEST), 'utf8')).toBe(original);
    expect(f.service.verify(f.request).entries.every((e) => e.action === 'SKIP')).toBe(true);
    expect(
      (
        f.db.prepare('SELECT last_verified_at FROM skill_installations LIMIT 1').get() as {
          last_verified_at: string;
        }
      ).last_verified_at,
    ).toBeTruthy();
    sync(f, { ...f.request, operation: 'remove' });
    expect(fs.existsSync(codex(f))).toBe(false);
    expect(readFileSync(join(unrelated, 'SKILL.md'), 'utf8')).toBe('user-owned');
    expect(
      f.service
        .plan({ ...f.request, operation: 'remove' })
        .entries.every((e) => e.action === 'SKIP'),
    ).toBe(true);
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
  it('does not distribute a candidate or inactive version and rejects arbitrary version/scope/target selectors', () => {
    const f = fixture(false);
    expect(f.service.plan(f.request).entries.every((e) => e.action === 'SKIP')).toBe(true);
    sync(f);
    expect(fs.existsSync(codex(f))).toBe(false);
    for (const extra of [
      { version_id: f.candidate.version.id },
      { target: 'gemini' },
      { destination: '/tmp/arbitrary' },
      { project_id: 'foreign' },
    ])
      expect(() => f.service.plan({ ...f.request, ...extra })).toThrow('Select an exact');
    f.evaluate(f.candidate.version.id);
    f.approve(f.candidate.version.id);
    expect(f.service.plan(f.request).entries.every((e) => e.action === 'SKIP')).toBe(true);
  });
  it('updates managed copies and converges after registry rollback without changing authoring or approval', () => {
    const f = fixture();
    sync(f);
    f.transition(f.candidate.identity.id, null, 'deactivate');
    const changed = f.propose('Version two.');
    f.evaluate(changed.version.id);
    f.approve(changed.version.id);
    f.promote(changed.version.id);
    expect(f.service.plan(f.request).entries.every((e) => e.action === 'UPDATE')).toBe(true);
    sync(f);
    expect(readFileSync(join(codex(f), 'SKILL.md'), 'utf8')).toContain('Version two.');
    f.promote(f.candidate.version.id, 'rollback');
    expect(f.service.plan(f.request).entries.every((e) => e.action === 'UPDATE')).toBe(true);
    sync(f);
    expect(readFileSync(join(codex(f), 'SKILL.md'), 'utf8')).toBe(
      f.candidate.version.files[0]?.content,
    );
  });
  it('plans explicit removal during an activation gap, without publishing the next candidate', () => {
    const f = fixture();
    sync(f);
    f.transition(f.candidate.identity.id, null, 'deactivate');
    f.propose('Still draft.');
    expect(f.service.plan(f.request).entries.every((e) => e.action === 'REMOVE')).toBe(true);
    sync(f);
    expect(fs.existsSync(codex(f))).toBe(false);
  });
  it('supports explicitly selected fake user homes and detects cross-project/global name conflicts', () => {
    const f = fixture();
    sync(f, { ...f.request, scope: 'user' });
    expect(
      fs.existsSync(join(f.home, '.agents', 'skills', f.candidate.identity.name, 'SKILL.md')),
    ).toBe(true);
    expect(fs.existsSync(codex(f))).toBe(false);
    const foreign = new SkillDistributionService(f.db, f.otherScope, f.home);
    expect(() => foreign.plan(f.request)).toThrow('not available');
  });
});

describe('P2-006 filesystem conflicts and integrity', () => {
  it('does not overwrite user-owned collisions or trust a copied manifest without a database record', () => {
    const f = fixture();
    sync(f, { ...f.request, target: 'codex' });
    const forgedManifest = readFileSync(join(codex(f), INSTALLATION_MANIFEST), 'utf8');
    f.db.prepare('DELETE FROM skill_installations WHERE target=?').run('codex');
    expect(f.service.plan({ ...f.request, target: 'codex' }).entries[0]?.action).toBe('CONFLICT');
    expect(() => sync(f, { ...f.request, target: 'codex' })).toThrow('conflict');
    expect(readFileSync(join(codex(f), INSTALLATION_MANIFEST), 'utf8')).toBe(forgedManifest);
  });
  it.each([
    'content',
    'missing-support',
    'extra-file',
    'extra-directory',
    'forged-manifest',
    'directory-substitution',
  ])('preserves modified managed installations: %s', (kind) => {
    const f = fixture();
    sync(f);
    const dest = codex(f);
    if (kind === 'content') writeFileSync(join(dest, 'SKILL.md'), 'local edits');
    if (kind === 'missing-support') rmSync(join(dest, 'references', 'notes.md'));
    if (kind === 'extra-file') writeFileSync(join(dest, 'user.md'), 'user content');
    if (kind === 'extra-directory') mkdirSync(join(dest, 'user-directory'));
    if (kind === 'forged-manifest') {
      const m = JSON.parse(readFileSync(join(dest, INSTALLATION_MANIFEST), 'utf8'));
      m.version = 999;
      writeFileSync(join(dest, INSTALLATION_MANIFEST), JSON.stringify(m));
    }
    if (kind === 'directory-substitution') {
      renameSync(dest, `${dest}-old`);
      mkdirSync(dest);
      for (const file of f.candidate.version.files) {
        mkdirSync(join(dest, fsPathParent(file.path)), { recursive: true });
        writeFileSync(join(dest, file.path), file.content);
      }
      writeFileSync(
        join(dest, INSTALLATION_MANIFEST),
        readFileSync(join(`${dest}-old`, INSTALLATION_MANIFEST)),
      );
    }
    expect(f.service.plan(f.request).entries[0]?.action).toBe('CONFLICT');
    expect(() => sync(f, { ...f.request, operation: 'remove' })).toThrow('conflict');
    expect(fs.existsSync(dest)).toBe(true);
  });
  it('repairs an entirely missing managed installation through the normal authorized workflow', () => {
    const f = fixture();
    sync(f);
    rmSync(codex(f), { recursive: true });
    expect(f.service.plan(f.request).entries[0]?.action).toBe('REPAIR');
    sync(f);
    expect(f.service.plan(f.request).entries[0]?.action).toBe('SKIP');
  });
  it.each(['parent', 'destination', 'support', 'work'])(
    'rejects static symlink escapes: %s',
    (kind) => {
      const f = fixture();
      const outside = join(f.root, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'keep'), 'untouched');
      if (kind === 'parent') symlinkSync(outside, join(f.root, '.agents'));
      else if (kind === 'work') {
        mkdirSync(join(f.root, '.agentmind'));
        symlinkSync(outside, join(f.root, '.agentmind', 'distribution-v1'));
      } else {
        sync(f);
        if (kind === 'destination') {
          renameSync(codex(f), `${codex(f)}-old`);
          symlinkSync(outside, codex(f));
        } else {
          rmSync(join(codex(f), 'references', 'notes.md'));
          symlinkSync(join(outside, 'keep'), join(codex(f), 'references', 'notes.md'));
        }
      }
      expect(f.service.plan(f.request).entries[0]?.action).toBe('CONFLICT');
      expect(() => sync(f)).toThrow('conflict');
      expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('untouched');
    },
  );
  it('refuses untrusted active provenance, tampered registry hashes and reserved Claude names', () => {
    const f = fixture();
    f.db.exec('DROP TRIGGER skill_versions_immutable_update');
    f.db
      .prepare('UPDATE skill_versions SET content_hash=? WHERE id=?')
      .run('0'.repeat(64), f.candidate.version.id);
    expect(f.service.plan(f.request).entries.every((e) => e.action === 'CONFLICT')).toBe(true);
    const reserved = fixture(true, 'synced');
    expect(
      reserved.service.plan({ ...reserved.request, target: 'claude' }).entries[0]?.action,
    ).toBe('CONFLICT');
  });
  it('detects opposite-scope user-owned names which could shadow a project skill', () => {
    const f = fixture();
    const dest = join(f.home, '.claude', 'skills', f.candidate.identity.name);
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'SKILL.md'), 'unrelated user skill');
    expect(f.service.plan({ ...f.request, target: 'claude' }).entries[0]?.action).toBe('CONFLICT');
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf8')).toBe('unrelated user skill');
  });
  it('refuses active content after source revocation or missing operator transition provenance', () => {
    const revoked = fixture();
    const current = revoked.experiences.inspect(revoked.approvedSource.id);
    revoked.experiences.review({
      id: current.id,
      expected_updated_at: current.updated_at,
      decision: 'rejected',
      reviewer: 'fixture reviewer',
      reason: 'Revoked for distribution eligibility test.',
    });
    expect(
      revoked.service.plan(revoked.request).entries.every((e) => e.action === 'CONFLICT'),
    ).toBe(true);
    const legacy = fixture();
    legacy.db.exec('DROP TRIGGER skill_operator_no_delete');
    legacy.db.prepare("DELETE FROM skill_operator_events WHERE action='promote'").run();
    expect(legacy.service.plan(legacy.request).entries.every((e) => e.action === 'CONFLICT')).toBe(
      true,
    );
    expect(fs.existsSync(codex(legacy))).toBe(false);
  });
  it('keeps distribution audit append-only and binds installation records to scoped versions', () => {
    const f = fixture();
    sync(f);
    const row = f.db.prepare('SELECT id FROM skill_distribution_events LIMIT 1').get() as {
      id: string;
    };
    expect(() =>
      f.db.prepare('DELETE FROM skill_distribution_events WHERE id=?').run(row.id),
    ).toThrow('immutable');
    expect(() =>
      f.db.prepare("UPDATE skill_distribution_events SET outcome='forged' WHERE id=?").run(row.id),
    ).toThrow('immutable');
    expect(() =>
      f.db.prepare('UPDATE skill_installations SET project_id=?').run(f.otherScope.id),
    ).toThrow();
    expect(f.db.pragma('foreign_key_check')).toEqual([]);
  });
});

function fsPathParent(path: string) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.';
}

it('opens planning connections read-only, refuses migration in dry-run, and rolls back v8 migration failures', () => {
  const f = fixture();
  const read = openDatabaseReadOnly(f.path);
  try {
    const service = new SkillDistributionService(read, f.scope, f.home);
    expect(service.plan(f.request).entries[0]?.action).toBe('INSTALL');
    expect(() => read.exec("UPDATE skills SET description='changed'")).toThrow();
  } finally {
    read.close();
  }
  f.db.exec(
    'DROP TABLE IF EXISTS schema_migrations; DROP INDEX IF EXISTS memories_scope_recent; DROP INDEX IF EXISTS experiences_scope_recent; DROP TABLE IF EXISTS skill_usage_cleanup; DROP TABLE IF EXISTS skill_usage_events; DROP TABLE IF EXISTS skill_usage_dedup; DROP TABLE skill_distribution_events; DROP TABLE skill_distribution_intents; DROP TABLE skill_installations; DROP TABLE skill_registry_identity; PRAGMA user_version=7',
  );
  expect(() => openDatabaseReadOnly(f.path)).toThrow('migrate');
  const old = f.store.getVersion(f.candidate.version.id);
  const original = f.db.exec.bind(f.db);
  const failure = vi.spyOn(f.db, 'exec').mockImplementation((sql) => {
    if (sql.includes('PRAGMA user_version = 8')) {
      original(sql.slice(0, sql.indexOf('CREATE TRIGGER')));
      throw new Error('fixture v8 failure');
    }
    return original(sql);
  });
  expect(() => migrate(f.db)).toThrow('fixture v8 failure');
  failure.mockRestore();
  expect(f.db.pragma('user_version', { simple: true })).toBe(7);
  expect(f.db.pragma('foreign_keys', { simple: true })).toBe(1);
  migrate(f.db);
  expect(f.db.pragma('user_version', { simple: true })).toBe(12);
  expect(f.store.getVersion(f.candidate.version.id)).toEqual(old);
});

it('recovers a database failure after publishing without claiming cross-resource atomicity', () => {
  const f = fixture();
  const request = { ...f.request, target: 'codex' };
  f.db.exec(
    "CREATE TRIGGER fixture_installation_fail BEFORE INSERT ON skill_installations BEGIN SELECT RAISE(ABORT,'fixture installation failure'); END",
  );
  expect(() => sync(f, request)).toThrow('not one atomic transaction');
  expect(fs.existsSync(join(codex(f), 'SKILL.md'))).toBe(true);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM skill_installations').get()).toEqual({ n: 0 });
  expect(f.service.plan(request).entries[0]?.action).toBe('REPAIR');
  f.db.exec('DROP TRIGGER fixture_installation_fail');
  sync(f, request);
  expect(f.service.plan(request).entries[0]?.action).toBe('SKIP');
  expect(
    (
      f.db
        .prepare("SELECT COUNT(*) AS n FROM skill_distribution_intents WHERE status='pending'")
        .get() as { n: number }
    ).n,
  ).toBe(0);
});

it('recovers interrupted replacement, then re-plans to converge both targets', () => {
  const f = fixture();
  sync(f);
  f.transition(f.candidate.identity.id, null, 'deactivate');
  const next = f.propose('Replacement version.');
  f.evaluate(next.version.id);
  f.approve(next.version.id);
  f.promote(next.version.id);
  filesystemFaults.stopStageRename = true;
  expect(() => sync(f)).toThrow('not one atomic transaction');
  expect(
    f.db
      .prepare("SELECT COUNT(*) AS n FROM skill_distribution_intents WHERE status='pending'")
      .get(),
  ).toEqual({ n: 2 });
  filesystemFaults.stopStageRename = false;
  sync(f); // Recovery can finish the moved copy and abort the not-yet-started sibling.
  sync(f); // A fresh authorized convergence plan updates any remaining old sibling.
  expect(f.service.plan(f.request).entries.every((e) => e.action === 'SKIP')).toBe(true);
  expect(readFileSync(join(codex(f), 'SKILL.md'), 'utf8')).toContain('Replacement version.');
  expect(fs.readdirSync(join(f.root, '.agentmind', 'distribution-v1'))).toEqual([]);
});
it('does not publish a staged version that ceased being active before recovery', () => {
  const f = fixture();
  sync(f);
  f.transition(f.candidate.identity.id, null, 'deactivate');
  const next = f.propose('Stale staged version.');
  f.evaluate(next.version.id);
  f.approve(next.version.id);
  f.promote(next.version.id);
  filesystemFaults.stopStageRename = true;
  expect(() => sync(f, { ...f.request, target: 'codex' })).toThrow();
  filesystemFaults.stopStageRename = false;
  f.promote(f.candidate.version.id, 'rollback');
  sync(f, { ...f.request, target: 'codex' }); // Abort unpublished work; no stale version is copied.
  expect(fs.existsSync(codex(f))).toBe(false);
  sync(f, { ...f.request, target: 'codex' });
  expect(readFileSync(join(codex(f), 'SKILL.md'), 'utf8')).toBe(
    f.candidate.version.files[0]?.content,
  );
});
it("a foreign project cannot remove another project's global installation with the same name", () => {
  const f = fixture();
  sync(f, { ...f.request, scope: 'user' });
  const id = f.identity(f.candidate.identity.name, f.otherScope);
  const foreign = new SkillDistributionService(f.db, f.otherScope, f.home);
  expect(
    foreign
      .plan({ skill_id: id, target: 'all', scope: 'user', operation: 'remove' })
      .entries.every((e) => e.action === 'CONFLICT'),
  ).toBe(true);
  expect(() =>
    foreign.commit({ skill_id: id, target: 'all', scope: 'user', operation: 'remove' }, {}),
  ).toThrow('conflict');
  expect(
    fs.existsSync(join(f.home, '.agents', 'skills', f.candidate.identity.name, 'SKILL.md')),
  ).toBe(true);
});

it('an obsolete worker cannot publish after another recovery takes ownership', () => {
  const f = fixture();
  const request = { ...f.request, target: 'codex' };
  f.db.exec(
    "CREATE TRIGGER fixture_takeover AFTER UPDATE OF stage_identity ON skill_distribution_intents WHEN NEW.stage_identity IS NOT NULL BEGIN UPDATE skill_distribution_intents SET worker_id='11111111-1111-4111-8111-111111111111' WHERE id=NEW.id; END",
  );
  expect(() => sync(f, request)).toThrow('not one atomic transaction');
  expect(fs.existsSync(codex(f))).toBe(false);
  f.db.exec('DROP TRIGGER fixture_takeover');
  sync(f, request);
  expect(f.service.plan(request).entries[0]?.action).toBe('SKIP');
});
it('preserves an unproven orphan stage and releases the slot for a new authorized plan', () => {
  const f = fixture();
  const request = { ...f.request, target: 'codex' };
  f.db.exec(
    "CREATE TRIGGER fixture_stage_stamp_fail BEFORE UPDATE OF stage_identity ON skill_distribution_intents BEGIN SELECT RAISE(ABORT,'crash before ownership stamp'); END",
  );
  expect(() => sync(f, request)).toThrow();
  const pending = f.db
    .prepare("SELECT id FROM skill_distribution_intents WHERE status='pending'")
    .get() as { id: string };
  const orphan = join(f.root, '.agentmind', 'distribution-v1', `${pending.id}.stage`);
  expect(fs.existsSync(orphan)).toBe(true);
  f.db.exec('DROP TRIGGER fixture_stage_stamp_fail');
  const recovered = sync(f, request);
  expect(recovered.results[0]).toMatchObject({ status: 'REPAIR', retained_work: true });
  expect(fs.existsSync(orphan)).toBe(true);
  expect(fs.existsSync(codex(f))).toBe(false);
  sync(f, request);
  expect(f.service.plan(request).entries[0]?.action).toBe('SKIP');
});

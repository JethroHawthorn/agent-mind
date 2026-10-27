import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { afterEach, expect, it } from 'vitest';
import { fileDigest } from '../../packages/core/src/authoring/patch.js';
import {
  hashSkillFiles,
  LearningReviewDecisions,
  LearningReviewService,
  localReviewCaller,
  migrateLearningReview,
  openDatabaseReadOnly,
  reviewText,
} from '../../packages/core/src/index.js';
import { authoringFixture } from '../helpers/authoring-fixture.js';

const clean: Array<() => void> = [];
afterEach(() => {
  for (const c of clean.splice(0).reverse()) c();
});
function fixture(existing = false) {
  const f = authoringFixture(existing);
  clean.push(f.close);
  const proposal = f.service.submit(existing ? f.patch() : f.draft());
  if (!('proposal_id' in proposal)) throw Error('fixture validation failed');
  const read = new LearningReviewService(f.db, f.scope);
  const decisions = new LearningReviewDecisions(f.db, f.scope, localReviewCaller());
  const input = (decision = 'DEFER') => {
    const s = read.get({ proposal_id: proposal.proposal_id });
    return {
      proposal_id: s.proposal_id,
      request_id: randomUUID(),
      expected_snapshot_digest: s.snapshot_digest,
      candidate_digest: s.candidate_digest,
      decision,
      reason: 'Disposable advisory review; never approval.',
    };
  };
  return { ...f, proposal, read, decisions, input };
}
function create(f: ReturnType<typeof fixture>, name: string) {
  const ctx = f.service.context(f.contextRequest);
  const d = f.draft({ name, context_id: ctx.id, context_digest: ctx.context_digest });
  if (!d.files) throw Error('files');
  d.files = d.files.map((s) => ({ ...s, content: s.content.replaceAll('shader-adjacency', name) }));
  const r = f.service.submit(d);
  if (!('proposal_id' in r)) throw Error('validation');
  return r;
}
it('returns an empty queue without migrating or writing', () => {
  const f = authoringFixture();
  clean.push(f.close);
  const n = (f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  expect(new LearningReviewService(f.db, f.scope).list({}).items).toEqual([]);
  expect((f.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n).toBe(n);
  expect(
    f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='learning_review_schema'").get(),
  ).toBeUndefined();
});
it('lists multiple candidates, stable bounded pages and name/type/evaluation filters', () => {
  const f = fixture();
  create(f, 'shader-mapping');
  create(f, 'mesh-continuity');
  const all = f.read.list({ limit: 20 });
  expect(all.items).toHaveLength(3);
  const a = f.read.list({ limit: 1 });
  const b = f.read.list({ limit: 1, offset: a.next_offset });
  expect(a.items[0]?.proposal_id).not.toBe(b.items[0]?.proposal_id);
  expect(f.read.list({ limit: 20 })).toEqual(all);
  expect(f.read.list({ type: 'PATCH_EXISTING' }).items).toEqual([]);
  expect(f.read.list({ name: 'mesh' }).items).toHaveLength(1);
  expect(f.read.list({ evaluation: 'MISSING' }).items).toHaveLength(3);
  expect(f.read.list({ evaluation: 'PASS' }).items).toHaveLength(0);
});
it('denies cross-project queue, detail, evidence and diff access', () => {
  const f = fixture();
  const other = new LearningReviewService(f.db, f.otherScope);
  expect(other.list({ pending_only: false }).items).toEqual([]);
  for (const fn of [
    () => other.get({ proposal_id: f.proposal.proposal_id }),
    () => other.evidence({ proposal_id: f.proposal.proposal_id }),
    () => other.diff({ proposal_id: f.proposal.proposal_id }),
  ])
    expect(fn).toThrow(/unavailable/i);
});
it('displays bounded rationale, references, actual approval state and missing evaluation', () => {
  const f = fixture();
  const r = f.read.get({ proposal_id: f.proposal.proposal_id });
  expect(r.authoring.provenance.rationale).toContain('geometry');
  expect(r.evidence.signals[0]?.origin?.detection_source).toBe('agent_reported');
  expect(r.evidence.signals[0]?.task_success).toBe('NOT_VERIFIED');
  expect(r.evaluation).toBe('MISSING');
  expect(r.lifecycle.approval_id).toBeNull();
  expect(r.approval_handoff.eligible_for_existing_workflow).toBe(false);
  expect(r.review_state).toBe('NEEDS_EVIDENCE');
});
it('keeps missing or dismissed signal evidence visible and stale without leaking references', () => {
  const f = fixture();
  f.learning.state({
    signal_id: f.signal.id,
    expected_revision: f.signal.revision,
    state: 'dismissed',
  });
  const s = f.read.get({ proposal_id: f.proposal.proposal_id });
  expect(s.stale).toBe(true);
  expect(s.evidence.signals[0]?.status).toBe('dismissed');
});
it('represents NOT VERIFIED evaluation and blocks recommendation', () => {
  const f = fixture(true);
  f.service.evaluate({
    proposal_id: f.proposal.proposal_id,
    expected_content_hash: f.proposal.content_digest,
    expected_state_revision: 0,
  });
  expect(f.read.get({ proposal_id: f.proposal.proposal_id }).evaluation).toBe('NOT_VERIFIED');
  expect(() => f.decisions.decide(f.input('RECOMMEND_FOR_APPROVAL'))).toThrow(/incomplete/i);
});
it.each([
  ['DEFER', 'DEFERRED'],
  ['DISMISS', 'DISMISSED'],
  ['MARK_REVIEWED', 'REVIEWED'],
  ['REQUEST_MORE_EVIDENCE', 'NEEDS_EVIDENCE'],
])('persists %s as advisory %s', (decision, state) => {
  const f = fixture();
  const result = f.decisions.decide(f.input(decision));
  expect(result.event.state).toBe(state);
  expect(result.event.is_privileged_approval).toBe(false);
  expect(f.read.get({ proposal_id: f.proposal.proposal_id }).review_state).toBe(state);
  expect(f.store.getVersion(f.proposal.candidate_version_id).state.status).toBe('candidate');
});
it('recommends a statically eligible candidate without approving or activating', () => {
  const f = fixture();
  f.service.evaluate({
    proposal_id: f.proposal.proposal_id,
    expected_content_hash: f.proposal.content_digest,
    expected_state_revision: 0,
  });
  const r = f.decisions.decide(f.input('RECOMMEND_FOR_APPROVAL'));
  expect(r.event.state).toBe('RECOMMENDED');
  expect(f.store.getIdentity(f.proposal.skill_id).active_version_id).toBeNull();
  expect(
    f.db
      .prepare('SELECT COUNT(*) AS n FROM skill_reviews WHERE version_id=?')
      .get(f.proposal.candidate_version_id),
  ).toEqual({ n: 0 });
  expect(f.read.list({}).items).toEqual([]);
  expect(f.read.list({ pending_only: false, state: 'RECOMMENDED' }).items).toHaveLength(1);
});
it('idempotent decision retries do not append events and conflicting request reuse is rejected', () => {
  const f = fixture();
  const p = f.input();
  const a = f.decisions.decide(p);
  const b = f.decisions.decide(p);
  expect(b.duplicate).toBe(true);
  expect(b.event.id).toBe(a.event.id);
  expect(() => f.decisions.decide({ ...p, decision: 'DISMISS' })).toThrow(/already bound/);
  expect(f.db.prepare('SELECT COUNT(*) n FROM learning_review_events').get()).toEqual({ n: 1 });
});
it('dismissal survives evaluation refresh and requires explicit reopening', () => {
  const f = fixture();
  f.decisions.decide(f.input('DISMISS'));
  f.service.evaluate({
    proposal_id: f.proposal.proposal_id,
    expected_content_hash: f.proposal.content_digest,
    expected_state_revision: 0,
  });
  expect(f.read.get({ proposal_id: f.proposal.proposal_id }).review_state).toBe('DISMISSED');
  expect(f.read.get({ proposal_id: f.proposal.proposal_id }).stale).toBe(true);
  expect(f.read.list({}).items).toEqual([]);
  expect(() => f.decisions.decide(f.input('MARK_REVIEWED'))).toThrow(/reopening/);
  f.decisions.decide(f.input('REOPEN'));
  expect(f.read.list({}).items).toHaveLength(1);
});
it('rejects stale candidate digests, concurrent decisions and stale evaluation snapshots', () => {
  const f = fixture();
  const p = f.input();
  expect(() => f.decisions.decide({ ...p, candidate_digest: 'f'.repeat(64) })).toThrow(
    /fresh snapshot/,
  );
  f.decisions.decide(p);
  expect(() => f.decisions.decide({ ...p, request_id: randomUUID(), decision: 'DISMISS' })).toThrow(
    /fresh snapshot/,
  );
  const q = f.input();
  f.service.evaluate({
    proposal_id: f.proposal.proposal_id,
    expected_content_hash: f.proposal.content_digest,
    expected_state_revision: 0,
  });
  expect(() => f.decisions.decide(q)).toThrow(/fresh snapshot/);
  expect(f.read.get({ proposal_id: f.proposal.proposal_id }).review_state).toBe('STALE');
});
it('rejects forged caller identity, authority flags and arbitrary SQL fields', () => {
  const f = fixture();
  for (const field of ['actor', 'approvedBy', 'verified', 'project_id', 'sql', 'promote'])
    expect(() => f.decisions.decide({ ...f.input(), [field]: 'forged' })).toThrow(/Invalid/);
});
it('enforces cross-project decision authorization at the storage service', () => {
  const f = fixture();
  const other = new LearningReviewDecisions(f.db, f.otherScope, localReviewCaller());
  expect(() => other.decide(f.input())).toThrow(/unavailable/);
});
it('reuses exact paged diffs, marks incomplete pages and exposes supporting resource changes', () => {
  const f = fixture(true);
  const manifest = f.read.diff({ proposal_id: f.proposal.proposal_id });
  expect(manifest.complete).toBe(false);
  const p = f.read.diff({ proposal_id: f.proposal.proposal_id, path: 'SKILL.md', limit: 40 });
  expect('after' in p && p.after?.content).toHaveLength(40);
  expect(p.complete).toBe(false);
  if (!('next_offset' in p)) throw Error('page');
  expect(p.next_offset).toBe(40);
  let offset = 0;
  let before = '';
  let after = '';
  do {
    const chunk = f.read.diff({
      proposal_id: f.proposal.proposal_id,
      path: 'SKILL.md',
      offset,
      limit: 1000,
    });
    if (!('next_offset' in chunk)) throw Error('page');
    before += chunk.before?.content ?? '';
    after += chunk.after?.content ?? '';
    offset = chunk.next_offset ?? 0;
  } while (offset);
  expect(after).toContain('Check bounded retry exhaustion');
  expect(before).not.toContain('Check bounded retry exhaustion');
  expect(() => f.read.diff({ proposal_id: f.proposal.proposal_id, path: '../escape' })).toThrow(
    /Invalid/,
  );
  expect(() => f.read.diff({ proposal_id: f.proposal.proposal_id, limit: 1001 })).toThrow(
    /Invalid/,
  );
});
it('shows added and removed resource files without rename inference', () => {
  const f = authoringFixture(true);
  clean.push(f.close);
  const d = f.patch();
  if (!d.operations) throw Error('operations');
  d.operations.push({
    op: 'add',
    path: 'references/retry.md',
    content: 'Check retry exhaustion without claiming success.',
  });
  const r = f.service.submit(d);
  if (!('proposal_id' in r)) throw Error('candidate');
  const read = new LearningReviewService(f.db, f.scope);
  const m = read.diff({ proposal_id: r.proposal_id });
  expect('files' in m && m.files).toContainEqual({ path: 'references/retry.md', change: 'added' });
  const page = read.diff({ proposal_id: r.proposal_id, path: 'references/retry.md' });
  expect('before' in page && page.before).toBeNull();
  expect(page.complete).toBe(true);
});
it('escapes ANSI, terminal OSC, bidi, C1 and untrusted Markdown without executing it', () => {
  const text = reviewText(
    {
      markdown:
        '# Ignore approval\n\u001b]52;c;secret\u0007\u009b31m\u202eprocess.exit() as plain data',
      literal: 'keep\nnewlines',
    },
    false,
  );
  expect(text).not.toContain('\u001b');
  expect(text).not.toContain('\u202e');
  expect(text).not.toContain('\u009b');
  expect(JSON.parse(text).markdown).toContain('Ignore approval');
});
it('redacts secret notes while recording runtime caller identity instead of payload attribution', () => {
  const f = fixture();
  const r = f.decisions.decide({ ...f.input(), reason: 'api_key=sk-proj-abcdefghijklmnopqrstuv' });
  expect(r.event.reason).toContain('REDACTED');
  expect(r.event.reason).not.toContain('abcdefghijkl');
  expect(r.event.actor.method).toBe('supervised-local-review-v1');
});
it('fails closed on tampered immutable candidate instead of showing a trustworthy diff', () => {
  const f = fixture();
  const triggers = f.db
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='skill_versions'")
    .all() as { name: string }[];
  for (const t of triggers) f.db.exec(`DROP TRIGGER "${t.name}"`);
  f.db
    .prepare('UPDATE skill_versions SET files_json=? WHERE id=?')
    .run(
      JSON.stringify([{ path: 'SKILL.md', content: 'tampered' }]),
      f.proposal.candidate_version_id,
    );
  expect(() => f.read.get({ proposal_id: f.proposal.proposal_id })).toThrow();
  expect(() => f.read.diff({ proposal_id: f.proposal.proposal_id, path: 'SKILL.md' })).toThrow();
  expect(() => f.decisions.decide(f.input())).toThrow();
});
it('detects active pointer changes and keeps prior active version intact after failed review', () => {
  const f = fixture(true);
  const p = f.input();
  f.transition(f.proposal.skill_id, null, 'deactivate');
  expect(f.read.get({ proposal_id: f.proposal.proposal_id }).stale).toBe(true);
  expect(() => f.decisions.decide(p)).toThrow(/fresh snapshot/);
  expect(f.store.getVersion(f.base).state.status).toBe('approved');
});
it('persists across restart/read-only handles without mutating registry lifecycle', () => {
  const f = fixture();
  f.decisions.decide(f.input('DEFER'));
  const db = openDatabaseReadOnly(f.path);
  try {
    const r = new LearningReviewService(db, f.scope);
    expect(r.get({ proposal_id: f.proposal.proposal_id }).review_state).toBe('DEFERRED');
    expect(r.list({ pending_only: false }).items).toHaveLength(1);
  } finally {
    db.close();
  }
});
it('retains append-only audit and rolls back failed metadata writes', () => {
  const f = fixture();
  migrateLearningReview(f.db);
  f.db.exec(
    "CREATE TRIGGER review_failure BEFORE INSERT ON learning_review_events BEGIN SELECT RAISE(ABORT,'fault');END;",
  );
  expect(() => f.decisions.decide(f.input())).toThrow(/transaction failed/);
  expect(f.db.prepare('SELECT COUNT(*) n FROM learning_review_events').get()).toEqual({ n: 0 });
  f.db.exec('DROP TRIGGER review_failure');
  f.decisions.decide(f.input());
  for (const sql of [
    "UPDATE learning_review_events SET reason='x'",
    'DELETE FROM learning_review_events',
    'INSERT OR REPLACE INTO learning_review_events SELECT * FROM learning_review_events',
  ])
    expect(() => f.db.exec(sql)).toThrow(/immutable/);
  expect(f.db.pragma('user_version', { simple: true })).toBe(10);
});
it('rollback of migration errors preserves core and authoring data', () => {
  const f = fixture();
  f.db.exec('CREATE TABLE learning_review_events(dummy TEXT)');
  expect(() => f.decisions.decide(f.input())).toThrow(/transaction failed/);
  expect(
    f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='learning_review_schema'").get(),
  ).toBeUndefined();
  expect(f.store.getVersion(f.proposal.candidate_version_id).state.status).toBe('candidate');
});
it('rejects oversized requests and unsupported review/approval decisions', () => {
  const f = fixture();
  expect(() => f.decisions.decide({ ...f.input(), reason: 'x'.repeat(501) })).toThrow(/Invalid/);
  expect(() => f.decisions.decide({ ...f.input(), decision: 'APPROVE' })).toThrow(/Invalid/);
  expect(() => f.read.list({ project_id: f.otherScope.id })).toThrow(/Invalid/);
  expect(() => f.read.list({ limit: 21 })).toThrow(/Invalid/);
});
it('provides a diagnostic handoff with no grant and rejects stale handoff snapshots', () => {
  const f = fixture();
  f.service.evaluate({
    proposal_id: f.proposal.proposal_id,
    expected_content_hash: f.proposal.content_digest,
    expected_state_revision: 0,
  });
  const s = f.input();
  const h = f.read.handoff({
    proposal_id: s.proposal_id,
    expected_snapshot_digest: s.expected_snapshot_digest,
    candidate_digest: s.candidate_digest,
  });
  expect(h.eligible_for_existing_workflow).toBe(true);
  expect(h.protected_deployment).toBe('NOT VERIFIED');
  expect(h.review_is_approval).toBe(false);
  expect(JSON.stringify(h)).not.toContain('challenge_id');
  f.decisions.decide(f.input());
  expect(() =>
    f.read.handoff({
      proposal_id: s.proposal_id,
      expected_snapshot_digest: s.expected_snapshot_digest,
      candidate_digest: s.candidate_digest,
    }),
  ).toThrow(/fresh snapshot/);
});
it('measures bounded queue reads and confirms no full skill file retrieval', () => {
  const f = fixture();
  create(f, 'shader-rendering');
  create(f, 'adjacency-mapping');
  const start = performance.now();
  let bytes = 0;
  for (let i = 0; i < 20; i++)
    bytes = Buffer.byteLength(JSON.stringify(f.read.list({ limit: 20 })));
  const ms = performance.now() - start;
  console.info(
    JSON.stringify({
      benchmark: 'review-queue',
      proposals: 3,
      reads: 20,
      total_ms: ms,
      response_bytes: bytes,
      estimated_tokens: Math.ceil(bytes / 4),
      tokenizer: 'not measured',
    }),
  );
  expect(bytes).toBeLessThan(16000);
  expect(f.read.list({}).items.every((x) => !('files' in x))).toBe(true);
});
it('survives database contention without partially recording a decision', () => {
  const f = fixture();
  const other = openDatabaseReadOnly(f.path);
  other.close();
  const lock = new (f.db.constructor as unknown as { new (path: string): typeof f.db })(f.path);
  const input = f.input();
  try {
    lock.exec('BEGIN IMMEDIATE');
    expect(() => f.decisions.decide(input)).toThrow(/transaction failed/);
    expect(
      f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='learning_review_events'").get(),
    ).toBeUndefined();
    lock.exec('ROLLBACK');
    expect(f.decisions.decide(input).duplicate).toBe(false);
  } finally {
    if (lock.inTransaction) lock.exec('ROLLBACK');
    lock.close();
  }
});
it('marks source revisions as stale without silently copying review decisions', () => {
  const f = fixture();
  f.decisions.decide(f.input('MARK_REVIEWED'));
  const p = f.input('DISMISS');
  f.learning.state({
    signal_id: f.signal.id,
    expected_revision: f.signal.revision,
    state: 'superseded',
  });
  expect(() => f.decisions.decide(p)).toThrow(/fresh snapshot/);
  expect(f.read.get({ proposal_id: f.proposal.proposal_id }).review_state).toBe('STALE');
});
it('filters evaluation and validation states without loading packages into queue summaries', () => {
  const f = fixture();
  expect(f.read.list({ validation: 'VALID_AT_SUBMISSION' }).items).toHaveLength(1);
  f.service.evaluate({
    proposal_id: f.proposal.proposal_id,
    expected_content_hash: f.proposal.content_digest,
    expected_state_revision: 0,
  });
  expect(f.read.list({ validation: 'VALID_AT_SUBMISSION' }).items).toHaveLength(0);
  expect(f.read.list({ validation: 'VALID_EVALUATED', evaluation: 'PASS' }).items).toHaveLength(1);
});
it('fails recommendation for evaluated FAIL while allowing explicit requests for more evidence', () => {
  const f = fixture();
  f.evaluation(f.proposal.candidate_version_id, 'FAIL');
  expect(f.read.get({ proposal_id: f.proposal.proposal_id }).evaluation).toBe('FAIL');
  expect(() => f.decisions.decide(f.input('RECOMMEND_FOR_APPROVAL'))).toThrow(/incomplete/);
  f.decisions.decide(f.input('REQUEST_MORE_EVIDENCE'));
  expect(f.read.list({ state: 'NEEDS_EVIDENCE' }).items).toHaveLength(1);
});
it('failed metadata writes preserve the exact candidate state', () => {
  const f = fixture();
  migrateLearningReview(f.db);
  f.db.exec(
    "CREATE TRIGGER fail_review_write BEFORE INSERT ON learning_review_events BEGIN SELECT RAISE(ABORT,'fault');END;",
  );
  const before = f.store.getVersion(f.proposal.candidate_version_id);
  expect(() => f.decisions.decide(f.input())).toThrow();
  expect(f.store.getVersion(f.proposal.candidate_version_id)).toEqual(before);
  expect(f.db.prepare('SELECT COUNT(*) n FROM learning_review_events').get()).toEqual({ n: 0 });
});
it('redacts a secret spanning diff page boundaries before pagination and labels invalid content', () => {
  const f = fixture();
  const original = f.store.getVersion(f.proposal.candidate_version_id).version;
  const key = 'sk-proj-abcdefghijklmnopqrstuv123456';
  const files = original.files.map((v) => ({
    ...v,
    content: `${v.content}${'x '.repeat(400)}${key}\n`,
  }));
  // Deliberately bypass immutable triggers only in this disposable corruption fixture.
  const triggers = f.db
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='skill_versions'")
    .all() as { name: string }[];
  for (const t of triggers) f.db.exec(`DROP TRIGGER "${t.name}"`);
  f.db
    .prepare('UPDATE skill_versions SET files_json=?,content_hash=? WHERE id=?')
    .run(JSON.stringify(files), hashSkillFiles(files), f.proposal.candidate_version_id);
  const detail = f.read.get({ proposal_id: f.proposal.proposal_id });
  expect(detail.authoring.validation.validation_result).toBe('INVALID');
  expect(detail.approval_handoff.eligible_for_existing_workflow).toBe(false);
  let offset = 0,
    display = '';
  do {
    const chunk = f.read.diff({
      proposal_id: f.proposal.proposal_id,
      path: 'SKILL.md',
      limit: 37,
      offset,
    });
    if (!('next_offset' in chunk)) throw Error('page');
    expect(chunk.redacted).toBe(true);
    display += chunk.after?.content ?? '';
    offset = chunk.next_offset ?? 0;
  } while (offset);
  expect(display).not.toContain('abcdefghijkl');
  expect(display).toContain('[REDACTED]');
});
it('shows added resources as complete pages and preserves an original file digest', () => {
  const f = authoringFixture(true);
  clean.push(f.close);
  const p = f.patch();
  if (!p.operations) throw Error('ops');
  p.operations.push({
    op: 'add',
    path: 'references/limits.md',
    content: 'Read bounded retry limits and preserve unresolved outcomes.',
  });
  const r = f.service.submit(p);
  if (!('proposal_id' in r)) throw Error('candidate');
  const read = new LearningReviewService(f.db, f.scope);
  const page = read.diff({ proposal_id: r.proposal_id, path: 'references/limits.md' });
  if (!('after' in page)) throw Error('page');
  expect(page.after?.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(page.complete).toBe(true);
  expect(page.redacted).toBe(false);
});
it('shows modified resources and preserves both exact before/after contents', () => {
  const f = authoringFixture(true);
  clean.push(f.close);
  const b = f.store.getVersion(f.base),
    notes = b.version.files.find((x) => x.path === 'references/notes.md');
  if (!notes) throw Error('fixture');
  const p = f.patch();
  if (!p.operations) throw Error('ops');
  p.operations.push({
    op: 'replace',
    path: notes.path,
    expected_file_digest: fileDigest(notes.content),
    old_text: notes.content,
    new_text: notes.content + 'Inspect retry exhaustion before reporting the outcome.\n',
  });
  const r = f.service.submit(p);
  if (!('proposal_id' in r)) throw Error('candidate');
  const read = new LearningReviewService(f.db, f.scope),
    page = read.diff({ proposal_id: r.proposal_id, path: notes.path });
  if (!('after' in page)) throw Error('page');
  expect(page.before?.content).toBe(notes.content);
  expect(page.after?.content).toContain('Inspect retry exhaustion');
  expect(f.store.getVersion(f.base)).toEqual(b);
});
it('represents a renamed resource as explicit removal plus addition with complete removed content', () => {
  const f = authoringFixture(true);
  clean.push(f.close);
  const b = f.store.getVersion(f.base),
    notes = b.version.files.find((x) => x.path === 'references/notes.md'),
    md = b.version.files.find((x) => x.path === 'SKILL.md');
  if (!notes || !md) throw Error('fixture');
  const p = f.patch();
  p.operations = [
    {
      op: 'replace',
      path: 'SKILL.md',
      expected_file_digest: fileDigest(md.content),
      old_text: 'references/notes.md',
      new_text: 'references/renamed.md',
    },
    { op: 'remove', path: notes.path, expected_file_digest: fileDigest(notes.content) },
    { op: 'add', path: 'references/renamed.md', content: notes.content },
  ];
  const r = f.service.submit(p);
  if (!('proposal_id' in r)) throw Error('candidate');
  const read = new LearningReviewService(f.db, f.scope),
    manifest = read.diff({ proposal_id: r.proposal_id });
  expect('files' in manifest && manifest.files).toContainEqual({
    path: 'references/notes.md',
    change: 'removed',
  });
  expect('files' in manifest && manifest.files).toContainEqual({
    path: 'references/renamed.md',
    change: 'added',
  });
  const removed = read.diff({ proposal_id: r.proposal_id, path: notes.path });
  if (!('before' in removed)) throw Error('page');
  expect(removed.before?.content).toBe(notes.content);
  expect(removed.after).toBeNull();
  expect(removed.complete).toBe(true);
});

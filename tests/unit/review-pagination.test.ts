import { afterEach, expect, it } from 'vitest';
import { reviewPageProgress } from '../../packages/core/src/learning-review/query.js';
import { reviewPaginationFixture } from '../helpers/review-pagination-fixture.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
it('prefilters a deferred item beyond 100 unrelated proposals before applying the scan budget', () => {
  const f = reviewPaginationFixture();
  cleanup.push(f.close);
  const id = f.ids.at(-1);
  if (!id) throw Error('fixture');
  f.decide(id);
  const page = f.read.list({ pending_only: false, state: 'DEFERRED' });
  expect(page.items.map((i) => i.proposal_id)).toEqual([id]);
  expect(page.next_offset).toBeNull();
  expect(page.exhausted).toBe(true);
  expect(page.page_status).toBe('END');
});
it('prefilters sticky dismissals out of the pending queue without mutating them', () => {
  const f = reviewPaginationFixture();
  cleanup.push(f.close);
  for (const id of f.ids.slice(0, 100)) f.decide(id, 'DISMISS');
  const page = f.read.list({});
  expect(page.items.map((i) => i.proposal_id)).toEqual(f.ids.slice(100));
  expect(page.exhausted).toBe(true);
  const dismissed = f.read.list({ pending_only: false, state: 'DISMISSED', limit: 20 });
  expect(dismissed.items).toHaveLength(20);
  expect(dismissed.page_status).toBe('HAS_MORE');
  expect(dismissed.exhausted).toBe(false);
});
it('keeps dynamic stale-state filtering bounded and provides an explicit continuation to a later match', () => {
  const f = reviewPaginationFixture();
  cleanup.push(f.close);
  for (const id of f.ids) f.decide(id);
  f.changeEvidence();
  const last = f.ids.at(-1);
  if (!last) throw Error('fixture');
  f.decide(last);
  const first = f.read.list({ pending_only: false, state: 'DEFERRED' });
  expect(first.items).toEqual([]);
  expect(first.next_offset).toBe(100);
  expect(first.page_status).toBe('CONTINUE');
  expect(first.scan_truncated).toBe(true);
  expect(first.exhausted).toBe(false);
  const second = f.read.list({
    pending_only: false,
    state: 'DEFERRED',
    offset: first.next_offset ?? 0,
  });
  expect(second.items.map((i) => i.proposal_id)).toEqual([last]);
  expect(second.exhausted).toBe(true);
  const stale = f.read.list({ state: 'STALE' });
  expect(stale.items).toHaveLength(10);
  expect(stale.items.every((i) => i.stale)).toBe(true);
});
it('does not mislabel the offset ceiling as exhaustion', () => {
  expect(reviewPageProgress(10000, 1, true, 0)).toMatchObject({
    next_offset: null,
    exhausted: false,
    page_status: 'OFFSET_LIMIT_REACHED',
  });
  expect(reviewPageProgress(0, 0, false, 0)).toMatchObject({
    next_offset: null,
    exhausted: true,
    page_status: 'END',
  });
  expect(reviewPageProgress(9900, 100, true, 0)).toMatchObject({
    next_offset: 10000,
    exhausted: false,
    page_status: 'CONTINUE',
  });
});
it('does not create review metadata just to prefilter a state', () => {
  const f = reviewPaginationFixture(1);
  cleanup.push(f.close);
  expect(f.read.list({ pending_only: false, state: 'DEFERRED' }).exhausted).toBe(true);
  expect(
    f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='learning_review_schema'").get(),
  ).toBeUndefined();
});

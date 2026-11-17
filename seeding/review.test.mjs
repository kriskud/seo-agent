import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStore, writeStore } from './storage.mjs';
import { scoreRow, applyStatus, hostAllowed, rowView, createReviewServer, REVIEW_STATUSES } from './review.mjs';

const config = { queries: ['CRM для косметолога', 'yclients дорого'], competitors: ['yclients'] };
const row = (extra = {}) => ({
  id: 'id1', project: 'cosmodesk', source: 'yandex', sources: ['yandex'], platform: 'vk',
  url: 'https://vk.com/wall-1_2', canonicalUrl: 'https://vk.com/wall-1_2',
  title: 'CRM и yclients', snippet: 'дорого для косметолога', query: 'CRM для косметолога',
  matchedQueries: ['CRM для косметолога'], domain: 'vk.com', publishedAt: null,
  providerModifiedAt: null, discoveredAt: '2026-09-20T00:00:00.000Z',
  lastSeenAt: '2026-09-20T00:00:00.000Z', status: 'discovered', ...extra,
});

test('score is a deterministic ordering heuristic over matches and keywords', () => {
  const scored = scoreRow(row(), config);
  assert.ok(scored > scoreRow(row({ title: '', snippet: '', platform: 'web' }), config));
  assert.equal(scored, scoreRow(row(), config));
  assert.equal(scoreRow(row({ matchedQueries: ['a', 'b'], title: '', snippet: '', platform: 'web' }), config), 4);
});

test('applyStatus updates known rows, rejects unknown ids and statuses', () => {
  const store = { version: 1, rotation: 0, opportunities: [row()] };
  const now = new Date('2026-09-20T12:00:00Z');
  assert.equal(applyStatus(store, 'id1', 'relevant', now).reviewedAt, now.toISOString());
  assert.equal(store.opportunities[0].status, 'relevant');
  assert.equal(applyStatus(store, 'id1', 'posted', now).postedAt, now.toISOString());
  applyStatus(store, 'id1', 'relevant', now);
  assert.equal(store.opportunities[0].postedAt, undefined);
  applyStatus(store, 'id1', 'discovered', now);
  assert.equal(store.opportunities[0].reviewedAt, undefined);
  assert.throws(() => applyStatus(store, 'missing', 'noise'), /Unknown/);
  assert.throws(() => applyStatus(store, 'id1', 'spam'), /Invalid/);
  assert.deepEqual(REVIEW_STATUSES, ['relevant', 'maybe', 'noise', 'posted', 'discovered']);
});

test('host allowlist covers only this loopback origin', () => {
  assert.ok(hostAllowed('127.0.0.1:8787', 8787));
  assert.ok(hostAllowed('localhost:8787', 8787));
  assert.ok(!hostAllowed('127.0.0.1:9999', 8787));
  assert.ok(!hostAllowed('evil.test:8787', 8787));
  assert.ok(!hostAllowed(undefined, 8787));
});

test('row view exposes triage fields without the whole stored record', () => {
  const view = rowView(row(), config);
  assert.deepEqual(Object.keys(view), ['id', 'score', 'platform', 'title', 'snippet',
    'matchedQueries', 'domain', 'url', 'status', 'publishedAt', 'discoveredAt', 'draft', 'draftedAt', 'postedAt']);
  assert.equal(view.draft, null);
});

test('server round-trip: list, persist a status, survive restart-shaped reread', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seeding-review-'));
  const file = join(dir, 'cosmodesk.json');
  writeStore(file, { version: 1, rotation: 0, opportunities: [row()] });
  const server = createReviewServer({ file, config });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const list = await (await fetch(base + '/api/opportunities')).json();
    assert.equal(list.opportunities.length, 1);
    assert.equal(list.opportunities[0].status, 'discovered');
    const bad = await fetch(base + '/api/status', { method: 'POST',
      headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.equal(bad.status, 415);
    const saved = await fetch(base + '/api/status', { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'id1', status: 'maybe' }) });
    assert.equal(saved.status, 200);
    assert.equal(readStore(file).opportunities[0].status, 'maybe');
  } finally {
    await new Promise(done => server.close(done));
    rmSync(dir, { recursive: true, force: true });
  }
});

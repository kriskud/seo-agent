import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createVkProvider, planVkSearches, normalizeVkPosts, validateVkConfig } from './providers/vk.mjs';
import { runDiscovery } from './discover.mjs';
import { ROOT } from '../lib.mjs';

const config = JSON.parse(readFileSync(new URL('./config/cosmodesk.json', import.meta.url)));
const vk = { enabled: true, communityIds: [100, 200], maxQueries: 12, resultsPerQuery: 20 };
const now = new Date('2026-09-18T12:00:00Z');
const post = { id: 12, owner_id: -100, date: now.getTime() / 1000 - 3600, text: 'CRM для косметолога: чем заменить?' };

test('VK CLI is disabled by default before credential loading or HTTP', () => {
  const output = execFileSync(process.execPath, ['seeding/discover-vk.mjs'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(output, /disabled/); assert.match(output, /API requests: 0/);
  assert.deepEqual(planVkSearches({ ...vk, enabled: false }, config.queries), []);
  assert.deepEqual(planVkSearches({ ...vk, communityIds: [] }, config.queries), []);
  assert.throws(() => validateVkConfig({ ...vk, communityIds: [-100] }));
});

test('VK plan rotates across communities and obeys per-run cap', () => {
  const first = planVkSearches(vk, config.queries, 0), second = planVkSearches(vk, config.queries, 1);
  assert.equal(first.length, 12); assert.ok(first.every(x => x.communityId === 100));
  assert.ok(second.every(x => x.communityId === 200));
});

test('VK data minimization: fresh allowlisted community posts only, no auth/profiles/attachments', () => {
  const rows = normalizeVkPosts([
    { ...post, attachments: [{ secret: 'private' }], from_id: 7 },
    { ...post, id: 13, date: post.date - 8 * 86400 },
    { ...post, id: 14, owner_id: 100 },
    { ...post, id: 15, owner_id: -999 },
    { ...post, id: 16, date: now.getTime() / 1000 + 1 },
    { ...post, id: 17, marked_as_ads: 1 },
  ], { communityId: 100, freshnessDays: 7, minResultDate: null, now });
  assert.equal(rows.length, 1); assert.equal(rows[0].url, 'https://vk.com/wall-100_12');
  assert.equal(rows[0].publishedAt, new Date(post.date * 1000).toISOString());
  assert.deepEqual(Object.keys(rows[0]).sort(), ['publishedAt', 'snippet', 'title', 'url']);
});

test('VK uses bounded read-only POST; no token in URL or propagated errors', async () => {
  let calls = 0;
  const provider = createVkProvider({ config: vk, env: { VK_ACCESS_TOKEN: 'TEST_ONLY_TOKEN' }, wait: async () => {},
    fetchImpl: async (url, options) => {
      calls++; assert.equal(url, 'https://api.vk.com/method/wall.search');
      assert.equal(options.method, 'POST'); assert.equal(options.body.get('domain'), 'club100');
      assert.equal(options.body.get('extended'), '0'); assert.equal(options.body.get('count'), '20');
      return new Response(JSON.stringify({ response: { items: [post] } }));
    },
  });
  assert.equal((await provider.search({ query: 'CRM', communityId: 100, now })).length, 1);
  await assert.rejects(provider.search({ query: 'CRM', communityId: 999, now }), /not allowlisted/);
  assert.equal(calls, 1); assert.equal(provider.apiRequests, 1);
  for (const code of [5, 6, 14, 15]) {
    const p = createVkProvider({ config: vk, env: { VK_ACCESS_TOKEN: 'TEST_ONLY_TOKEN' },
      fetchImpl: async () => new Response(JSON.stringify({ error: {
        error_code: code, error_msg: 'TEST_ONLY_TOKEN', request_params: [{ value: 'TEST_ONLY_TOKEN' }],
      } })),
    });
    await assert.rejects(p.search({ query: 'CRM', communityId: 100, now }), e => e.fatal && e.message === `VK API error ${code}`);
    assert.equal(p.apiRequests, 1);
  }
});

test('same URL from Yandex and VK merges sources and publication date, preserves status and separate rotation', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'vk-dedupe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'cosmodesk.json');
  const yandex = { name: 'yandex', search: async () => [{ url: 'https://vk.com/wall-100_12?utm_source=x', publishedAt: null }] };
  const first = await runDiscovery({ config: { ...config, maxQueries: 1 }, provider: yandex, file, now });
  const provider = createVkProvider({ config: vk, env: { VK_ACCESS_TOKEN: 'TEST_ONLY_TOKEN' },
    fetchImpl: async () => new Response(JSON.stringify({ response: { items: [post] } })),
  });
  const out = await runDiscovery({ config, provider, file, now, rotationKey: 'vkRotation',
    makePlan: () => [{ query: 'CRM', communityId: 100 }] });
  assert.equal(out.summary.newOpportunities, 0); assert.equal(out.summary.duplicatesSkipped, 1);
  const [row] = out.store.opportunities;
  assert.deepEqual(row.sources, ['yandex', 'vk']); assert.equal(row.id, first.store.opportunities[0].id);
  assert.equal(row.source, 'yandex'); assert.ok(row.publishedAt); assert.equal(row.status, 'discovered');
  assert.equal(out.store.rotation, 1); assert.equal(out.store.vkRotation, 1);
});

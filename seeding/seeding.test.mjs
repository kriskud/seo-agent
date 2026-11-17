import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizeUrl, detectPlatform } from './normalize.mjs';
import { discover, runDiscovery, planSearches, validateConfig } from './discover.mjs';
import { readStore, acquireLock } from './storage.mjs';
import { parseResults } from './providers/xml.mjs';
import { createYandexProvider as realYandexProvider, buildRequest } from './providers/yandex.mjs';
import { createDailyBudget } from './budget.mjs';
import { createSearchCache } from './cache.mjs';

// Existing transport unit tests isolate the budget; integrated tests below use
// the real persistent limiter. No test sends requests to the network.
const createYandexProvider = options => realYandexProvider({ budget: { reserve() {} }, cache: null, ...options });

const defaultConfig = JSON.parse(readFileSync(new URL('./config/cosmodesk.json', import.meta.url)));
const config = { ...defaultConfig, maxQueries: 18 };
const now = new Date('2026-09-17T12:00:00Z');
const empty = () => ({ version: 1, rotation: 0, opportunities: [] });
// Synthetic fixtures only; these tests do not contact Yandex.
const xml = '<yandexsearch><response><results><grouping><group><doc><url>https://vk.com/wall-1_2?reply=3&amp;utm_source=y</url><title>CRM <hlword>косметолог</hlword> &amp; &#x41;</title><modtime>20260916T000000</modtime><passages><passage><![CDATA[Куда <переехать>?]]></passage><passage>Дорого</passage></passages></doc></group></grouping></results></response></yandexsearch>';
const env = { YANDEX_SEARCH_API_KEY: 'TEST_NOT_A_REAL_KEY', YANDEX_SEARCH_FOLDER_ID: 'test-folder' };
const response = () => new Response(JSON.stringify({ rawData: Buffer.from(xml).toString('base64') }));
const fakeProvider = fn => ({ name: 'test', apiRequests: 0, async search(o) { this.apiRequests++; return fn(o, this.apiRequests); } });
function temp(t) { const dir = mkdtempSync(join(tmpdir(), 'seeding-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }

test('canonical URLs strip tracking while preserving page, comment and query identity', () => {
  assert.equal(canonicalizeUrl('https://m.vk.com/wall-1_2?utm_source=x&reply=3&yclid=4'), 'https://vk.com/wall-1_2?reply=3');
  assert.notEqual(canonicalizeUrl('https://x.test/?id=1'), canonicalizeUrl('https://x.test/?id=2'));
  assert.notEqual(canonicalizeUrl('https://x.test/#comment1'), canonicalizeUrl('https://x.test/#comment2'));
  assert.equal(canonicalizeUrl('https://X.test:443/?b=2&a=1'), 'https://x.test/?a=1&b=2');
  assert.equal(canonicalizeUrl('https://x.test/?a=2&a=1&utm_medium=x'), 'https://x.test/?a=2&a=1');
  assert.throws(() => canonicalizeUrl('javascript:alert(1)'));
  assert.throws(() => canonicalizeUrl('https://user:secret@x.test/'));
});

test('platform matching observes hostname boundaries', () => {
  for (const [host, platform] of [['m.vk.com', 'vk'], ['dzen.ru', 'dzen'], ['otzovik.com', 'otzovik'],
    ['irecommend.ru', 'irecommend'], ['youtu.be', 'youtube'], ['youtube.com', 'youtube'], ['t.me', 'telegram'], ['evilvk.com', 'web']]) {
    assert.equal(detectPlatform(`https://${host}/`), platform);
  }
});

test('bounded plan covers all query/domain combinations over six successful runs', () => {
  validateConfig(config);
  const combinations = new Set();
  for (let rotation = 0; rotation < 6; rotation++) {
    const plan = planSearches(config, rotation);
    assert.equal(plan.length, 18);
    assert.equal(plan.filter(p => !p.domain).length, 6);
    for (const p of plan.filter(p => p.domain)) combinations.add(JSON.stringify(p));
  }
  assert.equal(combinations.size, 72);
  assert.throws(() => validateConfig({ ...config, minResultDate: '2026-02-30' }));
  assert.equal(planSearches({ ...config, maxQueries: 2 }).length, 2);
});

test('Yandex request uses official v2 schema, domain/language/date operators', () => {
  const body = buildRequest({ query: 'CRM', domain: 'vk.com', freshnessDays: 7, now }, 'folder');
  assert.equal(body.query.queryText, 'CRM site:vk.com lang:ru date:20260910..20260917');
  assert.equal(body.responseFormat, 'FORMAT_XML');
  assert.equal(body.groupSpec.groupsOnPage, '10');
  assert.match(buildRequest({ query: 'CRM', now, minResultDate: '2026-09-15' }, 'folder').query.queryText, /date:20260915/);
});

test('XML handles highlighting, entities, CDATA, missing fields and empty results', () => {
  const [row] = parseResults(xml);
  assert.equal(row.title, 'CRM косметолог & A');
  assert.equal(row.snippet, 'Куда <переехать>? Дорого');
  assert.equal(row.publishedAt, null);
  assert.equal(row.providerModifiedAt, '20260916T000000');
  assert.match(row.url, /&utm_source=y$/);
  assert.deepEqual(parseResults('<yandexsearch><response><results/></response></yandexsearch>'), []);
  assert.deepEqual(parseResults('<yandexsearch><response><error code="15">empty</error></response></yandexsearch>'), []);
  assert.throws(() => parseResults('<yandexsearch><response><error code="32">secret</error></response></yandexsearch>'), /XML error 32/);
  assert.throws(() => parseResults(xml.slice(0, -10)), /XML/);
  assert.throws(() => parseResults('<!DOCTYPE x><yandexsearch/>'), /declaration/);
  assert.throws(() => parseResults('<html/>'), /Invalid Yandex/);
});

test('HTTP retries are bounded; credentials never appear in errors', async () => {
  let calls = 0; const waits = [];
  const p = createYandexProvider({ env, wait: async ms => waits.push(ms), fetchImpl: async (url, options) => {
    assert.equal(url, 'https://searchapi.api.cloud.yandex.net/v2/web/search');
    assert.equal(options.headers.Authorization, 'Api-Key TEST_NOT_A_REAL_KEY');
    return ++calls === 1 ? new Response('', { status: 503 }) : response();
  } });
  assert.equal((await p.search({ query: 'CRM', now })).length, 1);
  assert.equal(p.apiRequests, 2); assert.deepEqual(waits, [3000]);
  const failing = createYandexProvider({ env, wait: async () => {}, fetchImpl: async () => { throw Error(env.YANDEX_SEARCH_API_KEY); } });
  await assert.rejects(failing.search({ query: 'CRM', now }), /network\/timeout/);
  assert.equal(failing.apiRequests, 2);
  for (const status of [401, 403, 429]) {
    const limited = createYandexProvider({ env, fetchImpl: async () => new Response('', { status, headers: { 'Retry-After': '3600' } }) });
    await assert.rejects(limited.search({ query: 'CRM', now }), e => e.fatal && e.message === `Yandex HTTP ${status}`);
    assert.equal(limited.apiRequests, 1);
  }
  assert.throws(() => createYandexProvider({ env: {} }), /Set YANDEX/);
});

test('timeout also covers response body', async () => {
  const p = createYandexProvider({ env, timeoutMs: 5, wait: async () => {}, fetchImpl: async (_, { signal }) => ({
    ok: true, json: () => new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Error('test guard')), 100);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); });
    }),
  }) });
  await assert.rejects(p.search({ query: 'CRM', now }), /timeout/);
  assert.equal(p.apiRequests, 2);
});

test('persistent dedupe merges queries and preserves id, first-seen and future status', async t => {
  const file = join(temp(t), 'cosmodesk.json');
  const provider = fakeProvider(() => [{ url: 'https://vk.com/wall1?utm_source=x', title: 'a' }]);
  const first = await runDiscovery({ config, provider, file, now });
  assert.equal(first.summary.newOpportunities, 1); assert.equal(first.summary.duplicatesSkipped, 17);
  assert.equal(first.store.opportunities[0].matchedQueries.length, 12);
  const stored = readStore(file); stored.opportunities[0].status = 'reviewed';
  writeFileSync(file, JSON.stringify(stored));
  const later = new Date('2026-09-18T12:00:00Z');
  const second = await runDiscovery({ config, provider, file, now: later });
  const row = second.store.opportunities[0];
  assert.equal(second.summary.newOpportunities, 0); assert.equal(row.status, 'reviewed');
  assert.equal(row.id, first.store.opportunities[0].id);
  assert.equal(row.discoveredAt, now.toISOString()); assert.equal(row.lastSeenAt, later.toISOString());
});

test('dry run makes no directory, lock, registry or rotation changes', async t => {
  const dir = temp(t); const file = join(dir, 'nested/cosmodesk.json');
  const provider = fakeProvider(() => [{ url: 'https://example.com/?id=1' }]);
  const out = await runDiscovery({ config, provider, file, dryRun: true, now });
  assert.equal(out.summary.newOpportunities, 1); assert.equal(out.saved, false);
  assert.deepEqual(readdirSync(dir), []);
  await runDiscovery({ config, provider, file, now });
  const before = readFileSync(file, 'utf8');
  await runDiscovery({ config, provider, file, now, dryRun: true });
  assert.equal(readFileSync(file, 'utf8'), before); assert.equal(existsSync(file + '.lock'), false);
});

test('partial results persist; fatal errors stop; corrupt storage and concurrent writers fail safely', async t => {
  const file = join(temp(t), 'cosmodesk.json');
  const provider = fakeProvider((_, n) => {
    if (n > 1) { const e = Error('HTTP 429'); e.fatal = true; throw e; }
    return [{ url: 'https://example.com/' }, { url: 'bad' }, { url: 'bad' }];
  });
  const out = await runDiscovery({ config, provider, file, now });
  assert.equal(out.summary.queriesExecuted, 2); assert.equal(out.summary.errors, 3);
  assert.equal(readStore(file).opportunities.length, 1); assert.equal(readStore(file).rotation, 0);
  const release = acquireLock(file);
  await assert.rejects(runDiscovery({ config, provider, file, now }), /already running/); release();
  writeFileSync(file, '{broken');
  await assert.rejects(runDiscovery({ config, provider, file, now }));
  assert.equal(readFileSync(file, 'utf8'), '{broken'); assert.equal(existsSync(file + '.lock'), false);
});

test('all failed queries do not create a registry and do not rotate', async t => {
  const file = join(temp(t), 'cosmodesk.json');
  const p = fakeProvider(() => { throw Error('unavailable'); });
  const out = await runDiscovery({ config, provider: p, file, now });
  assert.equal(out.saved, false); assert.equal(existsSync(file), false);
  assert.equal(out.store.rotation, 0);
  const original = empty();
  await discover({ config, provider: fakeProvider(() => []), store: original, now });
  assert.deepEqual(original, empty());
});

test('explicit one-request limit persists across providers and dry runs', async t => {
  assert.equal(defaultConfig.maxQueries, 18);
  assert.equal(createDailyBudget({ env: {} }).limit, 50);
  const dir = temp(t), file = join(dir, 'budget.json');
  const makeBudget = () => createDailyBudget({ env: { YANDEX_SEARCH_DAILY_LIMIT: '1' }, file, clock: () => now });
  let calls = 0;
  const makeProvider = () => realYandexProvider({ env, cache: null, budget: makeBudget(), wait: async () => {},
    fetchImpl: async () => { calls++; return response(); } });
  const first = await runDiscovery({ config: defaultConfig, provider: makeProvider(),
    file: join(dir, 'opportunities.json'), dryRun: true, now });
  assert.equal(first.summary.apiRequests, 1);
  assert.equal(existsSync(join(dir, 'opportunities.json')), false);
  await assert.rejects(makeProvider().search({ query: 'CRM', now }), /Daily Yandex request limit/);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(readFileSync(file)).used, 1);
});

test('retries consume budget; exhaustion prevents retry HTTP', async t => {
  const file = join(temp(t), 'budget.json');
  const budget = createDailyBudget({ env: { YANDEX_SEARCH_DAILY_LIMIT: '1' }, file, clock: () => now });
  let calls = 0;
  const p = realYandexProvider({ env, cache: null, budget, wait: async () => {},
    fetchImpl: async () => { calls++; throw Error('uncertain network failure'); } });
  await assert.rejects(p.search({ query: 'CRM', now }), /Daily Yandex request limit/);
  assert.equal(calls, 1); assert.equal(p.apiRequests, 1);
});

test('UTC rollover, disabled searches, invalid state and lock fail closed', t => {
  const file = join(temp(t), 'budget.json');
  const budget = date => createDailyBudget({ env: {}, file, clock: () => new Date(date) });
  budget('2026-09-17T23:59:59Z').reserve();
  budget('2026-09-18T00:00:00Z').reserve();
  assert.equal(JSON.parse(readFileSync(file)).used, 1);
  assert.throws(() => budget('2026-09-17T23:59:59Z').reserve(), /Cannot safely/);
  assert.throws(() => createDailyBudget({ env: { YANDEX_SEARCH_DAILY_LIMIT: '-1' }, file }));
  assert.throws(() => createDailyBudget({ env: { YANDEX_SEARCH_DAILY_LIMIT: '0' }, file,
    clock: () => new Date('2026-09-19') }).reserve(), /limit reached/);
  const release = acquireLock(file);
  assert.throws(() => budget('2026-09-19').reserve(), /Cannot safely/); release();
  writeFileSync(file, '{broken');
  assert.throws(() => budget('2026-09-19').reserve(), /Cannot safely/);
  assert.equal(readFileSync(file, 'utf8'), '{broken');
});

test('persistent cache hits spend no HTTP budget; expiry and UTC rollover resume HTTP', async t => {
  const dir = temp(t), file = join(dir, 'budget.json');
  let time = now.getTime(), calls = 0;
  const make = () => realYandexProvider({ env,
    budget: createDailyBudget({ env: { YANDEX_SEARCH_DAILY_LIMIT: '1' }, file, clock: () => new Date(time) }),
    cache: createSearchCache({ directory: join(dir, 'cache'), clock: () => time }),
    wait: async () => {}, fetchImpl: async () => { calls++; return response(); },
  });
  await make().search({ query: 'CRM', now });
  const cached = make();
  await cached.search({ query: 'CRM', now });
  assert.equal(cached.apiRequests, 0); assert.equal(cached.cacheHits, 1); assert.equal(calls, 1);
  time += 6 * 3600e3;
  await assert.rejects(make().search({ query: 'CRM', now }), /limit reached/);
  time += 864e5;
  await make().search({ query: 'CRM', now: new Date(time) });
  assert.equal(calls, 2);
});

test('limit is a normal partial stop, preserves results and resumes with changed env', async t => {
  const dir = temp(t), file = join(dir, 'budget.json');
  const make = limit => realYandexProvider({ env, cache: null,
    budget: createDailyBudget({ env: { YANDEX_SEARCH_DAILY_LIMIT: limit }, file, clock: () => now }),
    wait: async () => {}, fetchImpl: async () => response(),
  });
  let out = await runDiscovery({ config, provider: make('1'), file: join(dir, 'opps.json'), now });
  assert.equal(out.summary.limitReached, true); assert.equal(out.summary.errors, 0);
  assert.equal(out.summary.apiRequests, 1); assert.equal(out.saved, true);
  assert.equal(out.store.rotation, 0); assert.equal(out.summary.resetsAt, '2026-09-18T00:00:00.000Z');
  out = await runDiscovery({ config, provider: make('1'), file: join(dir, 'opps.json'), now });
  assert.equal(out.summary.errors, 0); assert.equal(out.summary.apiRequests, 0);
  out = await runDiscovery({ config, provider: make('50'), file: join(dir, 'opps.json'), now });
  assert.equal(out.summary.limitReached, false); assert.equal(out.summary.apiRequests, 18);
});

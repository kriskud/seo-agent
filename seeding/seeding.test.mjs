import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalizeUrl, detectPlatform } from './normalize.mjs';
import { discover, runDiscovery, planSearches, planRedditSweep, validateConfig } from './discover.mjs';
import { readStore, acquireLock } from './storage.mjs';
import { createGoogleProvider as realGoogleProvider, buildParams, parseItems } from './providers/google.mjs';
import { createRedditRssProvider, parseFeed } from './providers/reddit-rss.mjs';
import { createDailyBudget } from './budget.mjs';
import { createSearchCache } from './cache.mjs';

// Existing transport unit tests isolate the budget; integrated tests below use
// the real persistent limiter. No test sends requests to the network.
const createGoogleProvider = options => realGoogleProvider({ budget: { reserve() {} }, cache: null, ...options });

const drillConfig = JSON.parse(readFileSync(new URL('./config/drill.json', import.meta.url)));
const flopConfig = JSON.parse(readFileSync(new URL('./config/floprooms.json', import.meta.url)));
const config = drillConfig;
const now = new Date('2026-09-24T12:00:00Z');
const empty = () => ({ version: 1, rotation: 0, opportunities: [] });
// Synthetic fixtures only; these tests do not contact Google or Reddit.
const googleJson = { items: [
  { link: 'https://forumserver.twoplustwo.com/15/poker-theory/push-fold-123/?utm_source=g', title: 'Push fold chart question', snippet: ' need\n a  chart ' },
  { title: 'no link, skipped' },
] };
const env = { GOOGLE_CSE_KEY: 'TEST_NOT_A_REAL_KEY', GOOGLE_CSE_CX: 'test-cx' };
const response = () => new Response(JSON.stringify(googleJson));
const fakeProvider = fn => ({ name: 'test', apiRequests: 0, async search(o) { this.apiRequests++; return fn(o, this.apiRequests); } });
function temp(t) { const dir = mkdtempSync(join(tmpdir(), 'seeding-test-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }

const atom = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>newest submissions</title>
<entry><author><name>/u/x</name></author><content type="html">&lt;div&gt;Looking for a &lt;b&gt;push fold&lt;/b&gt; chart &amp;amp; trainer&lt;/div&gt;</content><id>t3_abc</id><link href="https://www.reddit.com/r/poker/comments/abc/push_fold/?utm_source=share"/><published>2026-09-23T10:00:00+00:00</published><title>Push fold help &amp; advice</title></entry>
<entry><content type="html">push fold but ancient</content><link href="https://www.reddit.com/r/poker/comments/old1/"/><published>2026-08-01T00:00:00+00:00</published><title>push fold archive</title></entry>
<entry><content type="html">fresh but off-topic</content><link href="https://www.reddit.com/r/poker/comments/xyz/"/><published>2026-09-23T11:00:00+00:00</published><title>bad beat story</title></entry>
<entry><content type="html">no link</content><published>2026-09-23T11:00:00+00:00</published><title>push fold broken entry</title></entry></feed>`;

test('canonical URLs strip tracking while preserving page, comment and query identity', () => {
  assert.equal(canonicalizeUrl('https://m.vk.com/wall-1_2?utm_source=x&reply=3&yclid=4'), 'https://vk.com/wall-1_2?reply=3');
  assert.equal(canonicalizeUrl('https://old.reddit.com/r/poker/comments/abc/?utm_source=share'), 'https://reddit.com/r/poker/comments/abc/');
  assert.equal(canonicalizeUrl('https://www.pokeroff.ru/topic/1'), 'https://pokeroff.ru/topic/1');
  assert.notEqual(canonicalizeUrl('https://x.test/?id=1'), canonicalizeUrl('https://x.test/?id=2'));
  assert.notEqual(canonicalizeUrl('https://x.test/#comment1'), canonicalizeUrl('https://x.test/#comment2'));
  assert.equal(canonicalizeUrl('https://X.test:443/?b=2&a=1'), 'https://x.test/?a=1&b=2');
  assert.throws(() => canonicalizeUrl('javascript:alert(1)'));
  assert.throws(() => canonicalizeUrl('https://user:secret@x.test/'));
});

test('platform matching observes hostname boundaries', () => {
  for (const [host, platform] of [['m.vk.com', 'vk'], ['dzen.ru', 'dzen'], ['t.me', 'telegram'],
    ['reddit.com', 'reddit'], ['forumserver.twoplustwo.com', 'twoplustwo'], ['gipsyteam.ru', 'gipsyteam'],
    ['pokeroff.ru', 'pokeroff'], ['evilreddit.com', 'web']]) {
    assert.equal(detectPlatform(`https://${host}/`), platform);
  }
});

test('project configs are valid; both language banks fit maxQueries exactly', () => {
  for (const c of [drillConfig, flopConfig]) {
    validateConfig(c);
    const plan = planSearches(c, 0);
    assert.equal(plan.length, c.maxQueries);
    assert.ok(plan.some(p => p.language === 'ru') && plan.some(p => p.language === 'en'));
    const planned = new Set(plan.map(p => p.query));
    for (const bank of c.banks) for (const q of bank.queries) assert.ok(planned.has(q), q);
  }
});

test('bounded plan rotates domains within each bank and dedupes general searches', () => {
  const combinations = new Set();
  for (let rotation = 0; rotation < 6; rotation++) {
    for (const p of planSearches(config, rotation).filter(p => p.domain)) combinations.add(JSON.stringify(p));
  }
  // 8 ru queries × 3 domains + 8 en queries × 2 domains
  assert.equal(combinations.size, 40);
  assert.equal(planSearches({ ...config, maxQueries: 2 }).length, 2);
  assert.deepEqual(planRedditSweep(config), [{ query: 'r/poker', domain: null, language: 'en' }]);
  assert.deepEqual(planRedditSweep({ ...config, reddit: undefined }), []);
});

test('config validation rejects wrong project, bank and reddit shapes', () => {
  assert.throws(() => validateConfig({ ...config, project: 'cosmodesk' }));
  assert.throws(() => validateConfig({ ...config, banks: [] }));
  assert.throws(() => validateConfig({ ...config, banks: [{ ...config.banks[0], language: 'es' }] }));
  assert.throws(() => validateConfig({ ...config, banks: [{ ...config.banks[0], generalQueries: ['not in queries'] }] }));
  assert.throws(() => validateConfig({ ...config, reddit: { subreddits: ['ok'], keywords: [] } }));
  assert.throws(() => validateConfig({ ...config, reddit: { subreddits: ['bad name!'], keywords: ['x'] } }));
  assert.throws(() => validateConfig({ ...config, minResultDate: '2026-02-30' }));
});

test('Google request uses site/date/language operators and stays under limits', () => {
  const params = buildParams({ query: 'push fold chart', domain: 'reddit.com', language: 'en', freshnessDays: 7, now });
  assert.equal(params.get('q'), 'push fold chart site:reddit.com');
  // The lower bound is a date (midnight UTC), so covering 7 full days needs d8.
  assert.equal(params.get('dateRestrict'), 'd8');
  assert.equal(params.get('lr'), 'lang_en');
  assert.equal(params.get('num'), '10');
  assert.equal(buildParams({ query: 'x', language: 'ru', freshnessDays: 30, minResultDate: '2026-09-22', now }).get('dateRestrict'), 'd3');
  assert.throws(() => buildParams({ query: 'q'.repeat(401), now }), /400 characters/);
});

test('Google items parse into rows; malformed payloads fail loudly', () => {
  const rows = parseItems(googleJson);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].snippet, 'need a chart');
  assert.equal(rows[0].publishedAt, null);
  assert.deepEqual(parseItems({}), []);
  assert.throws(() => parseItems({ items: 'nope' }), /Invalid Google/);
  assert.throws(() => parseItems(null), /Invalid Google/);
});

test('HTTP retries are bounded; credentials never appear in errors', async () => {
  let calls = 0; const waits = [];
  const p = createGoogleProvider({ env, wait: async ms => waits.push(ms), fetchImpl: async url => {
    assert.ok(url.startsWith('https://www.googleapis.com/customsearch/v1?'));
    assert.ok(url.includes('key=TEST_NOT_A_REAL_KEY') && url.includes('cx=test-cx'));
    return ++calls === 1 ? new Response('', { status: 503 }) : response();
  } });
  assert.equal((await p.search({ query: 'push fold', now })).length, 1);
  assert.equal(p.apiRequests, 2); assert.deepEqual(waits, [3000]);
  const failing = createGoogleProvider({ env, wait: async () => {}, fetchImpl: async () => { throw Error(env.GOOGLE_CSE_KEY); } });
  await assert.rejects(failing.search({ query: 'x', now }), /network\/timeout/);
  assert.equal(failing.apiRequests, 2);
  for (const status of [401, 403, 429]) {
    const limited = createGoogleProvider({ env, fetchImpl: async () => new Response('', { status }) });
    await assert.rejects(limited.search({ query: 'x', now }), e => e.fatal && e.message === `Google HTTP ${status}`);
    assert.equal(limited.apiRequests, 1);
  }
  assert.throws(() => createGoogleProvider({ env: {} }), /Set GOOGLE/);
});

test('timeout aborts a hung request and exhausts bounded retries', async () => {
  const p = createGoogleProvider({ env, timeoutMs: 5, wait: async () => {},
    fetchImpl: (_, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))) });
  await assert.rejects(p.search({ query: 'x', now }), /network\/timeout/);
  assert.equal(p.apiRequests, 2);
});

test('Reddit feed parses entities, filters by keywords and freshness', async () => {
  const rows = parseFeed(atom);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].title, 'Push fold help & advice');
  assert.equal(rows[0].snippet, 'Looking for a push fold chart & trainer');
  assert.equal(rows[0].publishedAt, '2026-09-23T10:00:00.000Z');
  assert.throws(() => parseFeed('<html/>'), /Invalid Atom/);
  const p = createRedditRssProvider({ keywords: ['push fold'], fetchImpl: async url => {
    assert.equal(url, 'https://www.reddit.com/r/poker/new.rss?limit=100');
    return new Response(atom);
  } });
  const found = await p.search({ query: 'r/poker', freshnessDays: 7, now });
  assert.equal(found.length, 1);
  assert.match(found[0].url, /comments\/abc/);
  await assert.rejects(p.search({ query: 'not-a-subreddit', now }), /r\/<subreddit>/);
  const blocked = createRedditRssProvider({ keywords: ['x'], fetchImpl: async () => new Response('', { status: 403 }) });
  await assert.rejects(blocked.search({ query: 'r/poker', now }), /Reddit HTTP 403/);
  assert.throws(() => createRedditRssProvider({ keywords: [] }), /keywords/);
  let tries = 0; const waits = [];
  const limited = createRedditRssProvider({ keywords: ['push fold'], wait: async ms => waits.push(ms),
    fetchImpl: async () => ++tries === 1 ? new Response('', { status: 429 }) : new Response(atom) });
  assert.equal((await limited.search({ query: 'r/poker', freshnessDays: 7, now })).length, 1);
  assert.deepEqual(waits, [120000]); assert.equal(tries, 2);
  const doubly = createRedditRssProvider({ keywords: ['x'], wait: async () => {},
    fetchImpl: async () => new Response('', { status: 429 }) });
  await assert.rejects(doubly.search({ query: 'r/poker', now }), /Reddit HTTP 429/);
});

test('persistent dedupe merges queries and preserves id, first-seen and future status', async t => {
  const file = join(temp(t), 'drill.json');
  const provider = fakeProvider(() => [{ url: 'https://reddit.com/r/poker/comments/a1/?utm_source=x', title: 'a' }]);
  const first = await runDiscovery({ config, provider, file, now });
  assert.equal(first.summary.newOpportunities, 1); assert.equal(first.summary.duplicatesSkipped, 21);
  assert.equal(first.store.opportunities[0].matchedQueries.length, 16);
  const stored = readStore(file); stored.opportunities[0].status = 'relevant';
  writeFileSync(file, JSON.stringify(stored));
  const later = new Date('2026-09-25T12:00:00Z');
  const second = await runDiscovery({ config, provider, file, now: later });
  const row = second.store.opportunities[0];
  assert.equal(second.summary.newOpportunities, 0); assert.equal(row.status, 'relevant');
  assert.equal(row.id, first.store.opportunities[0].id);
  assert.equal(row.discoveredAt, now.toISOString()); assert.equal(row.lastSeenAt, later.toISOString());
});

test('google and reddit passes share one store under separate rotation keys', async t => {
  const file = join(temp(t), 'drill.json');
  const google = fakeProvider(() => [{ url: 'https://pokeroff.ru/t/1', title: 'g' }]);
  await runDiscovery({ config, provider: google, file, now });
  const reddit = fakeProvider(() => [{ url: 'https://pokeroff.ru/t/1' }, { url: 'https://reddit.com/r/poker/comments/b2/' }]);
  const sweep = await runDiscovery({ config, provider: reddit, file, now,
    makePlan: () => planRedditSweep(config), rotationKey: 'redditRotation' });
  assert.equal(sweep.summary.queriesPlanned, 1);
  assert.equal(sweep.summary.newOpportunities, 1); assert.equal(sweep.summary.duplicatesSkipped, 1);
  const store = readStore(file);
  assert.equal(store.rotation, 1); assert.equal(store.redditRotation, 1);
  const merged = store.opportunities.find(r => r.canonicalUrl === 'https://pokeroff.ru/t/1');
  assert.deepEqual(merged.sources, ['test']);
  assert.equal(store.opportunities.length, 2);
});

test('dry run makes no directory, lock, registry or rotation changes', async t => {
  const dir = temp(t); const file = join(dir, 'nested/drill.json');
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
  const file = join(temp(t), 'drill.json');
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
  const file = join(temp(t), 'drill.json');
  const p = fakeProvider(() => { throw Error('unavailable'); });
  const out = await runDiscovery({ config, provider: p, file, now });
  assert.equal(out.saved, false); assert.equal(existsSync(file), false);
  assert.equal(out.store.rotation, 0);
  const original = empty();
  await discover({ config, provider: fakeProvider(() => []), store: original, now });
  assert.deepEqual(original, empty());
});

test('explicit one-request limit persists across providers and dry runs', async t => {
  assert.equal(createDailyBudget({ env: {} }).limit, 90);
  const dir = temp(t), file = join(dir, 'budget.json');
  const makeBudget = () => createDailyBudget({ env: { GOOGLE_SEARCH_DAILY_LIMIT: '1' }, file, clock: () => now });
  let calls = 0;
  const makeProvider = () => realGoogleProvider({ env, cache: null, budget: makeBudget(), wait: async () => {},
    fetchImpl: async () => { calls++; return response(); } });
  const first = await runDiscovery({ config, provider: makeProvider(),
    file: join(dir, 'opportunities.json'), dryRun: true, now });
  assert.equal(first.summary.apiRequests, 1);
  assert.equal(existsSync(join(dir, 'opportunities.json')), false);
  await assert.rejects(makeProvider().search({ query: 'x', now }), /Daily Google request limit/);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(readFileSync(file)).used, 1);
});

test('retries consume budget; exhaustion prevents retry HTTP', async t => {
  const file = join(temp(t), 'budget.json');
  const budget = createDailyBudget({ env: { GOOGLE_SEARCH_DAILY_LIMIT: '1' }, file, clock: () => now });
  let calls = 0;
  const p = realGoogleProvider({ env, cache: null, budget, wait: async () => {},
    fetchImpl: async () => { calls++; throw Error('uncertain network failure'); } });
  await assert.rejects(p.search({ query: 'x', now }), /Daily Google request limit/);
  assert.equal(calls, 1); assert.equal(p.apiRequests, 1);
});

test('UTC rollover, disabled searches, invalid state and lock fail closed', t => {
  const file = join(temp(t), 'budget.json');
  const budget = date => createDailyBudget({ env: {}, file, clock: () => new Date(date) });
  budget('2026-09-24T23:59:59Z').reserve();
  budget('2026-09-25T00:00:00Z').reserve();
  assert.equal(JSON.parse(readFileSync(file)).used, 1);
  assert.throws(() => budget('2026-09-24T23:59:59Z').reserve(), /Cannot safely/);
  assert.throws(() => createDailyBudget({ env: { GOOGLE_SEARCH_DAILY_LIMIT: '-1' }, file }));
  assert.throws(() => createDailyBudget({ env: { GOOGLE_SEARCH_DAILY_LIMIT: '0' }, file,
    clock: () => new Date('2026-09-26') }).reserve(), /limit reached/);
  const release = acquireLock(file);
  assert.throws(() => budget('2026-09-26').reserve(), /Cannot safely/); release();
  writeFileSync(file, '{broken');
  assert.throws(() => budget('2026-09-26').reserve(), /Cannot safely/);
  assert.equal(readFileSync(file, 'utf8'), '{broken');
});

test('persistent cache hits spend no HTTP budget; expiry and UTC rollover resume HTTP', async t => {
  const dir = temp(t), file = join(dir, 'budget.json');
  let time = now.getTime(), calls = 0;
  const make = () => realGoogleProvider({ env,
    budget: createDailyBudget({ env: { GOOGLE_SEARCH_DAILY_LIMIT: '1' }, file, clock: () => new Date(time) }),
    cache: createSearchCache({ directory: join(dir, 'cache'), clock: () => time }),
    wait: async () => {}, fetchImpl: async () => { calls++; return response(); },
  });
  await make().search({ query: 'x', now });
  const cached = make();
  await cached.search({ query: 'x', now });
  assert.equal(cached.apiRequests, 0); assert.equal(cached.cacheHits, 1); assert.equal(calls, 1);
  time += 6 * 3600e3;
  await assert.rejects(make().search({ query: 'x', now }), /limit reached/);
  time += 864e5;
  await make().search({ query: 'x', now: new Date(time) });
  assert.equal(calls, 2);
});

test('limit is a normal partial stop, preserves results and resumes with changed env', async t => {
  const dir = temp(t), file = join(dir, 'budget.json');
  const make = limit => realGoogleProvider({ env, cache: null,
    budget: createDailyBudget({ env: { GOOGLE_SEARCH_DAILY_LIMIT: limit }, file, clock: () => now }),
    wait: async () => {}, fetchImpl: async () => response(),
  });
  let out = await runDiscovery({ config, provider: make('1'), file: join(dir, 'opps.json'), now });
  assert.equal(out.summary.limitReached, true); assert.equal(out.summary.errors, 0);
  assert.equal(out.summary.apiRequests, 1); assert.equal(out.saved, true);
  assert.equal(out.store.rotation, 0); assert.equal(out.summary.resetsAt, '2026-09-25T00:00:00.000Z');
  out = await runDiscovery({ config, provider: make('1'), file: join(dir, 'opps.json'), now });
  assert.equal(out.summary.errors, 0); assert.equal(out.summary.apiRequests, 0);
  out = await runDiscovery({ config, provider: make('50'), file: join(dir, 'opps.json'), now });
  assert.equal(out.summary.limitReached, false); assert.equal(out.summary.apiRequests, 22);
});

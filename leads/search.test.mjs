// Поиск через Яндекс: разбор XML, отбор UGC-площадок, бюджет, кэш, ротация.
// Сеть не трогаем: провайдер и fetch подменяются.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseResults } from './search/xml.mjs';
import { parseSearchResults, isUgc, websearch } from './search/source.mjs';
import { buildRequest, createYandexProvider } from './search/yandex.mjs';
import { createDailyBudget } from './search/budget.mjs';
import { createSearchCache } from './search/cache.mjs';
import { createState } from './state.mjs';
import { qualify } from './match.mjs';

const xml = readFileSync(new URL('./fixtures/yandex.xml', import.meta.url), 'utf8');
const tmp = () => mkdtempSync(join(tmpdir(), 'leads-test-'));

test('parseResults: документы, подсветка, CDATA, сущности', () => {
  const r = parseResults(xml);
  assert.equal(r.length, 3);
  assert.equal(r[0].url, 'https://otvet.mail.ru/question/100000001');
  assert.equal(r[0].title, 'Ищу разработчика бота для записи клиентов - Ответы Mail');
  assert.equal(r[0].publishedAt, null);
  assert.equal(r[0].providerModifiedAt, '20261115T101500');
  assert.equal(r[2].title, 'Ищу разработчика бота & CRM');
  assert.equal(r[2].snippet, 'Ищем подрядчика: чат-бот + CRM для онлайн-школы. Пишите в ЛС.');
});

test('parseResults: «ничего не найдено» (код 15) — пусто, прочие ошибки — fatal', () => {
  const err = (code) => `<?xml version="1.0"?><yandexsearch><response><error code="${code}">x</error></response></yandexsearch>`;
  assert.deepEqual(parseResults(err(15)), []);
  assert.throws(() => parseResults(err(32)), (e) => e.fatal === true);
  assert.throws(() => parseResults('<!DOCTYPE x><yandexsearch/>'));
});

test('isUgc: вопросы, стены VK, форумы — да; сайты студий и статьи — нет', () => {
  assert.ok(isUgc('https://otvet.mail.ru/question/1'));
  assert.ok(isUgc('https://vk.com/wall-100000_42'));
  assert.ok(isUgc('https://vk.ru/wall843128352_217'));
  assert.ok(isUgc('https://qna.habr.com/q/123'));
  assert.ok(isUgc('https://forum.example.ru/threads/ishchu.1/'));
  assert.ok(!isUgc('https://example-studio.ru/telegram-boty/'));
  assert.ok(!isUgc('https://vc.ru/ai/3152737-kak-sozdat-bota'));
  assert.ok(!isUgc('https://dzen.ru/a/xyz'));
});

test('parseSearchResults + qualify: из выдачи остаются живые запросы', () => {
  const leads = parseSearchResults(parseResults(xml), { query: '"ищу разработчика бота"' });
  assert.deepEqual(leads.map((l) => l.url), ['https://otvet.mail.ru/question/100000001', 'https://vk.com/wall-100000_42']);
  assert.equal(leads[0].kind, 'post');
  assert.equal(leads[0].source, 'Поиск: otvet.mail.ru');
  const q = leads.map((l) => qualify(l, { minBudgetRub: 8000, minBudgetUsd: 150 })).filter(Boolean);
  assert.equal(q.length, 2);
  assert.deepEqual(q[0].budget, { amount: 25000, currency: 'RUB' });
});

test('parseSearchResults: deny-список бирж и их зеркал', () => {
  const r = parseSearchResults([{ url: 'https://profreelance.net/project/1-ishchu', title: 'x' }], { query: 'q' });
  assert.deepEqual(r, []);
});

test('buildRequest: фраза, площадки через |, окно дат', () => {
  const now = new Date('2026-11-18T00:00:00Z');
  const one = buildRequest({ query: '"нужен бот"', domains: ['vk.com'], freshnessDays: 60, now }, 'folder');
  assert.equal(one.query.queryText, '"нужен бот" site:vk.com lang:ru date:20260919..20261118');
  assert.equal(one.folderId, 'folder');
  const many = buildRequest({ query: 'q', domains: ['a.ru', 'b.ru'], now }, 'f');
  assert.match(many.query.queryText, /^q \(site:a\.ru \| site:b\.ru\) lang:ru/);
  assert.throws(() => buildRequest({ query: 'x'.repeat(400), now }, 'f'), /400/);
});

test('budget: резерв до запроса, лимит в сутки, новый день — заново', () => {
  let now = new Date('2026-11-18T10:00:00Z');
  const b = createDailyBudget({ env: { YANDEX_SEARCH_DAILY_LIMIT: '2' }, file: join(tmp(), 'b.json'), clock: () => now });
  b.reserve(); b.reserve();
  assert.equal(b.used(), 2);
  assert.throws(() => b.reserve(), (e) => e.code === 'SEARCH_BUDGET_EXHAUSTED' && e.fatal);
  now = new Date('2026-11-19T00:00:01Z');
  b.reserve();
  assert.equal(b.used(), 1);
  assert.throws(() => createDailyBudget({ env: { YANDEX_SEARCH_DAILY_LIMIT: '-1' } }), /целым/);
});

test('budget: повреждённый файл — запрос не уходит', () => {
  const file = join(tmp(), 'b.json');
  writeFileSync(file, '{"version":1,"day":"2099-01-01","used":0}');
  const b = createDailyBudget({ env: {}, file, clock: () => new Date('2026-11-18T00:00:00Z') });
  assert.throws(() => b.reserve(), (e) => e.fatal && /бюджет/.test(e.message));
});

test('cache: TTL и повреждённые записи', () => {
  let now = 1000;
  const c = createSearchCache({ directory: tmp(), clock: () => now, ttlMs: 100 });
  assert.equal(c.get('k'), null);
  c.set('k', [{ url: 'https://a' }]);
  assert.deepEqual(c.get('k'), [{ url: 'https://a' }]);
  now = 1100;
  assert.equal(c.get('k'), null);
});

test('provider: кэш экономит бюджет, 4xx — fatal без повтора', async () => {
  const dir = tmp();
  let calls = 0;
  const ok = async () => { calls++; return new Response(JSON.stringify({ rawData: Buffer.from(xml).toString('base64') })); };
  const env = { YANDEX_SEARCH_API_KEY: 'k', YANDEX_SEARCH_FOLDER_ID: 'f', YANDEX_SEARCH_DAILY_LIMIT: '5' };
  const budget = createDailyBudget({ env, file: join(dir, 'b.json') });
  const p = createYandexProvider({ env, fetchImpl: ok, wait: async () => {}, budget, cache: createSearchCache({ directory: join(dir, 'c') }) });
  assert.equal((await p.search({ query: 'q' })).length, 3);
  assert.equal((await p.search({ query: 'q' })).length, 3);
  assert.equal(calls, 1);
  assert.equal(budget.used(), 1);

  let denied = 0;
  const forbidden = async () => { denied++; return new Response('no', { status: 403 }); };
  const p2 = createYandexProvider({ env, fetchImpl: forbidden, wait: async () => {}, budget, cache: null });
  await assert.rejects(p2.search({ query: 'z' }), (e) => e.fatal && /403/.test(e.message));
  assert.equal(denied, 1);
  assert.throws(() => createYandexProvider({ env: {} }), /YANDEX_SEARCH_API_KEY/);
});

test('websearch: ротация запросов между прогонами, fatal останавливает прогон', async () => {
  const state = createState({ file: join(tmp(), 'state.json') });
  const asked = [];
  const provider = { search: async ({ query }) => { asked.push(query); return []; } };
  const queries = ['a', 'b', 'c'];
  await websearch({ queries, perRun: 2 }, { state, provider, warn: () => {} });
  await websearch({ queries, perRun: 2 }, { state, provider, warn: () => {} });
  assert.deepEqual(asked, ['a', 'b', 'c', 'a']);

  const fatal = { search: async () => { const e = new Error('limit'); e.fatal = true; asked.push('x'); throw e; } };
  asked.length = 0;
  await websearch({ queries, perRun: 3 }, { provider: fatal, warn: () => {} });
  assert.deepEqual(asked, ['x']);
});

test('state: интервал, метка из будущего, сохранение', () => {
  const file = join(tmp(), 'state.json');
  let now = Date.parse('2026-11-18T00:00:00Z');
  const s = createState({ file, clock: () => now });
  assert.ok(s.due('reddit', 60));
  s.mark('reddit');
  now += 30 * 60e3;
  assert.ok(!s.due('reddit', 60));
  now += 31 * 60e3;
  assert.ok(s.due('reddit', 60));
  s.save();
  const again = createState({ file, clock: () => Date.parse('2026-11-17T00:00:00Z') });
  assert.ok(again.due('reddit', 60)); // часы ушли назад
  assert.ok(again.due('kwork'));
});

test('qualify поиска: намерение берётся из заголовка, а не из чужих ответов в сниппете', () => {
  const cfg = { minBudgetRub: 8000, minBudgetUsd: 150 };
  const [junk, real] = parseSearchResults([
    { url: 'https://otvet.mail.ru/question/1', title: 'Подскажите приколы про котов - user | Ответы Mail', snippet: 'Если тебе нужен телеграм бот, ищи разработчика.' },
    { url: 'https://otvet.mail.ru/question/2', title: 'Нужен чат-бот для телеграмм-чата - user | Ответы Mail', snippet: '' },
  ], { query: 'q' });
  assert.equal(junk.intentText, 'Подскажите приколы про котов - user');
  assert.equal(qualify(junk, cfg), null);
  assert.ok(qualify(real, cfg));
});

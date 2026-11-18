// Парсеры источников на обезличенных фикстурах (структура реальных ответов,
// тексты и id выдуманы). node --test leads/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseKwork, parseFlru, parseReddit, decode } from './sources.mjs';
import { parseTelegram, uniqueRatio, messageText } from './telegram.mjs';
import { parseHn, decodeHn } from './hn.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('parseKwork: только активные, бюджет из priceLimit, дата из МСК в UTC', () => {
  const items = parseKwork(fixture('kwork.html'));
  assert.equal(items.length, 2);
  const [bot, parser] = items;
  assert.equal(bot.id, 'kwork:1000001');
  assert.equal(bot.url, 'https://kwork.ru/projects/1000001');
  assert.equal(bot.title, 'Телеграм бот для записи "на массаж"');
  assert.match(bot.text, /Оплата — по этапам/);
  assert.deepEqual(bot.budget, { amount: 40000, currency: 'RUB' });
  assert.equal(bot.createdAt, '2026-11-17T09:00:00.000Z');
  assert.equal(bot.kind, 'order');
  // «]» внутри строки не обрывает JSON-массив, нулевой бюджет = не указан.
  assert.equal(parser.title, 'Парсер "]" сайта');
  assert.equal(parser.budget, null);
});

test('parseKwork: нет массива wants — пустой список', () => {
  assert.deepEqual(parseKwork('<html>captcha</html>'), []);
});

test('parseFlru: RSS, CDATA и сущности, id из ссылки', () => {
  const items = parseFlru(fixture('flru.xml'));
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 'flru:9000001');
  assert.equal(items[0].title, 'Разработка CRM для салона красоты (Бюджет: 90 000 ₽)');
  assert.equal(items[0].createdAt, '2026-11-17T20:15:00.000Z');
  assert.equal(items[0].kind, 'order');
});

test('parseReddit: с requireTag берёт только [Hiring]', () => {
  const items = parseReddit(fixture('reddit.xml'), 'hiring');
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'reddit:t3_abc001');
  assert.equal(items[0].url, 'https://www.reddit.com/r/forhire/comments/abc001/hiring_telegram_bot/');
  assert.match(items[0].text, /booking system/);
  assert.equal(items[0].kind, 'order');
});

test('parseReddit: без тега — все посты как свободный текст', () => {
  const items = parseReddit(fixture('reddit.xml'));
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.kind === 'post'));
});

test('decode: CDATA, теги, сущности', () => {
  assert.equal(decode('<![CDATA[<b>Бюджет</b>&nbsp;5&#8381; &quot;x&quot; &amp;]]>'), 'Бюджет 5₽ "x" &');
});

test('parseTelegram: сообщения канала, без пустых и чужих', () => {
  const items = parseTelegram(fixture('telegram.html'), 'examplechan');
  assert.equal(items.length, 1);
  const [m] = items;
  assert.equal(m.id, 'tg:examplechan/101');
  assert.equal(m.url, 'https://t.me/examplechan/101');
  assert.equal(m.title, 'Ищем разработчика Telegram-бота');
  assert.match(m.text, /Бюджет 30 000 ₽! Сроки & детали/);
  assert.equal(m.createdAt, '2026-11-17T10:00:00.000Z');
  assert.equal(m.kind, 'post');
});

test('messageText: <br> в перевод строки, числовые сущности', () => {
  assert.equal(messageText('Привет&#33;<br/>Строка&nbsp;2'), 'Привет!\nСтрока 2');
});

test('uniqueRatio: повторы видны', () => {
  const p = (text) => ({ text });
  assert.equal(uniqueRatio([]), 1);
  assert.equal(uniqueRatio([p('a'), p('a'), p('a'), p('b')]), 0.5);
});

test('parseHn: комментарии с текстом, контекст треда', () => {
  const items = parseHn(JSON.parse(fixture('hn.json')));
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 'hn:45000001');
  assert.equal(items[0].url, 'https://news.ycombinator.com/item?id=45000001');
  assert.equal(items[0].title, 'SEEKING FREELANCER | Remote | Berlin');
  assert.equal(items[0].context, 'Ask HN: Freelancer? Seeking freelancer? (November 2026)');
  assert.equal(items[0].kind, 'post');
  assert.match(items[1].text, /React & Node/);
});

test('parseHn: неожиданный ответ — ошибка, а не тихий ноль', () => {
  assert.throws(() => parseHn({ message: 'rate limited' }), /hits/);
});

test('decodeHn: сущности Algolia', () => {
  assert.equal(decodeHn('a&#x2F;b&#x27;s <i>x</i>'), "a/b's x");
});

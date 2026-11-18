import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualify, parseBudget, hasIntent, matchServices, unicodeRegex } from './match.mjs';

const config = { minBudgetRub: 8000, minBudgetUsd: 150 };
const order = (title, text = '', extra = {}) => ({ id: 'x', title, text, budget: null, kind: 'order', ...extra });
const post = (title, text = '') => order(title, text, { kind: 'post' });

test('unicodeRegex: граница слова видит кириллицу', () => {
  const rx = unicodeRegex('\\bтг\\b');
  assert.ok(rx.test('бот в тг для записи'));
  assert.ok(!rx.test('итгоговый'));
});

test('matchServices: услуги iamonline', () => {
  assert.deepEqual(matchServices('Нужен Telegram-бот'), ['bot']);
  assert.deepEqual(matchServices('сделать mini app для магазина'), ['miniApp']);
  assert.deepEqual(matchServices('CRM для салона'), ['crm']);
  assert.deepEqual(matchServices('нужен лендинг'), ['site']);
  assert.deepEqual(matchServices('ищу разработчика бота чат менеджера'), ['bot']);
  assert.deepEqual(matchServices('нужен чат бот для группы'), ['bot']);
  assert.deepEqual(matchServices('нужен логотип'), []);
});

test('parseBudget', () => {
  assert.deepEqual(parseBudget('Бюджет: 6 000 ₽'), { amount: 6000, currency: 'RUB' });
  assert.deepEqual(parseBudget('до 50000 руб'), { amount: 50000, currency: 'RUB' });
  assert.deepEqual(parseBudget('budget $1,500'), { amount: 1500, currency: 'USD' });
  assert.deepEqual(parseBudget('500 usd'), { amount: 500, currency: 'USD' });
  assert.equal(parseBudget('$40/hr'), null);
  assert.equal(parseBudget('1500 руб/час'), null);
  assert.equal(parseBudget('без бюджета'), null);
});

test('qualify: заказ с биржи под услугу проходит', () => {
  const q = qualify(order('Телеграм бот для записи', '', { budget: { amount: 40000, currency: 'RUB' } }), config);
  assert.deepEqual(q.services, ['bot']);
});

test('qualify: бюджет ниже порога и стоп-слова отсекаются', () => {
  assert.equal(qualify(order('Телеграм бот', 'Бюджет 3000 руб'), config), null);
  assert.equal(qualify(order('Telegram bot', 'budget $50'), config), null);
  assert.equal(qualify(order('Телеграм бот для парсинга чатов'), config), null);
  assert.equal(qualify(order('Бот для накрутки'), config), null);
  assert.equal(qualify(order('Лендинг на Тильде'), config), null);
  assert.equal(qualify(order('Бот для Аризона РП', 'проект rp'), config), null);
  assert.equal(qualify(order('Телеграм бот', 'обходить капчу'), config), null);
});

test('qualify: вакансия в штат — не заказ', () => {
  assert.equal(qualify(order('Разработчик телеграм ботов', 'полная занятость, оклад'), config), null);
});

test('qualify: свободный текст требует намерения «ищу исполнителя»', () => {
  assert.ok(qualify(post('Ищу разработчика телеграм бота для записи клиентов'), config));
  assert.ok(qualify(post('Посоветуйте, кто сделает CRM для салона красоты?'), config));
  // Статья или самопрезентация — не лид.
  assert.equal(qualify(post('Как сделать телеграм бота для бизнеса'), config), null);
  assert.equal(qualify(post('Сделаю бота под ключ', 'опыт 5 лет, моё портфолио'), config), null);
  assert.equal(qualify(post('Разработка Telegram-ботов под ключ от 15 000 ₽', 'Ищу разработчика, нужен бот — так пишут клиенты'), config), null);
  // Ищут не разработчика, бот только упомянут.
  assert.equal(qualify(post('Ищу дизайнера', 'для оформления телеграм бота'), config), null);
  // Реклама канала.
  assert.equal(qualify(post('Нужен телеграм бот?', 'Подписывайтесь на наш канал'), config), null);
});

test('hasIntent: EN', () => {
  assert.ok(hasIntent('SEEKING FREELANCER | We are looking for a developer to build a Telegram bot'));
  assert.ok(!hasIntent('SEEKING WORK | Remote. Full-stack dev, I can build SaaS dashboards'));
});

test('qualify: риторические заголовки статей — не лид', () => {
  assert.equal(qualify(post('Кому и зачем нужен чат-бот? (Спойлер: всем)'), config), null);
  assert.equal(qualify(post('Когда бизнесу реально нужен чат-бот (а когда можно и без него)?'), config), null);
});

test('qualify: ищут готовых ботов или проводят опрос — не лид', () => {
  assert.equal(qualify(post('Подскажите ботов в Тг, что общаются матом'), config), null);
  assert.equal(qualify(post('Владельцы малого бизнеса, как сильно вам нужны чат боты для адаптации?'), config), null);
  assert.ok(qualify(post('Посоветуйте разработчиков ботов для записи клиентов'), config));
  assert.ok(qualify(post('Нужен чат-бот для телеграмм-чата'), config));
});

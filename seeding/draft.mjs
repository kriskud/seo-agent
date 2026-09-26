// Драфтер черновиков ответов по relevant-тредам сидинга. Запускается ЛОКАЛЬНО
// (на маке): реестр забирается с vps2 по ssh, тред скачивается с резидентного
// IP, черновик пишет `claude -p`. Публикация — только вручную, черновики
// лежат в data/seeding/drafts/<project>/ и в git не попадают (data/ в
// .gitignore).
//
//   node seeding/draft.mjs --project drill [--limit N] [--model sonnet]
//                          [--dry-run]  # показать промпты, не звать LLM
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../lib.mjs';
import { PROJECTS } from './discover.mjs';

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const REMOTE_REGISTRY = p => `~/projects/seo-agent/data/seeding/${p}.json`;

// Ассеты, на которые черновику можно сослаться (не больше одного на ответ).
// Ссылки — только на страницы проектов; никаких /go/, реф-тегов и промокодов.
export const PROJECT_META = {
  drill: {
    about: 'drill.poker — бесплатные интерактивные покерные тренажёры (пуш-фолд, ICM, GTO, кэш против AI) с чартами и статьями; без регистрации.',
    locales: 'Ссылки давай под язык треда: /en/ для английского, /es/ для испанского, /pt/ для португальского, /ru/ для русского.',
    assets: [
      ['https://drill.poker/en/trainers/push-fold', 'пуш-фолд тренажёр'],
      ['https://drill.poker/en/trainers/icm', 'ICM-тренажёр'],
      ['https://drill.poker/en/trainers/gto', 'GTO-тренажёр (частоты, MDF, сетка 13×13)'],
      ['https://drill.poker/en/trainers/cash-ai', 'кэш-тренажёр против AI'],
      ['https://drill.poker/en/charts', 'хаб пуш-фолд чартов по позициям и стекам'],
      ['https://drill.poker/en/charts/call-vs-push', 'чарт колла против пуша'],
      ['https://drill.poker/en/glossary', 'глоссарий терминов'],
      ['https://drill.poker/en/articles', 'статьи: ICM без формул, MDF, банкролл под МТТ, игра на баббле, стек 10bb'],
    ],
  },
  floprooms: {
    about: 'floprooms.com — независимый рейтинг покерных румов с проверяемой методологией: скорость и пороги вывода, KYC, лицензии, трафик.',
    locales: 'Английские страницы в корне; для русского/испанского/португальского треда добавь префикс /ru, /es или /pt к пути.',
    assets: [
      ['https://floprooms.com/rooms', 'рейтинг румов с баллами по факторам'],
      ['https://floprooms.com/withdrawal-gates', 'сравнение выводов и KYC-порогов по румам'],
      ['https://floprooms.com/compare', 'сравнение румов бок о бок'],
      ['https://floprooms.com/methodology', 'методология оценки'],
      ['https://floprooms.com/reviews/americas-cardroom-review-2026', 'обзор ACR'],
      ['https://floprooms.com/reviews/wpt-global-review-2026', 'обзор WPT Global'],
      ['https://floprooms.com/reviews/coinpoker-review-2026', 'обзор CoinPoker'],
      ['https://floprooms.com/reviews/natural8-review-2026', 'обзор Natural8'],
      ['https://floprooms.com/reviews/redstar-poker-review-2026', 'обзор RedStar'],
      ['https://floprooms.com/reviews/betonline-review-2026', 'обзор BetOnline'],
      ['https://floprooms.com/reviews/black-chip-poker-review-2026', 'обзор Black Chip'],
    ],
  },
};

export function htmlToText(html, cap = 8000) {
  return html
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(amp|#38);/g, '&').replace(/&(lt|#60);/g, '<').replace(/&(gt|#62);/g, '>')
    .replace(/&(quot|#34);/g, '"').replace(/&(#39|apos);/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, cap);
}

// Пост + верхние комментарии из публичного Atom-фида треда Reddit
// (<тред>/.rss). Контент в Atom экранирован дважды: первый проход htmlToText
// раскрывает сущности до HTML, второй убирает теги.
export function atomToThreadText(xml, cap = 8000) {
  if (typeof xml !== 'string' || !/<feed[\s>]/.test(xml)) throw new Error('Invalid Atom thread');
  const parts = [];
  for (const [, entry] of xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g)) {
    const pick = tag => entry.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`))?.[1] ?? '';
    const label = parts.length === 0 ? `ПОСТ (${htmlToText(pick('name'))}): ${htmlToText(pick('title'))}`
      : `КОММЕНТАРИЙ (${htmlToText(pick('name'))})`;
    parts.push(`${label}\n${htmlToText(htmlToText(pick('content')))}`.trim());
    if (parts.length > 9) break;
  }
  if (!parts.length) throw new Error('Empty Atom thread');
  return parts.join('\n\n').slice(0, cap);
}

// Транспорт: локальный curl с DoH (местная сеть режет часть хостов на уровне
// DNS: reddit → 127.0.0.1, DoH это обходит), при неудаче — curl с vps2
// (обратная ситуация к GipsyTeam, который недоступен как раз с vps2; reddit
// с датацентрового IP vps2 отдаёт 403, поэтому vps2 только запасной).
export function localCurl(url) {
  const res = spawnSync('curl', ['-sfL', '--doh-url', 'https://1.1.1.1/dns-query',
    '--max-time', '20', '-A', BROWSER_UA, url], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`curl exited ${res.status}`);
  return res.stdout;
}

export function sshCurl(url) {
  const res = spawnSync('ssh', ['vps2', 'curl', '-sfL', '--max-time', '20', '-A', JSON.stringify(BROWSER_UA), JSON.stringify(url)],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`vps2 curl exited ${res.status}`);
  return res.stdout;
}

// JSON-представление тредов Reddit недоступно ни отсюда (login-wall для
// региона), ни с vps2 (403 датацентру), а вот Atom-фид треда с vps2 отдаётся —
// как и ленты в providers/reddit-rss.mjs.
export function threadRequestUrl(url) {
  const u = new URL(url);
  if (!u.hostname.endsWith('reddit.com')) return { target: url, isReddit: false };
  u.hostname = 'www.reddit.com';
  u.pathname = u.pathname.replace(/\/?$/, '/') + '.rss';
  u.search = '';
  return { target: u.href, isReddit: true };
}

export function fetchThread(url, fetchLocal = localCurl, fetchRemote = sshCurl) {
  const { target, isReddit } = threadRequestUrl(url);
  const [first, second] = isReddit ? [fetchRemote, fetchLocal] : [fetchLocal, fetchRemote];
  let body;
  try { body = first(target); }
  catch { body = second(target); }
  return isReddit ? atomToThreadText(body) : htmlToText(body);
}

export function pickPending(rows, hasDraft, limit = Infinity) {
  return rows.filter(r => r.status === 'relevant' && !r.draft && !hasDraft(r.id.slice(0, 12))).slice(0, limit);
}

// Черновик уезжает и в реестр на vps2 — вьюер review.mjs показывает его рядом
// с тредом (кнопка «Черновик» → скопировать → открыть тред).
export function pushDraftToRegistry(project, id, draft, model) {
  const res = spawnSync('ssh', ['vps2', 'node', '~/projects/seo-agent/seeding/set-draft.mjs'],
    { input: JSON.stringify({ project, id, draft, model }), encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`set-draft failed: ${(res.stderr ?? '').slice(0, 200)}`);
}

export function buildPrompt(row, threadText, meta) {
  const assets = meta.assets.map(([url, what]) => `- ${url} — ${what}`).join('\n');
  const langHint = ['gipsyteam', 'pokeroff'].includes(row.platform)
    ? 'Тред русскоязычный — отвечай по-русски.'
    : 'Определи язык треда по тексту и отвечай на нём.';
  return `Ты помогаешь владельцу сайта писать черновики ответов в форумные треды. Ниже тред и справка о сайте. Напиши ОДИН черновик ответа в этот тред.

О сайте: ${meta.about}

Страницы, на которые можно сослаться (${meta.locales}):
${assets}

Жёсткие правила:
- ${langHint}
- 60–150 слов, тон площадки (${row.platform}), по существу вопроса автора. Сначала реальная польза — конкретный совет или ответ, ссылка лишь как естественное дополнение.
- Максимум ОДНА ссылка. Если ссылка в этом треде неуместна — напиши полезный ответ вовсе без неё.
- Никаких бонус-кодов, промокодов и реф-ссылок (в частности НИКОГДА не упоминай бонус-коды CoinPoker). Ссылки только на страницы, перечисленные выше.
- Не представляйся сотрудником сайта и не скрывай пользу поста за рекламой; никаких «лучший в мире», честно и конкретно.
- Не поливай грязью другие румы/тренажёры.
- Для reddit используй markdown, для классических форумов — обычный текст.
- Если тред для ответа не подходит (оффтоп, слишком старый, вопрос закрыт, ответ будет выглядеть спамом) — выведи ровно "SKIP: <причина>" и ничего больше.

Выведи только текст ответа (или SKIP), без пояснений.

--- ТРЕД (${row.url}) ---
${threadText}`;
}

export function runClaude(prompt, model) {
  const res = spawnSync('claude', ['-p', '--model', model], {
    input: prompt, encoding: 'utf8', timeout: 300000, maxBuffer: 10 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`claude -p exited ${res.status}: ${(res.stderr ?? '').slice(0, 300)}`);
  const out = res.stdout.trim();
  if (!out) throw new Error('claude -p returned empty output');
  return out;
}

function loadRegistry(project) {
  const local = join(ROOT, `data/seeding/${project}.json`);
  if (existsSync(local)) return JSON.parse(readFileSync(local, 'utf8'));
  const res = spawnSync('ssh', ['vps2', 'cat', REMOTE_REGISTRY(project)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`Cannot read registry over ssh: ${(res.stderr ?? '').slice(0, 200)}`);
  return JSON.parse(res.stdout);
}

async function main() {
  const args = process.argv.slice(2);
  const usage = `Usage: node seeding/draft.mjs --project <${PROJECTS.join('|')}> [--limit N] [--model name] [--dry-run]`;
  if (args.includes('--help')) { console.log(usage); return; }
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const project = opt('--project');
  if (!PROJECTS.includes(project)) throw new Error(usage);
  const limit = opt('--limit') ? Number(opt('--limit')) : Infinity;
  const model = opt('--model') ?? 'sonnet';
  const dryRun = args.includes('--dry-run');

  const dir = join(ROOT, `data/seeding/drafts/${project}`);
  const registry = loadRegistry(project);
  const pending = pickPending(registry.opportunities, id => existsSync(join(dir, id + '.md')), limit);
  console.log(`${project}: relevant без черновика — ${pending.length}${dryRun ? ' (dry run)' : ''}`);

  let drafted = 0, skipped = 0, failed = 0, redditFetched = false;
  for (const row of pending) {
    const id = row.id.slice(0, 12);
    process.stdout.write(`[${id}] ${row.title.slice(0, 60)} … `);
    // Reddit без авторизации терпит примерно запрос в минуту с одного IP —
    // та же пауза, что и в providers/reddit-rss.mjs.
    if (row.platform === 'reddit' && redditFetched) await sleep(65_000);
    if (row.platform === 'reddit') redditFetched = true;
    let text;
    try { text = await fetchThread(row.canonicalUrl); }
    catch (e) { console.log(`тред не скачался: ${e.message}`); failed++; continue; }
    const prompt = buildPrompt(row, text, PROJECT_META[project]);
    if (dryRun) { console.log('\n' + prompt.slice(0, 1500) + '\n…\n'); continue; }
    let draft;
    try { draft = runClaude(prompt, model); }
    catch (e) { console.log(`LLM не ответил: ${e.message}`); failed++; continue; }
    const isSkip = draft.startsWith('SKIP');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, id + '.md'), `---
url: ${row.url}
title: ${JSON.stringify(row.title)}
platform: ${row.platform}
generatedAt: ${new Date().toISOString()}
model: ${model}
---

${draft}

> ⚠️ Черновик. Проверить факты, адаптировать под ветку и опубликовать вручную.
`);
    let pushed = '';
    try { pushDraftToRegistry(project, row.id, draft, model); }
    catch (e) { pushed = ` (в реестр не ушло: ${e.message})`; }
    if (isSkip) { console.log(draft.split('\n')[0] + pushed); skipped++; }
    else { console.log('черновик готов' + pushed); drafted++; }
  }
  console.log(`\nИтого: черновиков ${drafted}, SKIP ${skipped}, ошибок ${failed}. Папка: ${dir}`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => { console.error(`[draft] ${e.message}`); process.exitCode = 1; });
}

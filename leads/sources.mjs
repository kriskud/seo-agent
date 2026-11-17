// Источники заказов. Каждый возвращает [{ id, source, url, title, text, budget, createdAt }].
// Ошибка одного источника не роняет остальные — её видно в сводке.
import { UA } from '../lib.mjs';

const MSK_OFFSET_H = 3;

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

export const decode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#8381;/g, '₽').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

/** Kwork: заказы лежат JSON-массивом "wants" прямо в HTML страницы категории. */
export function parseKwork(html) {
  const i = html.indexOf('"wants":[');
  if (i < 0) return [];
  const s = html.slice(i + 8);
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let j = 0; j < s.length; j++) {
    const ch = s[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) { end = j; break; }
  }
  if (end < 0) return [];
  return JSON.parse(s.slice(0, end + 1)).filter((w) => w.status === 'active').map((w) => ({
    id: `kwork:${w.id}`,
    source: 'Kwork',
    url: `https://kwork.ru/projects/${w.id}`,
    title: decode(w.name ?? ''),
    text: decode(w.description ?? ''),
    budget: Number(w.priceLimit) > 0 ? { amount: Number(w.priceLimit), currency: 'RUB' } : null,
    // date_create — московское время без зоны
    createdAt: w.date_create
      ? new Date(Date.parse(w.date_create.replace(' ', 'T') + 'Z') - MSK_OFFSET_H * 3600e3).toISOString()
      : null,
  }));
}

export async function kwork({ categories }) {
  const out = [];
  for (const c of categories) out.push(...parseKwork(await fetchText(`https://kwork.ru/projects?c=${c}`)));
  return out;
}

const tag = (item, name) => new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(item)?.[1] ?? '';

/** FL.ru: обычный RSS; бюджет пишут в заголовке «(Бюджет: 6 000 ₽)». */
export function parseFlru(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const link = decode(tag(it, 'link'));
    return {
      id: `flru:${/projects\/(\d+)/.exec(link)?.[1] ?? link}`,
      source: 'FL.ru',
      url: link,
      title: decode(tag(it, 'title')),
      text: decode(tag(it, 'description')),
      budget: null,
      createdAt: new Date(decode(tag(it, 'pubDate'))).toISOString(),
    };
  });
}

export async function flru({ feeds }) {
  const out = [];
  for (const f of feeds) out.push(...parseFlru(await fetchText(f)));
  return out;
}

/** Reddit: Atom-лента сабреддита; берём только посты с тегом [Hiring]. */
export function parseReddit(xml, requireTag) {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map(([, e]) => ({
      id: `reddit:${decode(tag(e, 'id'))}`,
      source: 'Reddit',
      url: /<link href="([^"]+)"/.exec(e)?.[1] ?? '',
      title: decode(tag(e, 'title')),
      text: decode(tag(e, 'content')).slice(0, 1500),
      budget: null,
      createdAt: new Date(decode(tag(e, 'updated'))).toISOString(),
    }))
    .filter((x) => !requireTag || new RegExp(`\\[${requireTag}\\]`, 'i').test(x.title));
}

export async function reddit({ subreddits, requireTag }) {
  const out = [];
  for (const s of subreddits) out.push(...parseReddit(await fetchText(`https://www.reddit.com/r/${s}/new.rss`), requireTag));
  return out;
}

export const SOURCES = { kwork, flru, reddit };

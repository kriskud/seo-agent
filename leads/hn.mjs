// Hacker News через публичный Algolia-индекс (ключ не нужен).
// Ценное место — ежемесячный тред «Ask HN: Freelancer? Seeking freelancer?»:
// комментарии «SEEKING FREELANCER» пишут заказчики, EN-рынок, конкуренция
// несопоставимо ниже, чем на биржах. «SEEKING WORK» — наоборот, исполнители,
// их отбрасывает фильтр намерения в match.mjs.
import { UA } from '../lib.mjs';

const ENDPOINT = 'https://hn.algolia.com/api/v1/search_by_date';

export function decodeHn(text) {
  return (text ?? '')
    .replace(/<p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x2F;/gi, '/').replace(/&#x27;/gi, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseHn(payload) {
  if (!payload || !Array.isArray(payload.hits)) throw new Error('HN: в ответе нет hits');
  return payload.hits.filter((h) => h.objectID && h.comment_text).map((h) => {
    const text = decodeHn(h.comment_text);
    return {
      id: `hn:${h.objectID}`,
      source: 'HN',
      url: `https://news.ycombinator.com/item?id=${h.objectID}`,
      title: text.split('\n')[0].slice(0, 160),
      text: text.slice(0, 2000),
      budget: null,
      createdAt: h.created_at ?? (h.created_at_i ? new Date(h.created_at_i * 1000).toISOString() : null),
      kind: 'post',
      context: h.story_title ?? null,
    };
  });
}

export async function hn({ queries, hitsPerPage = 40, freshnessDays = 45 }) {
  const since = Math.floor((Date.now() - freshnessDays * 864e5) / 1000);
  const out = [];
  for (const query of queries) {
    const url = `${ENDPOINT}?query=${encodeURIComponent(query)}&tags=comment`
      + `&hitsPerPage=${hitsPerPage}&numericFilters=created_at_i>${since}`;
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`HN: HTTP ${res.status}`);
    out.push(...parseHn(await res.json()));
  }
  return out;
}

import { setTimeout as sleep } from 'node:timers/promises';

// Keyless discovery: public per-subreddit Atom feeds (reddit.com/r/<sub>/new.rss).
// Read-only, one request per subreddit per run, no API credentials involved.
// A browser-like UA is required: datacenter IPs get 403 for other agents.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&#x27;': "'" };
const decode = s => s.replace(/&(?:amp|lt|gt|quot|#39|apos|#x27);/g, m => entities[m]);
const clean = s => decode(decode(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

export function parseFeed(xml) {
  if (typeof xml !== 'string' || !/<feed[\s>]/.test(xml)) throw new Error('Invalid Atom feed');
  const rows = [];
  for (const [, entry] of xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/g)) {
    const pick = tag => entry.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`))?.[1] ?? '';
    const link = entry.match(/<link\b[^>]*\bhref="([^"]+)"/)?.[1];
    const publishedRaw = pick('published') || pick('updated');
    const published = Number.isFinite(Date.parse(publishedRaw)) ? new Date(publishedRaw).toISOString() : null;
    if (!link) continue;
    rows.push({ url: decode(link), title: clean(pick('title')), snippet: clean(pick('content')).slice(0, 300), publishedAt: published });
  }
  return rows;
}

export function matchesKeywords(row, keywords) {
  const text = (row.title + ' ' + row.snippet).toLowerCase();
  return keywords.some(k => text.includes(k.toLowerCase()));
}

export function createRedditRssProvider({ keywords, fetchImpl = fetch, wait = sleep, timeoutMs = 20000 } = {}) {
  if (!Array.isArray(keywords) || keywords.length === 0) throw new Error('Reddit provider needs keywords');
  let apiRequests = 0;
  return {
    name: 'reddit-rss',
    get apiRequests() { return apiRequests; },
    async search({ query, freshnessDays = 7, minResultDate = null, now = new Date() }) {
      const sub = /^r\/([A-Za-z0-9_]{2,21})$/.exec(query)?.[1];
      if (!sub) throw new Error('Reddit search query must look like r/<subreddit>');
      if (apiRequests) await wait(1100);
      apiRequests++;
      let text;
      try {
        const response = await fetchImpl(`https://www.reddit.com/r/${sub}/new.rss?limit=100`,
          { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) throw new Error(`Reddit HTTP ${response.status}`);
        text = await response.text();
      } catch (e) {
        throw new Error(`Reddit feed r/${sub} failed: ${e.message}`);
      }
      const since = new Date(now.getTime() - freshnessDays * 864e5).toISOString();
      const lower = minResultDate && minResultDate > since.slice(0, 10) ? minResultDate : since;
      return parseFeed(text).filter(row => row.publishedAt && row.publishedAt >= lower
        && row.publishedAt <= now.toISOString() && matchesKeywords(row, keywords));
    },
  };
}

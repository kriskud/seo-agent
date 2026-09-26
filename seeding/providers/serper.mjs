import { setTimeout as sleep } from 'node:timers/promises';
import { createDailyBudget } from '../budget.mjs';
import { createSearchCache } from '../cache.mjs';

const ENDPOINT = 'https://google.serper.dev/search';

// Локали банков → страна/язык выдачи Serper (обычные gl/hl Google).
// es/pt нацелены на ЛатАм: Мексика и Бразилия как крупнейшие рынки.
const LOCALES = { ru: { gl: 'ru', hl: 'ru' }, en: { gl: 'us', hl: 'en' },
  es: { gl: 'mx', hl: 'es' }, pt: { gl: 'br', hl: 'pt-br' } };

// Cache/request identity deliberately excludes the API key, so it is never
// hashed to disk and rotating credentials keeps the cache warm.
export function buildBody({ query, domain = null, language = 'en', freshnessDays = 7, minResultDate = null, now = new Date() }) {
  const since = new Date(now.getTime() - freshnessDays * 864e5).toISOString().slice(0, 10);
  const lower = minResultDate && minResultDate > since ? minResultDate : since;
  // tbs=qdr:dN is Google's rolling recency window; Serper passes it through.
  const days = Math.max(1, Math.ceil((now.getTime() - Date.parse(lower)) / 864e5));
  const q = domain ? `${query} site:${domain}` : query;
  if (q.length > 400) throw new Error('Serper query exceeds 400 characters');
  const { gl, hl } = LOCALES[language] ?? LOCALES.en;
  return { q, gl, hl, num: 10, tbs: days === 1 ? 'qdr:d' : `qdr:d${days}` };
}

export function parseItems(payload) {
  if (typeof payload !== 'object' || payload === null || (payload.organic !== undefined && !Array.isArray(payload.organic))) {
    throw new Error('Invalid Serper response');
  }
  return (payload.organic ?? []).filter(item => typeof item.link === 'string').map(item => ({
    url: item.link, title: item.title ?? '', snippet: (item.snippet ?? '').replace(/\s+/g, ' ').trim(),
    publishedAt: null,
  }));
}

export function createSerperProvider({ env = process.env, fetchImpl = fetch, wait = sleep, timeoutMs = 20000,
  budget = createDailyBudget({ env }), cache = createSearchCache() } = {}) {
  const key = env.SERPER_API_KEY?.trim();
  if (!key) throw new Error('Set SERPER_API_KEY in environment or .env');
  let apiRequests = 0;
  let cacheHits = 0;
  return {
    name: 'serper',
    dailyLimit: budget.limit,
    get apiRequests() { return apiRequests; },
    get cacheHits() { return cacheHits; },
    async search(options) {
      const body = JSON.stringify(buildBody(options));
      const cached = cache?.get(body);
      if (cached != null) { cacheHits++; return cached; }
      for (let attempt = 0; attempt < 2; attempt++) {
        // At least one second between HTTP attempts, including retries.
        if (apiRequests) await wait(attempt ? 3000 : 1100);
        budget.reserve();
        apiRequests++;
        let response, payload;
        try {
          // The credential travels only in the request header; errors below
          // carry status codes, never the header or response body.
          response = await fetchImpl(ENDPOINT, { method: 'POST', body,
            headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(timeoutMs) });
          if (response.ok) payload = await response.json();
        } catch { continue; }
        if (!response.ok) {
          const e = new Error(`Serper HTTP ${response.status}`);
          // Credit and auth failures will not heal within this run.
          if ([401, 403, 429].includes(response.status)) e.fatal = true;
          if (e.fatal) throw e;
          continue;
        }
        const results = parseItems(payload);
        cache?.set(body, results);
        return results;
      }
      throw new Error('Serper search failed (network/timeout); retries exhausted');
    },
  };
}

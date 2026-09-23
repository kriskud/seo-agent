import { setTimeout as sleep } from 'node:timers/promises';
import { createDailyBudget } from '../budget.mjs';
import { createSearchCache } from '../cache.mjs';

const ENDPOINT = 'https://www.googleapis.com/customsearch/v1';

// Cache/request identity deliberately excludes the API key and engine id, so
// neither is hashed to disk and rotating credentials keeps the cache warm.
export function buildParams({ query, domain = null, language = 'en', freshnessDays = 7, minResultDate = null, now = new Date() }) {
  const since = new Date(now.getTime() - freshnessDays * 864e5).toISOString().slice(0, 10);
  const lower = minResultDate && minResultDate > since ? minResultDate : since;
  // dateRestrict is Google's only recency filter: a rolling day window.
  const days = Math.max(1, Math.ceil((now.getTime() - Date.parse(lower)) / 864e5));
  const q = domain ? `${query} site:${domain}` : query;
  if (q.length > 400) throw new Error('Google query exceeds 400 characters');
  return new URLSearchParams({ q, num: '10', dateRestrict: `d${days}`, lr: `lang_${language}` });
}

export function parseItems(payload) {
  if (typeof payload !== 'object' || payload === null || (payload.items !== undefined && !Array.isArray(payload.items))) {
    throw new Error('Invalid Google response');
  }
  return (payload.items ?? []).filter(item => typeof item.link === 'string').map(item => ({
    url: item.link, title: item.title ?? '', snippet: (item.snippet ?? '').replace(/\s+/g, ' ').trim(),
    publishedAt: null,
  }));
}

export function createGoogleProvider({ env = process.env, fetchImpl = fetch, wait = sleep, timeoutMs = 20000,
  budget = createDailyBudget({ env }), cache = createSearchCache() } = {}) {
  const key = env.GOOGLE_CSE_KEY?.trim();
  const cx = env.GOOGLE_CSE_CX?.trim();
  if (!key || !cx) throw new Error('Set GOOGLE_CSE_KEY and GOOGLE_CSE_CX in environment or .env');
  let apiRequests = 0;
  let cacheHits = 0;
  return {
    name: 'google',
    dailyLimit: budget.limit,
    get apiRequests() { return apiRequests; },
    get cacheHits() { return cacheHits; },
    async search(options) {
      const params = buildParams(options);
      const cacheKey = params.toString();
      const cached = cache?.get(cacheKey);
      if (cached != null) { cacheHits++; return cached; }
      for (let attempt = 0; attempt < 2; attempt++) {
        // At least one second between HTTP attempts, including retries.
        if (apiRequests) await wait(attempt ? 3000 : 1100);
        budget.reserve();
        apiRequests++;
        let response, payload;
        try {
          // Credentials travel only in the request URL; errors below carry
          // status codes, never the URL or response body.
          const url = `${ENDPOINT}?${cacheKey}&key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}`;
          response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
          if (response.ok) payload = await response.json();
        } catch { continue; }
        if (!response.ok) {
          const e = new Error(`Google HTTP ${response.status}`);
          // Quota and auth failures will not heal within this run.
          if ([401, 403, 429].includes(response.status)) e.fatal = true;
          if (e.fatal) throw e;
          continue;
        }
        const results = parseItems(payload);
        cache?.set(cacheKey, results);
        return results;
      }
      throw new Error('Google search failed (network/timeout); retries exhausted');
    },
  };
}

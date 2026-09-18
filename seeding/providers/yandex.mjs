import { setTimeout as sleep } from 'node:timers/promises';
import { parseResults } from './xml.mjs';
import { createDailyBudget } from '../budget.mjs';
import { createSearchCache } from '../cache.mjs';

const ENDPOINT = 'https://searchapi.api.cloud.yandex.net/v2/web/search';

export function buildRequest({ query, domain, freshnessDays = 7, minResultDate = null, language = 'ru', now = new Date() }, folderId) {
  const since = new Date(now.getTime() - freshnessDays * 864e5).toISOString().slice(0, 10);
  const lower = minResultDate && minResultDate > since ? minResultDate : since;
  const compact = d => d.replaceAll('-', '');
  const queryText = [query, domain && `site:${domain}`, `lang:${language}`,
    `date:${compact(lower)}..${compact(now.toISOString().slice(0, 10))}`].filter(Boolean).join(' ');
  if (queryText.length > 400) throw new Error('Yandex query exceeds 400 characters');
  return {
    query: { searchType: 'SEARCH_TYPE_RU', queryText, page: '0', fixTypoMode: 'FIX_TYPO_MODE_OFF' },
    folderId, responseFormat: 'FORMAT_XML', l10n: 'LOCALIZATION_RU',
    groupSpec: { groupMode: 'GROUP_MODE_FLAT', groupsOnPage: '10', docsInGroup: '1' },
    maxPassages: '3', sortSpec: { sortMode: 'SORT_MODE_BY_RELEVANCE', sortOrder: 'SORT_ORDER_DESC' },
  };
}

export function createYandexProvider({ env = process.env, fetchImpl = fetch, wait = sleep, timeoutMs = 20000,
  budget = createDailyBudget({ env }), cache = createSearchCache() } = {}) {
  const key = env.YANDEX_SEARCH_API_KEY?.trim();
  const folder = env.YANDEX_SEARCH_FOLDER_ID?.trim();
  if (!key || !folder) throw new Error('Set YANDEX_SEARCH_API_KEY and YANDEX_SEARCH_FOLDER_ID in environment or .env');
  let apiRequests = 0;
  let cacheHits = 0;
  return {
    name: 'yandex',
    dailyLimit: budget.limit,
    get apiRequests() { return apiRequests; },
    get cacheHits() { return cacheHits; },
    async search(options) {
      const body = JSON.stringify(buildRequest(options, folder));
      const cached = cache?.get(body);
      if (cached != null) { cacheHits++; return cached; }
      for (let attempt = 0; attempt < 2; attempt++) {
        // At least one second between HTTP attempts, including retries.
        if (apiRequests) await wait(attempt ? 3000 : 1100);
        budget.reserve();
        apiRequests++;
        let response, payload;
        try {
          response = await fetchImpl(ENDPOINT, {
            method: 'POST', redirect: 'error',
            headers: { Authorization: `Api-Key ${key}`, 'Content-Type': 'application/json' },
            body, signal: AbortSignal.timeout(timeoutMs),
          });
          if (response.ok) payload = await response.json();
          else await response.body?.cancel();
        } catch {
          if (!attempt) continue;
          throw new Error('Yandex network/timeout or invalid JSON response after 2 attempts');
        }
        if (!response.ok) {
          if (response.status >= 500 && !attempt) continue;
          const error = new Error(`Yandex HTTP ${response.status}`);
          // Stop this run on throttling/auth/config errors. Do not retry paid
          // queries blindly or ignore Retry-After by proceeding to another query.
          error.fatal = response.status < 500;
          throw error;
        }
        if (typeof payload?.rawData !== 'string' || !payload.rawData || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.rawData)) {
          throw new Error('Invalid Yandex rawData');
        }
        const results = parseResults(Buffer.from(payload.rawData, 'base64').toString('utf8'));
        try { cache?.set(body, results); } catch { /* Cache write failure must not discard paid results. */ }
        return results;
      }
    },
  };
}

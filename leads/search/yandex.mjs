// Клиент Яндекс Поиск API v2 (платный, ключ в .env). Восстановлено из
// seeding/providers/yandex.mjs коммита 7c089c1; добавлен OR-список площадок.
import { setTimeout as sleep } from 'node:timers/promises';
import { parseResults } from './xml.mjs';
import { createDailyBudget } from './budget.mjs';
import { createSearchCache } from './cache.mjs';

const ENDPOINT = 'https://searchapi.api.cloud.yandex.net/v2/web/search';

/** `date:` сужает выдачу до свежих документов — иначе в топе вечные SEO-статьи. */
export function buildRequest({ query, domains = [], freshnessDays = 7, language = 'ru', groupsOnPage = 10, now = new Date() }, folderId) {
  const compact = (d) => d.replaceAll('-', '');
  const from = new Date(now.getTime() - freshnessDays * 864e5).toISOString().slice(0, 10);
  const site = domains.length === 1 ? `site:${domains[0]}`
    : domains.length ? `(${domains.map((d) => `site:${d}`).join(' | ')})` : '';
  const queryText = [query, site, `lang:${language}`,
    `date:${compact(from)}..${compact(now.toISOString().slice(0, 10))}`].filter(Boolean).join(' ');
  if (queryText.length > 400) throw new Error('Запрос к Яндексу длиннее 400 символов');
  return {
    query: { searchType: 'SEARCH_TYPE_RU', queryText, page: '0', fixTypoMode: 'FIX_TYPO_MODE_OFF' },
    folderId, responseFormat: 'FORMAT_XML', l10n: 'LOCALIZATION_RU',
    groupSpec: { groupMode: 'GROUP_MODE_FLAT', groupsOnPage: String(groupsOnPage), docsInGroup: '1' },
    maxPassages: '4', sortSpec: { sortMode: 'SORT_MODE_BY_RELEVANCE', sortOrder: 'SORT_ORDER_DESC' },
  };
}

export function createYandexProvider({ env = process.env, fetchImpl = fetch, wait = sleep, timeoutMs = 20000,
  budget = createDailyBudget({ env }), cache = createSearchCache() } = {}) {
  const key = env.YANDEX_SEARCH_API_KEY?.trim();
  const folder = env.YANDEX_SEARCH_FOLDER_ID?.trim();
  if (!key || !folder) throw new Error('Нужны YANDEX_SEARCH_API_KEY и YANDEX_SEARCH_FOLDER_ID в .env');
  let apiRequests = 0;
  let cacheHits = 0;
  return {
    name: 'yandex',
    dailyLimit: budget.limit,
    budgetUsed: () => budget.used(),
    get apiRequests() { return apiRequests; },
    get cacheHits() { return cacheHits; },
    async search(options) {
      const body = JSON.stringify(buildRequest(options, folder));
      const cached = cache?.get(body);
      if (cached != null) { cacheHits++; return cached; }
      for (let attempt = 0; attempt < 2; attempt++) {
        // Не меньше секунды между HTTP-попытками, включая повторные.
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
          throw new Error('Яндекс: сеть/таймаут или битый JSON после 2 попыток');
        }
        if (!response.ok) {
          if (response.status >= 500 && !attempt) continue;
          const error = new Error(`Яндекс: HTTP ${response.status}`);
          // Троттлинг/авторизация/конфиг — прекращаем прогон, а не шлём платные
          // запросы дальше, игнорируя Retry-After.
          error.fatal = response.status < 500;
          throw error;
        }
        if (typeof payload?.rawData !== 'string' || !payload.rawData || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.rawData)) {
          throw new Error('Яндекс вернул некорректный rawData');
        }
        const results = parseResults(Buffer.from(payload.rawData, 'base64').toString('utf8'));
        try { cache?.set(body, results); } catch { /* Сбой записи кэша не должен терять оплаченный результат. */ }
        return results;
      }
    },
  };
}

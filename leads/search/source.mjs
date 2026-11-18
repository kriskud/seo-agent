// Источник «вопросы с намерением в поисковой выдаче»: точные фразы вроде
// «ищу разработчика бота» по форумам, Q&A и соцсетям. Такие тексты пишут сами
// заказчики, и за ними почти никто не следит — в отличие от бирж.
//
// Запросы ротируются: Яндекс Поиск API платный, дневной лимит мал
// (YANDEX_SEARCH_DAILY_LIMIT), поэтому за прогон уходит пара запросов, а
// остальные ждут своей очереди. Повторы снимает кэш.
import { createYandexProvider } from './yandex.mjs';

/** Переводчики, видео, витрины услуг и сами биржи — там заказчика нет. */
export const DEFAULT_DENY = [
  'tr-page.yandex.ru', 'translated.turbopages.org', 'turbopages.org',
  'yandex.ru/video', 'yandex.ru/images', 'uslugi.yandex.ru', 'market.yandex.ru',
  'kwork.ru', 'fl.ru', 'profi.ru', 'youdo.com', 'freelance.ru', 'weblancer.net',
  'youtube.com', 'ozon.ru', 'avito.ru/promo',
  // Зеркала и агрегаторы бирж: тот же демпинг, что на Kwork/FL.ru.
  'profreelance.net', 'profreelance.biz', 'freelancehunt.com', 'workzilla.com',
  // Форумы «социальной инженерии» и накруток — заказы не наш профиль.
  'lolz.team', 'lolz.guru', 'zelenka.guru', 'zenno.club',
];

/**
 * Пишут сами заказчики только на площадках с пользовательским контентом:
 * вопросы-ответы, стены и обсуждения VK, форумы. Сайты студий цитируют
 * «нужен бот для записи…» в своих кейсах, статьи — в заголовках, и фильтр
 * намерения такие тексты не отличит. Поэтому из выдачи берём только UGC.
 */
export const UGC = [
  /^otvet\.mail\.ru\/question\//,
  /^(vk\.com|vk\.ru|m\.vk\.com)\/(wall|topic)-?\d/,
  /^qna\.habr\.com\/q\//,
  /^pikabu\.ru\/story\/.*(ishchu|nuzhen|nuzhna|posovetuyte|podskazhite|kto_sdelaet|vopros)/,
  /^(www\.)?(forum|forums)\./,
  /\/(forum|forums|threads|topic|viewtopic|showthread|discussion)[/.?]/,
  /^vc\.ru\/(ask|questions?)\//,
];

export const isUgc = (url) => {
  const bare = url.replace(/^https?:\/\/(www\.)?/, '');
  return UGC.some((rx) => rx.test(bare));
};

const host = (url) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return ''; } };

export function parseSearchResults(results, { query, deny = DEFAULT_DENY } = {}) {
  return results
    .filter((r) => r.url && !deny.some((d) => r.url.includes(d)) && isUgc(r.url))
    .map((r) => ({
      id: `web:${r.url}`,
      source: `Поиск: ${host(r.url)}`,
      url: r.url,
      title: (r.title ?? '').slice(0, 200),
      text: (r.snippet ?? '').slice(0, 1200),
      // Заголовок Q&A — сам вопрос, у стены VK — начало поста; сниппет
      // смешивает его с ответами других людей.
      intentText: (r.title ?? '').replace(/ [-—|] (Ответы Mail|Хабр Q&A).*$/, ''),
      budget: null,
      // Дату документа Яндекс не отдаёт (modtime — не дата публикации),
      // свежесть обеспечивает оператор date: в самом запросе.
      createdAt: null,
      kind: 'post',
      context: `запрос: ${query}`,
    }));
}

// searchFreshnessDays — окно оператора date: в самом запросе; с freshnessDays
// из конфига его не путаем, тот фильтрует лиды по дате публикации.
export async function websearch({ queries, domains = [], searchFreshnessDays = 30, perRun = 2,
  groupsOnPage = 10, deny = DEFAULT_DENY }, ctx = {}) {
  const { state, warn = console.warn, provider = createYandexProvider() } = ctx;
  const indexes = state ? state.nextIndexes('websearch-queries', queries.length, perRun)
    : queries.map((_, i) => i).slice(0, perRun);
  const out = [];
  for (const i of indexes) {
    const query = queries[i];
    try {
      const results = await provider.search({ query, domains, freshnessDays: searchFreshnessDays, groupsOnPage });
      out.push(...parseSearchResults(results ?? [], { query, deny }));
    } catch (e) {
      warn(`[leads] поиск «${query}»: ${e.message}`);
      if (e.fatal) break; // Лимит, авторизация, троттлинг — дальше не платим.
    }
  }
  return out;
}

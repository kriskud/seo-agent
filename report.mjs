// Недельный markdown-отчёт по каждому сайту: аудит + GSC + Вебмастер,
// дельты к прошлому снимку, SEO-возможности. reports/<site>-<date>.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadSites, loadLastTwo, today } from './lib.mjs';

// Ожидаемый CTR по позиции — для поиска страниц с недобором кликов.
const expectedCtr = (pos) =>
  pos <= 1 ? 0.28 : pos <= 2 ? 0.15 : pos <= 3 ? 0.1 : pos <= 5 ? 0.06 : pos <= 7 ? 0.04 : pos <= 10 ? 0.03 : 0.015;

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('ru-RU') : '—');
const delta = (cur, prev) => {
  if (prev == null || cur == null) return '';
  const d = cur - prev;
  return d === 0 ? ' (=)' : ` (${d > 0 ? '+' : ''}${Math.round(d * 100) / 100})`;
};

// Человеческие названия проблем из диагностики Вебмастера; незнакомый код
// выводится как есть.
const ywmProblemNames = {
  DISALLOWED_IN_ROBOTS: 'Сайт закрыт для индексирования в robots.txt',
  DNS_ERROR: 'Ошибка DNS',
  MAIN_PAGE_ERROR: 'Главная страница недоступна',
  THREATS: 'Обнаружены угрозы безопасности',
  SSL_CERTIFICATE_ERROR: 'Ошибка SSL-сертификата',
  SLOW_AVG_RESPONSE_TIME: 'Медленный ответ сервера',
  DOCUMENTS_MISSING_DESCRIPTION: 'На страницах нет meta description',
  DOCUMENTS_MISSING_TITLE: 'На страницах нет title',
  ERRORS_IN_SITEMAPS: 'Ошибки в файлах Sitemap',
  MAIN_PAGE_REDIRECTS: 'Главная страница перенаправляет на другой сайт',
  NO_METRIKA_COUNTER_CRAWL_ENABLED: 'Не включён обход по счётчику Метрики',
  SOFT_404: 'Отсутствующие страницы отдают некорректный HTTP-код (soft 404)',
  FAVICON_PROBLEM: 'Проблема с фавиконом',
  NO_METRIKA_COUNTER: 'Не установлен счётчик Яндекс.Метрики',
  NO_REGIONS: 'Не задан регион сайта',
  NO_SITEMAPS: 'Не задан файл Sitemap',
  NOT_MOBILE_FRIENDLY: 'Сайт не оптимизирован для мобильных',
  NOT_IN_SPRAV: 'Компания не добавлена в Яндекс Бизнес (Справочник)',
};
const ywmSevIcon = { FATAL: '🛑', CRITICAL: '❌', POSSIBLE_PROBLEM: '⚠️', RECOMMENDATION: '💡' };
const ywmIndicatorNames = {
  HTTP_2XX: 'Загружено с ответом 2xx',
  HTTP_3XX: 'Редиректы 3xx',
  HTTP_4XX: 'Ошибки 4xx',
  HTTP_5XX: 'Ошибки 5xx',
  OTHER: 'Прочие ответы',
  FAILED_TO_DOWNLOAD: 'Не удалось загрузить',
};

for (const site of loadSites()) {
  const [audit, prevAudit] = loadLastTwo('audit', site.name);
  const [gsc, prevGsc] = loadLastTwo('gsc', site.name);
  const [ywm, prevYwm] = loadLastTwo('ywm', site.name);
  const lines = [`# SEO-отчёт: ${site.name} (${site.url})`, '', `Дата: ${today()}`, ''];
  const rel = (u) => (u ?? '').replace(site.url, '') || '/';

  if (audit) {
    lines.push('## Технический аудит', '');
    lines.push(
      `Страниц проверено: ${audit.pagesChecked}, ошибок: ${audit.errors}${delta(audit.errors, prevAudit?.errors)}, предупреждений: ${audit.warnings}${delta(audit.warnings, prevAudit?.warnings)}`,
      ''
    );
    const important = audit.issues.filter((i) => i.severity !== 'info');
    for (const issue of important.slice(0, 40)) {
      lines.push(`- ${issue.severity === 'error' ? '❌' : '⚠️'} \`${issue.type}\` ${issue.page} — ${issue.detail}`);
    }
    if (important.length > 40) lines.push(`- … и ещё ${important.length - 40}`);
    if (important.length === 0) lines.push('Ошибок и предупреждений нет.');
    lines.push('');
  }

  if (gsc) {
    lines.push('## Google Search Console (28 дней)', '');
    lines.push(
      `Клики: ${fmt(gsc.totals.clicks)}${delta(gsc.totals.clicks, prevGsc?.totals?.clicks)}, показы: ${fmt(gsc.totals.impressions)}${delta(gsc.totals.impressions, prevGsc?.totals?.impressions)}`,
      ''
    );
    const opps = gsc.rows
      .filter((r) => r.position >= 4 && r.position <= 20 && r.impressions >= 20)
      .map((r) => ({ ...r, gap: (expectedCtr(r.position) - r.ctr) * r.impressions }))
      .sort((a, b) => b.gap - a.gap)
      .slice(0, 10);
    if (opps.length) {
      lines.push('### Возможности (позиция 4–20, есть показы)', '');
      lines.push('| Запрос | Страница | Позиция | Показы | CTR |', '|---|---|---|---|---|');
      for (const o of opps) {
        lines.push(`| ${o.query} | ${rel(o.page)} | ${o.position.toFixed(1)} | ${fmt(o.impressions)} | ${(o.ctr * 100).toFixed(1)}% |`);
      }
      lines.push('');
    } else {
      lines.push('Возможностей с заметными показами пока нет (мало данных).', '');
    }
  } else if (site.gsc) {
    lines.push('## Google Search Console', '', '_Нет данных — коллектор не настроен или не отработал._', '');
  }

  if (ywm) {
    lines.push('## Яндекс.Вебмастер', '');
    const s = ywm.summary ?? {};
    lines.push(
      `ИКС: ${fmt(s.sqi)}${delta(s.sqi, prevYwm?.summary?.sqi)}, страниц в поиске: ${fmt(s.searchable_pages_count)}${delta(s.searchable_pages_count, prevYwm?.summary?.searchable_pages_count)}, исключено: ${fmt(s.excluded_pages_count)}${delta(s.excluded_pages_count, prevYwm?.summary?.excluded_pages_count)}`,
      ''
    );

    if (ywm.problems?.length) {
      lines.push('### Проблемы и рекомендации', '');
      const order = ['FATAL', 'CRITICAL', 'POSSIBLE_PROBLEM', 'RECOMMENDATION'];
      const sorted = [...ywm.problems].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
      for (const p of sorted) {
        lines.push(`- ${ywmSevIcon[p.severity] ?? '•'} ${ywmProblemNames[p.code] ?? p.code}${p.since ? ` (с ${p.since.slice(0, 10)})` : ''}`);
      }
      lines.push('');
    } else if (s.site_problems && Object.keys(s.site_problems).length) {
      lines.push(`Проблемы сайта: ${JSON.stringify(s.site_problems)}`, '');
    }

    const crawled = Object.entries(ywm.indexing ?? {}).filter(([, v]) => v.total > 0);
    if (crawled.length) {
      lines.push('### Обход роботом (14 дней)', '', '| Ответ сервера | Страниц | Последний обход |', '|---|---|---|');
      for (const [key, v] of crawled) {
        lines.push(`| ${ywmIndicatorNames[key] ?? key} | ${fmt(v.total)} | ${v.lastDate ?? '—'} |`);
      }
      lines.push('');
    }

    if (ywm.inSearch?.length) {
      lines.push(`### Страницы в поиске (${ywm.inSearch.length})`, '');
      for (const p of ywm.inSearch.slice(0, 15)) {
        lines.push(`- ${rel(p.url)}${p.lastAccess ? ` (обход: ${p.lastAccess})` : ''}`);
      }
      if (ywm.inSearch.length > 15) lines.push(`- … и ещё ${ywm.inSearch.length - 15}`);
      lines.push('');
    }

    if (ywm.crawlSamples?.length) {
      const recent = [...ywm.crawlSamples].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 10);
      lines.push('### Последние обойденные страницы', '', '| Дата | Код | Страница |', '|---|---|---|');
      for (const c of recent) {
        lines.push(`| ${c.date ?? '—'} | ${c.code ?? '—'} | ${rel(c.url)} |`);
      }
      lines.push('');
    }

    for (const [k, label] of [['problemsError', 'диагностика'], ['indexingError', 'история обхода'], ['crawlSamplesError', 'примеры обхода'], ['inSearchError', 'страницы в поиске']]) {
      if (ywm[k]) lines.push(`_Не удалось получить: ${label} (${ywm[k]})_`, '');
    }

    if (ywm.queries?.length) {
      lines.push('### Популярные запросы (Яндекс)', '', '| Запрос | Показы | Клики | Ср. позиция |', '|---|---|---|---|');
      for (const q of ywm.queries.slice(0, 15)) {
        lines.push(`| ${q.query} | ${fmt(q.shows)} | ${fmt(q.clicks)} | ${q.position ?? '—'} |`);
      }
      lines.push('');
    }
  } else if (site.yandex) {
    lines.push('## Яндекс.Вебмастер', '', '_Нет данных — коллектор не настроен или не отработал._', '');
  }

  const dir = join(ROOT, 'reports');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${site.name}-${today()}.md`);
  const text = lines.join('\n') + '\n';
  writeFileSync(file, text);
  writeFileSync(join(dir, `${site.name}-latest.md`), text);
  console.log(`[report] ${site.name} → ${file}`);
}

// Технический аудит собственных сайтов: robots, sitemap, постраничные
// проверки, битые внутренние ссылки. Результат — data/audit/<site>-<date>.json.
import { loadSites, get, pool, parsePage, fetchSitemapUrls, saveData } from './lib.mjs';

const MAX_PAGES = 300;

function checkPage(page, siteUrl) {
  const issues = [];
  const add = (severity, type, detail) => issues.push({ severity, type, page: page.url, detail });

  if (page.status !== 200) {
    add('error', 'http-status', `HTTP ${page.status}${page.location ? ' → ' + page.location : ''}`);
    return issues;
  }
  if (!page.title) add('error', 'missing-title', 'нет <title>');
  else if (page.title.length > 70) add('warn', 'long-title', `${page.title.length} символов`);
  else if (page.title.length < 15) add('warn', 'short-title', `${page.title.length} символов`);
  if (!page.metaDesc) add('error', 'missing-description', 'нет meta description');
  else if (page.metaDesc.length > 180) add('warn', 'long-description', `${page.metaDesc.length} символов`);
  else if (page.metaDesc.length < 50) add('warn', 'short-description', `${page.metaDesc.length} символов`);
  if (page.h1s.length === 0) add('error', 'missing-h1', 'нет <h1>');
  if (page.h1s.length > 1) add('warn', 'multiple-h1', `${page.h1s.length} шт.`);
  if (page.robotsMeta && /noindex/i.test(page.robotsMeta)) add('error', 'noindex', page.robotsMeta);
  if (!page.canonical) add('warn', 'missing-canonical', 'нет rel=canonical');
  else {
    const canon = page.canonical.replace(/\/$/, '');
    const self = page.url.replace(/\/$/, '');
    if (canon !== self) add('warn', 'canonical-mismatch', `${page.canonical} ≠ ${page.url}`);
  }
  if (page.imgsNoAlt > 0) add('info', 'imgs-no-alt', `${page.imgsNoAlt} из ${page.imgCount} img без alt`);
  if (page.ms > 3000) add('warn', 'slow-response', `${page.ms} мс`);
  return issues;
}

for (const site of loadSites()) {
  const t0 = Date.now();
  const issues = [];
  const origin = new URL(site.url).origin;

  const robots = await get(`${origin}/robots.txt`);
  if (robots.status !== 200) issues.push({ severity: 'error', type: 'robots-missing', page: '/robots.txt', detail: `HTTP ${robots.status}` });
  else if (!/sitemap:/i.test(robots.body)) issues.push({ severity: 'warn', type: 'robots-no-sitemap', page: '/robots.txt', detail: 'нет строки Sitemap:' });

  const sitemapUrl = /sitemap:\s*(\S+)/i.exec(robots.body)?.[1] ?? `${origin}/sitemap.xml`;
  let urls = await fetchSitemapUrls(sitemapUrl);
  if (urls.length === 0) issues.push({ severity: 'error', type: 'sitemap-empty', page: sitemapUrl, detail: 'sitemap пуст или недоступен' });
  if (urls.length > MAX_PAGES) {
    issues.push({ severity: 'info', type: 'audit-truncated', page: sitemapUrl, detail: `проверены первые ${MAX_PAGES} из ${urls.length} URL` });
    urls = urls.slice(0, MAX_PAGES);
  }

  const pages = await pool(urls, 4, async (url) => {
    const res = await get(url);
    const parsed = res.status === 200 ? parsePage(res.body, url) : {};
    return { url, status: res.status, ms: res.ms, bytes: res.body.length, location: res.location, ...parsed };
  });

  for (const page of pages) issues.push(...checkPage(page, site.url));

  // Внутренние ссылки: битые и страницы-сироты.
  const inSitemap = new Set(urls.map((u) => u.replace(/\/$/, '')));
  const linked = new Set();
  const outsideSitemap = new Set();
  for (const page of pages) {
    for (const link of page.internalLinks ?? []) {
      // Артефакт Cloudflare email-обфускации, не настоящая ссылка.
      if (link.includes('/cdn-cgi/')) continue;
      linked.add(link.replace(/\/$/, ''));
      if (!inSitemap.has(link.replace(/\/$/, ''))) outsideSitemap.add(link);
    }
  }
  const linkChecks = await pool([...outsideSitemap].slice(0, 150), 4, async (url) => ({ url, status: (await get(url, { method: 'HEAD' })).status }));
  for (const { url, status } of linkChecks) {
    // 405 — сервер не любит HEAD; редиректы не считаем битыми.
    if (status === 404 || status === 410 || status === 0 || status >= 500) {
      issues.push({ severity: 'error', type: 'broken-internal-link', page: url, detail: `HTTP ${status}` });
    }
  }
  for (const url of urls) {
    const norm = url.replace(/\/$/, '');
    if (!linked.has(norm) && norm !== origin) {
      issues.push({ severity: 'warn', type: 'orphan-page', page: url, detail: 'нет внутренних ссылок на страницу' });
    }
  }

  const dupTitles = {};
  for (const p of pages) if (p.title) (dupTitles[p.title] ??= []).push(p.url);
  for (const [title, list] of Object.entries(dupTitles)) {
    if (list.length > 1) issues.push({ severity: 'warn', type: 'duplicate-title', page: list.join(', '), detail: title });
  }

  const summary = {
    site: site.name,
    url: site.url,
    pagesChecked: pages.length,
    errors: issues.filter((i) => i.severity === 'error').length,
    warnings: issues.filter((i) => i.severity === 'warn').length,
    tookMs: Date.now() - t0,
  };
  const file = saveData('audit', site.name, {
    ...summary,
    issues,
    pages: pages.map(({ url, status, ms, bytes, title }) => ({ url, status, ms, bytes, title })),
  });
  console.log(`[audit] ${site.name}: ${pages.length} страниц, ${summary.errors} ошибок, ${summary.warnings} предупреждений → ${file}`);
}

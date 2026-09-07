// IndexNow: мгновенное уведомление Яндекса/Bing об изменившихся URL.
// Требует INDEXNOW_KEY в .env и файл <key>.txt в корне сайта.
// Запуск: node indexnow.mjs [site] [url1 url2 …]  — без URL шлёт весь sitemap.
import { loadSites, loadEnv, get, fetchSitemapUrls } from './lib.mjs';

loadEnv();
const key = process.env.INDEXNOW_KEY;
if (!key) {
  console.log('[indexnow] INDEXNOW_KEY не задан — пропускаю');
  process.exit(0);
}

const [siteFilter, ...urlArgs] = process.argv.slice(2);

for (const site of loadSites()) {
  if (siteFilter && site.name !== siteFilter) continue;
  if (!site.indexnow) continue;
  const origin = new URL(site.url).origin;

  const keyCheck = await get(`${origin}/${key}.txt`);
  if (keyCheck.status !== 200 || keyCheck.body.trim() !== key) {
    console.error(`[indexnow] ${site.name}: ${origin}/${key}.txt не отдаёт ключ (HTTP ${keyCheck.status}) — пропускаю`);
    continue;
  }

  const urlList = urlArgs.length > 0 ? urlArgs : await fetchSitemapUrls(`${origin}/sitemap.xml`);
  if (urlList.length === 0) {
    console.log(`[indexnow] ${site.name}: нечего отправлять`);
    continue;
  }

  const res = await fetch('https://yandex.com/indexnow', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host: new URL(origin).hostname,
      key,
      keyLocation: `${origin}/${key}.txt`,
      urlList: urlList.slice(0, 10000),
    }),
  });
  console.log(`[indexnow] ${site.name}: отправлено ${urlList.length} URL → HTTP ${res.status}`);
}

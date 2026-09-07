// Сбор данных Google Search Console. Два режима авторизации (в .env):
//   1) GSC_SERVICE_ACCOUNT=/path/key.json — сервис-аккаунт, добавленный
//      в свойство GSC как пользователь (проще всего для автоматики);
//   2) GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN —
//      OAuth от своего приложения (как сделано для Яндекса).
// Свойство сайта берётся из sites.json (поле gsc, напр. "sc-domain:cosmodesk.ru").
// Результат — data/gsc/<site>-<date>.json.
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { loadSites, loadEnv, saveData } from './lib.mjs';

loadEnv();

const b64url = (s) => Buffer.from(s).toString('base64url');

async function getAccessToken() {
  const saPath = process.env.GSC_SERVICE_ACCOUNT;
  if (saPath) {
    const sa = JSON.parse(readFileSync(saPath, 'utf8'));
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(
      JSON.stringify({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/webmasters.readonly',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      })
    );
    const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(sa.private_key, 'base64url');
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claims}.${signature}`,
      }),
    });
    if (!res.ok) throw new Error(`GSC service-account auth: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()).access_token;
  }

  const { GOOGLE_CLIENT_ID: id, GOOGLE_CLIENT_SECRET: secret, GOOGLE_REFRESH_TOKEN: refresh } = process.env;
  if (id && secret && refresh) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: id, client_secret: secret }),
    });
    if (!res.ok) throw new Error(`GSC oauth refresh: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()).access_token;
  }
  return null;
}

const token = await getAccessToken();
if (!token) {
  console.log('[gsc] не настроено (нужен GSC_SERVICE_ACCOUNT или GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN) — пропускаю');
  process.exit(0);
}

async function query(siteProperty, body) {
  const res = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteProperty)}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    }
  );
  if (!res.ok) throw new Error(`GSC ${siteProperty}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

// GSC отдаёт данные с лагом ~2 дня; берём 28 дней.
const end = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
const start = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);

for (const site of loadSites()) {
  if (!site.gsc) continue;
  try {
    const byQuery = await query(site.gsc, {
      startDate: start,
      endDate: end,
      dimensions: ['query', 'page'],
      rowLimit: 2000,
    });
    const byDate = await query(site.gsc, { startDate: start, endDate: end, dimensions: ['date'] });
    const rows = (byQuery.rows ?? []).map((r) => ({
      query: r.keys[0],
      page: r.keys[1],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: r.position,
    }));
    const daily = (byDate.rows ?? []).map((r) => ({
      date: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: r.position,
    }));
    const totals = daily.reduce(
      (a, d) => ({ clicks: a.clicks + d.clicks, impressions: a.impressions + d.impressions }),
      { clicks: 0, impressions: 0 }
    );
    const file = saveData('gsc', site.name, { property: site.gsc, start, end, totals, daily, rows });
    console.log(`[gsc] ${site.name}: ${totals.clicks} кликов, ${totals.impressions} показов, ${rows.length} строк query+page → ${file}`);
  } catch (e) {
    console.error(`[gsc] ${site.name}: ${e.message}`);
  }
}

// Сбор данных Яндекс.Вебмастера (API v4) для сайтов с yandex:true.
// Требует в .env: YANDEX_WEBMASTER_ACCESS_TOKEN (+ CLIENT_ID/SECRET/REFRESH_TOKEN
// для автообновления). Результат — data/ywm/<site>-<date>.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadSites, loadEnv, saveData } from './lib.mjs';

loadEnv();
const API = 'https://api.webmaster.yandex.net/v4';

let token = process.env.YANDEX_WEBMASTER_ACCESS_TOKEN;
if (!token) {
  console.log('[ywm] YANDEX_WEBMASTER_ACCESS_TOKEN не задан — пропускаю');
  process.exit(0);
}

async function api(path, retry = true) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `OAuth ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 401 && retry && (await refreshToken())) return api(path, false);
  if (!res.ok) throw new Error(`YWM ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function refreshToken() {
  const { YANDEX_WEBMASTER_CLIENT_ID: id, YANDEX_WEBMASTER_CLIENT_SECRET: secret, YANDEX_WEBMASTER_REFRESH_TOKEN: refresh } = process.env;
  if (!id || !secret || !refresh) return false;
  const res = await fetch('https://oauth.yandex.ru/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: id, client_secret: secret }),
  });
  if (!res.ok) return false;
  const data = await res.json();
  token = data.access_token;
  // Персистим новые токены в .env агента.
  const envFile = join(ROOT, '.env');
  let env = readFileSync(envFile, 'utf8');
  env = env.replace(/^YANDEX_WEBMASTER_ACCESS_TOKEN=.*$/m, `YANDEX_WEBMASTER_ACCESS_TOKEN=${data.access_token}`);
  if (data.refresh_token) env = env.replace(/^YANDEX_WEBMASTER_REFRESH_TOKEN=.*$/m, `YANDEX_WEBMASTER_REFRESH_TOKEN=${data.refresh_token}`);
  writeFileSync(envFile, env, { mode: 0o600 });
  console.log('[ywm] access token обновлён по refresh token');
  return true;
}

const { user_id } = await api('/user');
const { hosts } = await api(`/user/${user_id}/hosts`);

for (const site of loadSites()) {
  if (!site.yandex) continue;
  const target = new URL(site.url).hostname;
  const host = hosts.find((h) => {
    try {
      return new URL(h.ascii_host_url).hostname.replace(/^www\./, '') === target.replace(/^www\./, '');
    } catch { return false; }
  });
  if (!host) {
    console.log(`[ywm] ${site.name}: хост ${target} не найден в Вебмастере (есть: ${hosts.map((h) => h.ascii_host_url).join(', ') || 'ничего'})`);
    continue;
  }
  if (!host.verified) {
    console.log(`[ywm] ${site.name}: хост ${host.ascii_host_url} не верифицирован`);
    continue;
  }

  const out = { host_id: host.host_id, host_url: host.ascii_host_url };
  const base = `/user/${user_id}/hosts/${host.host_id}`;

  out.summary = await api(`${base}/summary`);

  try {
    const q = await api(
      `${base}/search-queries/popular/?order_by=TOTAL_SHOWS&query_indicator=TOTAL_SHOWS&query_indicator=TOTAL_CLICKS&query_indicator=AVG_SHOW_POSITION`
    );
    out.queries = (q.queries ?? []).map((it) => ({
      query: it.query_text,
      shows: it.indicators?.TOTAL_SHOWS ?? 0,
      clicks: it.indicators?.TOTAL_CLICKS ?? 0,
      position: it.indicators?.AVG_SHOW_POSITION ?? null,
    }));
  } catch (e) {
    out.queriesError = e.message;
  }

  // Диагностика: коды проблем/рекомендаций (summary отдаёт только счётчики по severity).
  try {
    const d = await api(`${base}/diagnostics/`);
    out.problems = Object.entries(d.problems ?? {})
      .filter(([, p]) => p.state !== 'ABSENT')
      .map(([code, p]) => ({ code, severity: p.severity, since: p.last_state_update ?? null }));
  } catch (e) {
    out.problemsError = e.message;
  }

  // История обхода за 14 дней: API группирует по коду ответа (HTTP_2XX и т.п.),
  // значение — сколько страниц робот загрузил за день; суммируем за период.
  try {
    const iso = (d) => d.toISOString().slice(0, 10);
    const from = new Date(Date.now() - 14 * 864e5);
    const h = await api(`${base}/indexing/history/?date_from=${iso(from)}&date_to=${iso(new Date())}`);
    out.indexing = Object.fromEntries(
      Object.entries(h.indicators ?? {}).map(([k, points]) => {
        const p = [...points].sort((a, b) => String(a.date).localeCompare(String(b.date)));
        return [k, {
          total: p.reduce((sum, x) => sum + (x.value ?? 0), 0),
          lastDate: p.findLast((x) => x.value > 0)?.date?.slice(0, 10) ?? null,
        }];
      })
    );
  } catch (e) {
    out.indexingError = e.message;
  }

  // Примеры страниц из базы робота (последние обойденные) и страниц в поиске.
  try {
    const s = await api(`${base}/indexing/samples/?offset=0&limit=50`);
    out.crawlSamples = (s.samples ?? []).map((x) => ({
      url: x.url,
      code: x.http_code ?? x.status ?? null,
      date: (x.access_date ?? '').slice(0, 10) || null,
    }));
  } catch (e) {
    out.crawlSamplesError = e.message;
  }

  try {
    const s = await api(`${base}/search-urls/in-search/samples/?offset=0&limit=50`);
    out.inSearch = (s.samples ?? []).map((x) => ({
      url: x.url,
      title: x.title ?? null,
      lastAccess: (x.last_access ?? '').slice(0, 10) || null,
    }));
  } catch (e) {
    out.inSearchError = e.message;
  }

  const file = saveData('ywm', site.name, out);
  console.log(
    `[ywm] ${site.name}: ИКС=${out.summary?.sqi ?? '?'}, в поиске=${out.summary?.searchable_pages_count ?? '?'}, исключено=${out.summary?.excluded_pages_count ?? '?'}, запросов=${out.queries?.length ?? 0}, проблем=${out.problems?.length ?? '?'} → ${file}`
  );
}

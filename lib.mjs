// Общие помощники: fetch с таймаутом, разбор HTML регэкспами (сайты свои и
// маленькие — полноценный парсер не нужен), файловое хранилище data/.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const UA = 'seo-agent/1.0 (internal; +https://github.com/kriskud)';

export function loadSites() {
  return JSON.parse(readFileSync(join(ROOT, 'sites.json'), 'utf8')).sites;
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export async function get(url, { timeout = 15000, method = 'GET' } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method,
      redirect: 'manual',
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(timeout),
    });
    const body = method === 'GET' ? await res.text() : '';
    return { status: res.status, ms: Date.now() - t0, body, headers: res.headers, location: res.headers.get('location') };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, body: '', error: e.message };
  }
}

// Простенький пул: не больше n одновременных задач.
export async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

const rx = {
  title: /<title[^>]*>([\s\S]*?)<\/title>/i,
  metaDesc: /<meta[^>]+name=["']description["'][^>]*>/i,
  canonical: /<link[^>]+rel=["']canonical["'][^>]*>/i,
  robotsMeta: /<meta[^>]+name=["']robots["'][^>]*>/i,
  content: /content=["']([^"']*)["']/i,
  href: /href=["']([^"']*)["']/i,
  h1: /<h1[^>]*>([\s\S]*?)<\/h1>/gi,
  img: /<img\b[^>]*>/gi,
  alt: /\balt=["']([^"']*)["']/i,
  a: /<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>/gi,
  hreflang: /<link[^>]+rel=["']alternate["'][^>]+hreflang=/gi,
};

export function stripTags(s) {
  return s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

export function parsePage(html, pageUrl) {
  const origin = new URL(pageUrl).origin;
  const title = rx.title.exec(html)?.[1];
  const descTag = rx.metaDesc.exec(html)?.[0];
  const canonTag = rx.canonical.exec(html)?.[0];
  const robotsTag = rx.robotsMeta.exec(html)?.[0];
  const h1s = [...html.matchAll(rx.h1)].map((m) => stripTags(m[1]));
  const imgs = [...html.matchAll(rx.img)];
  const imgsNoAlt = imgs.filter((m) => !rx.alt.exec(m[0])?.[1]).length;
  const links = new Set();
  for (const m of html.matchAll(rx.a)) {
    try {
      const u = new URL(m[1], pageUrl);
      if (u.origin === origin) links.add(u.origin + u.pathname);
    } catch { /* мусорный href */ }
  }
  return {
    title: title ? stripTags(title) : null,
    metaDesc: descTag ? (rx.content.exec(descTag)?.[1] ?? null) : null,
    canonical: canonTag ? (rx.href.exec(canonTag)?.[1] ?? null) : null,
    robotsMeta: robotsTag ? (rx.content.exec(robotsTag)?.[1] ?? null) : null,
    h1s,
    imgCount: imgs.length,
    imgsNoAlt,
    hreflangCount: [...html.matchAll(rx.hreflang)].length,
    internalLinks: [...links],
  };
}

export async function fetchSitemapUrls(sitemapUrl, seen = new Set(), depth = 0) {
  if (depth > 2 || seen.has(sitemapUrl)) return [];
  seen.add(sitemapUrl);
  const res = await get(sitemapUrl);
  if (res.status !== 200) return [];
  const locs = [...res.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
  if (/<sitemapindex/i.test(res.body)) {
    const nested = await pool(locs, 3, (u) => fetchSitemapUrls(u, seen, depth + 1));
    return nested.flat();
  }
  return locs;
}

export function saveData(kind, site, obj) {
  const dir = join(ROOT, 'data', kind);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${site}-${today()}.json`);
  writeFileSync(file, JSON.stringify(obj, null, 1));
  return file;
}

// Последний и предпоследний снимки данного вида для сайта.
export function loadLastTwo(kind, site) {
  const dir = join(ROOT, 'data', kind);
  if (!existsSync(dir)) return [null, null];
  const files = readdirSync(dir).filter((f) => f.startsWith(site + '-') && f.endsWith('.json')).sort();
  const read = (f) => (f ? JSON.parse(readFileSync(join(dir, f), 'utf8')) : null);
  return [read(files.at(-1)), read(files.at(-2))];
}

export function loadEnv() {
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

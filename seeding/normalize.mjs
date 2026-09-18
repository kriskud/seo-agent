import { createHash } from 'node:crypto';

const platforms = { 'vk.com': 'vk', 'dzen.ru': 'dzen', 'otzovik.com': 'otzovik',
  'irecommend.ru': 'irecommend', 'youtube.com': 'youtube', 'youtu.be': 'youtube', 't.me': 'telegram' };
export function detectPlatform(url) {
  const host = new URL(url).hostname;
  return Object.entries(platforms).find(([domain]) => host === domain || host.endsWith('.' + domain))?.[1] ?? 'web';
}

export function canonicalizeUrl(value) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('Invalid result URL');
  // Only known equivalent host aliases. Preserve scheme/path/trailing slash and
  // unknown fragments (some sites use hash routing or comment identities).
  const aliases = { 'm.vk.com': 'vk.com', 'www.vk.com': 'vk.com',
    'www.youtube.com': 'youtube.com', 'm.youtube.com': 'youtube.com',
    'www.dzen.ru': 'dzen.ru', 'www.otzovik.com': 'otzovik.com', 'www.irecommend.ru': 'irecommend.ru' };
  u.hostname = aliases[u.hostname] ?? u.hostname;
  for (const key of [...u.searchParams.keys()]) {
    if (/^(utm_.+|yclid|gclid|dclid|fbclid|msclkid|_openstat|ysclid|mc_cid|mc_eid)$/i.test(key)) u.searchParams.delete(key);
  }
  // Stable sort keeps the order of repeated values; id, p, v, w, reply, etc. survive.
  u.searchParams.sort();
  return u.href;
}

export function normalizeResult(result, { project, source, query, discoveredAt }) {
  const canonicalUrl = canonicalizeUrl(result.url);
  return {
    id: createHash('sha256').update(project + '\n' + canonicalUrl).digest('hex'),
    project, source, sources: [source], platform: detectPlatform(canonicalUrl), url: result.url, canonicalUrl,
    title: result.title ?? '', snippet: result.snippet ?? '', query, matchedQueries: [query],
    domain: new URL(canonicalUrl).hostname,
    publishedAt: result.publishedAt ?? null,
    providerModifiedAt: result.providerModifiedAt ?? null,
    discoveredAt, lastSeenAt: discoveredAt, status: 'discovered',
  };
}

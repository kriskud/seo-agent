import { setTimeout as sleep } from 'node:timers/promises';

export function validateVkConfig(config) {
  if (typeof config.enabled !== 'boolean' || !Array.isArray(config.communityIds)
    || !config.communityIds.every(id => Number.isSafeInteger(id) && id > 0)
    || new Set(config.communityIds).size !== config.communityIds.length
    || !Number.isInteger(config.maxQueries) || config.maxQueries < 1 || config.maxQueries > 50
    || !Number.isInteger(config.resultsPerQuery) || config.resultsPerQuery < 1 || config.resultsPerQuery > 100) {
    throw new Error('Invalid VK config: use positive numeric communityIds and bounded query/result counts');
  }
}

export function planVkSearches(config, queries, rotation = 0) {
  validateVkConfig(config);
  if (!config.enabled || !config.communityIds.length) return [];
  if (!Number.isSafeInteger(rotation) || rotation < 0) throw new Error('Invalid VK rotation');
  const total = queries.length * config.communityIds.length;
  return Array.from({ length: Math.min(config.maxQueries, total) }, (_, i) => {
    const index = (rotation * config.maxQueries + i) % total;
    return { query: queries[index % queries.length], communityId: config.communityIds[Math.floor(index / queries.length)] };
  });
}

export function normalizeVkPosts(items, { communityId, freshnessDays, minResultDate, now }) {
  const lower = Math.max(now.getTime() - freshnessDays * 864e5, minResultDate ? Date.parse(minResultDate) : 0);
  const rows = [];
  for (const post of items) {
    // No profiles, attachments, repost payloads or personal-wall posts retained.
    if (!post || post.owner_id !== -communityId || !Number.isSafeInteger(post.id) || post.id < 1
      || !Number.isSafeInteger(post.date) || post.date * 1000 < lower || post.date * 1000 > now.getTime()
      || typeof post.text !== 'string' || !post.text.trim() || post.is_deleted || post.marked_as_ads) continue;
    const text = post.text.trim();
    rows.push({ url: `https://vk.com/wall${post.owner_id}_${post.id}`, title: text.slice(0, 100),
      snippet: text, publishedAt: new Date(post.date * 1000).toISOString() });
  }
  return rows;
}

export function createVkProvider({ config, env = process.env, fetchImpl = fetch, wait = sleep, timeoutMs = 20000 } = {}) {
  validateVkConfig(config);
  if (!config.enabled || !config.communityIds.length) throw new Error('VK disabled or community allowlist empty');
  const token = env.VK_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('VK_ACCESS_TOKEN is required');
  let apiRequests = 0;
  return {
    name: 'vk',
    get apiRequests() { return apiRequests; },
    async search({ query, communityId, freshnessDays = 7, minResultDate = null, now = new Date() }) {
      if (!config.communityIds.includes(communityId)) throw Object.assign(new Error('VK community is not allowlisted'), { fatal: true });
      if (typeof query !== 'string' || !query.trim() || query.length > 9000) throw new Error('Invalid VK query');
      // Hard cap includes failed HTTP calls; one page, no retry/pagination.
      if (apiRequests >= config.maxQueries) throw Object.assign(new Error('VK per-run query cap reached'), { fatal: true });
      if (apiRequests) await wait(1100);
      const body = new URLSearchParams({ access_token: token, v: '5.199', domain: `club${communityId}`,
        query, count: String(config.resultsPerQuery), offset: '0', extended: '0', owners_only: '0' });
      let response, payload;
      apiRequests++;
      try {
        response = await fetchImpl('https://api.vk.com/method/wall.search', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
        });
        if (response.ok) payload = await response.json();
        else await response.body?.cancel();
      } catch { throw Object.assign(new Error('VK network/timeout or invalid JSON; no retry'), { fatal: true }); }
      if (!response.ok) throw Object.assign(new Error(`VK HTTP ${response.status}`), { fatal: true });
      if (payload?.error) {
        // VK errors may echo access_token in request_params: never log body/message.
        const code = Number.isSafeInteger(payload.error.error_code) ? payload.error.error_code : 'unknown';
        throw Object.assign(new Error(`VK API error ${code}`), { fatal: true });
      }
      if (!Array.isArray(payload?.response?.items)) throw Object.assign(new Error('Invalid VK search response'), { fatal: true });
      return normalizeVkPosts(payload.response.items, { communityId, freshnessDays, minResultDate, now });
    },
  };
}

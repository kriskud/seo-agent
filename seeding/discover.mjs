import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, loadEnv } from '../lib.mjs';
import { createYandexProvider } from './providers/yandex.mjs';
import { normalizeResult } from './normalize.mjs';
import { readStore, writeStore, acquireLock } from './storage.mjs';

export function validateConfig(c) {
  const strings = a => Array.isArray(a) && a.length > 0 && a.every(s => typeof s === 'string' && s.trim());
  if (c.project !== 'cosmodesk' || c.language !== 'ru' || !strings(c.queries) || !strings(c.domains)
    || !Array.isArray(c.generalQueries) || !c.generalQueries.every(q => c.queries.includes(q))
    || !c.domains.every(d => /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(d))
    || !Number.isInteger(c.freshnessDays) || c.freshnessDays < 1 || c.freshnessDays > 365
    || !Number.isInteger(c.maxQueries) || c.maxQueries < 1 || c.maxQueries > 100) throw new Error('Invalid CosmoDesk seeding config');
  if (c.minResultDate !== null && (typeof c.minResultDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.minResultDate)
    || !Number.isFinite(Date.parse(c.minResultDate)) || new Date(c.minResultDate).toISOString().slice(0, 10) !== c.minResultDate)) {
    throw new Error('minResultDate must be null or YYYY-MM-DD');
  }
}

export function planSearches(config, rotation = 0) {
  const targeted = config.queries.map((query, i) => ({ query, domain: config.domains[(i + rotation) % config.domains.length] }));
  const general = config.generalQueries.map(query => ({ query, domain: null }));
  // Interleave general searches so a smaller budget still discovers new sites.
  const plan = [];
  for (let i = 0; i < Math.max(targeted.length, general.length); i++) {
    if (targeted[i]) plan.push(targeted[i]);
    if (general[i]) plan.push(general[i]);
  }
  return [...new Map(plan.map(x => [JSON.stringify(x), x])).values()].slice(0, config.maxQueries);
}

export async function discover({ config, provider, store, now = new Date(), onError = () => {} }) {
  validateConfig(config);
  if (config.minResultDate && config.minResultDate > now.toISOString().slice(0, 10)) throw new Error('minResultDate is in the future');
  const rows = new Map(store.opportunities.map(row => [row.canonicalUrl, structuredClone(row)]));
  const plan = planSearches(config, store.rotation);
  const summary = { queriesPlanned: plan.length, queriesExecuted: 0, queriesSucceeded: 0, apiRequests: 0,
    resultsReceived: 0, newOpportunities: 0, duplicatesSkipped: 0, errors: 0, invalidResults: 0,
    cacheHits: 0, limitReached: false, resetsAt: null };
  const initialRequests = provider.apiRequests ?? 0;
  const initialCacheHits = provider.cacheHits ?? 0;
  const preview = new Map();
  for (const search of plan) {
    summary.queriesExecuted++;
    let results;
    try {
      results = await provider.search({ ...search, freshnessDays: config.freshnessDays,
        minResultDate: config.minResultDate, language: config.language, now });
      if (!Array.isArray(results)) throw new Error('Provider did not return an array');
    } catch (e) {
      if (e.code === 'SEARCH_BUDGET_EXHAUSTED') {
        summary.limitReached = true;
        summary.resetsAt = e.resetsAt;
        break;
      }
      summary.errors++; onError(e.message);
      if (e.fatal) break;
      continue;
    }
    summary.queriesSucceeded++;
    summary.resultsReceived += results.length;
    for (const result of results) {
      let row;
      try {
        row = normalizeResult(result, { project: config.project, source: provider.name,
          query: search.query, discoveredAt: now.toISOString() });
      } catch { summary.invalidResults++; summary.errors++; continue; }
      const existing = rows.get(row.canonicalUrl);
      if (existing) {
        existing.lastSeenAt = row.lastSeenAt;
        existing.matchedQueries = [...new Set([...existing.matchedQueries, search.query])];
        summary.duplicatesSkipped++;
      } else { rows.set(row.canonicalUrl, row); summary.newOpportunities++; }
      preview.set(row.canonicalUrl, rows.get(row.canonicalUrl));
    }
  }
  summary.apiRequests = (provider.apiRequests ?? 0) - initialRequests;
  summary.cacheHits = (provider.cacheHits ?? 0) - initialCacheHits;
  return {
    summary, preview: [...preview.values()],
    store: { ...store, rotation: store.rotation + (summary.errors === 0 && !summary.limitReached ? 1 : 0), opportunities: [...rows.values()] },
  };
}

export async function runDiscovery({ config, provider, file, dryRun = false, now = new Date(), onError }) {
  const release = dryRun ? () => {} : acquireLock(file);
  try {
    const out = await discover({ config, provider, store: readStore(file), now, onError });
    out.saved = !dryRun && out.summary.queriesSucceeded > 0;
    if (out.saved) writeStore(file, out.store);
    return out;
  } finally { release(); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('Usage: node seeding/discover.mjs [--dry-run]'); return; }
  if (args.some(a => a !== '--dry-run')) throw new Error('Unknown argument. Use --help.');
  const dryRun = args.includes('--dry-run');
  const config = JSON.parse(readFileSync(join(ROOT, 'seeding/config/cosmodesk.json'), 'utf8'));
  validateConfig(config);
  loadEnv();
  const provider = createYandexProvider();
  const file = join(ROOT, 'data/seeding/cosmodesk.json');
  console.log(`CosmoDesk seeding discovery${dryRun ? ' (dry run — opportunities not saved; budget is recorded)' : ''}\n`);
  console.log(`Daily HTTP request limit: ${provider.dailyLimit} (UTC)`);
  const out = await runDiscovery({ config, provider, file, dryRun, onError: message => console.error(`[seeding] ${message}`) });
  const labels = { queriesPlanned: 'Queries planned', queriesExecuted: 'Queries executed', apiRequests: 'API requests',
    resultsReceived: 'Results received', newOpportunities: 'New opportunities', duplicatesSkipped: 'Duplicates skipped',
    errors: 'Errors', invalidResults: 'Invalid results', cacheHits: 'Cache hits' };
  for (const [key, label] of Object.entries(labels)) console.log(`${label}: ${out.summary[key]}`);
  if (out.summary.limitReached) console.log(`Daily limit reached. Search paused until ${out.summary.resetsAt}. Run again after that time.`);
  if (dryRun) console.log('\nResults:\n' + JSON.stringify(out.preview, null, 2));
  else if (out.saved) console.log(`\nStored: ${file}`);
  if (out.summary.errors) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => { console.error(`[seeding] ${e.message}`); process.exitCode = 1; });
}

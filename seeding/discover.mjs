import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, loadEnv } from '../lib.mjs';
import { createSerperProvider } from './providers/serper.mjs';
import { createRedditRssProvider } from './providers/reddit-rss.mjs';
import { normalizeResult, isSeedableThread } from './normalize.mjs';
import { readStore, writeStore, acquireLock } from './storage.mjs';

export const PROJECTS = ['floprooms', 'drill'];

export function validateConfig(c) {
  const strings = a => Array.isArray(a) && a.length > 0 && a.every(s => typeof s === 'string' && s.trim());
  if (!PROJECTS.includes(c.project)
    || !Number.isInteger(c.freshnessDays) || c.freshnessDays < 1 || c.freshnessDays > 365
    || !Number.isInteger(c.maxQueries) || c.maxQueries < 1 || c.maxQueries > 100
    || !Array.isArray(c.banks) || c.banks.length === 0) throw new Error('Invalid seeding config');
  for (const b of c.banks) {
    if (!['ru', 'en'].includes(b.language) || !strings(b.queries) || !strings(b.domains)
      || !Array.isArray(b.generalQueries) || !b.generalQueries.every(q => b.queries.includes(q))
      || !b.domains.every(d => /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(d))) throw new Error('Invalid seeding config bank');
  }
  if (c.reddit !== undefined && (!strings(c.reddit.subreddits) || !strings(c.reddit.keywords)
    || !c.reddit.subreddits.every(s => /^[A-Za-z0-9_]{2,21}$/.test(s)))) throw new Error('Invalid reddit config');
  if (c.minResultDate !== null && (typeof c.minResultDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.minResultDate)
    || !Number.isFinite(Date.parse(c.minResultDate)) || new Date(c.minResultDate).toISOString().slice(0, 10) !== c.minResultDate)) {
    throw new Error('minResultDate must be null or YYYY-MM-DD');
  }
}

export function planSearches(config, rotation = 0) {
  const bankPlans = config.banks.map(bank => {
    const targeted = bank.queries.map((query, i) => ({ query, domain: bank.domains[(i + rotation) % bank.domains.length], language: bank.language }));
    const general = bank.generalQueries.map(query => ({ query, domain: null, language: bank.language }));
    // Interleave general searches so a smaller budget still discovers new sites.
    const plan = [];
    for (let i = 0; i < Math.max(targeted.length, general.length); i++) {
      if (targeted[i]) plan.push(targeted[i]);
      if (general[i]) plan.push(general[i]);
    }
    return plan;
  });
  // Round-robin across banks so a small maxQueries still covers every language.
  const merged = [];
  for (let i = 0; i < Math.max(...bankPlans.map(p => p.length)); i++) {
    for (const plan of bankPlans) if (plan[i]) merged.push(plan[i]);
  }
  return [...new Map(merged.map(x => [JSON.stringify(x), x])).values()].slice(0, config.maxQueries);
}

export function planRedditSweep(config) {
  return (config.reddit?.subreddits ?? []).map(sub => ({ query: 'r/' + sub, domain: null, language: 'en' }));
}

export async function discover({ config, provider, store, now = new Date(), onError = () => {}, searchPlan, rotationKey = 'rotation' }) {
  validateConfig(config);
  if (config.minResultDate && config.minResultDate > now.toISOString().slice(0, 10)) throw new Error('minResultDate is in the future');
  const rows = new Map(store.opportunities.map(row => [row.canonicalUrl, structuredClone(row)]));
  const plan = searchPlan ?? planSearches(config, store[rotationKey] ?? 0);
  const summary = { queriesPlanned: plan.length, queriesExecuted: 0, queriesSucceeded: 0, apiRequests: 0,
    resultsReceived: 0, newOpportunities: 0, duplicatesSkipped: 0, nonThreadsSkipped: 0, errors: 0,
    invalidResults: 0, cacheHits: 0, limitReached: false, resetsAt: null };
  const initialRequests = provider.apiRequests ?? 0;
  const initialCacheHits = provider.cacheHits ?? 0;
  const preview = new Map();
  for (const search of plan) {
    summary.queriesExecuted++;
    let results;
    try {
      results = await provider.search({ ...search, freshnessDays: config.freshnessDays,
        minResultDate: config.minResultDate, now });
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
      if (!isSeedableThread(row.canonicalUrl)) { summary.nonThreadsSkipped++; continue; }
      const existing = rows.get(row.canonicalUrl);
      if (existing) {
        existing.lastSeenAt = row.lastSeenAt;
        existing.matchedQueries = [...new Set([...existing.matchedQueries, search.query])];
        existing.sources = [...new Set([...(existing.sources ?? [existing.source]), row.source])];
        if (!existing.publishedAt && row.publishedAt) existing.publishedAt = row.publishedAt;
        summary.duplicatesSkipped++;
      } else { rows.set(row.canonicalUrl, row); summary.newOpportunities++; }
      preview.set(row.canonicalUrl, rows.get(row.canonicalUrl));
    }
  }
  summary.apiRequests = (provider.apiRequests ?? 0) - initialRequests;
  summary.cacheHits = (provider.cacheHits ?? 0) - initialCacheHits;
  return {
    summary, preview: [...preview.values()],
    store: { ...store, [rotationKey]: (store[rotationKey] ?? 0) + (summary.queriesSucceeded > 0 && summary.errors === 0 && !summary.limitReached ? 1 : 0), opportunities: [...rows.values()] },
  };
}

export async function runDiscovery({ config, provider, file, dryRun = false, now = new Date(), onError,
  makePlan, rotationKey = 'rotation' }) {
  const release = dryRun ? () => {} : acquireLock(file);
  try {
    const store = readStore(file);
    const out = await discover({ config, provider, store, now, onError,
      searchPlan: makePlan?.(store), rotationKey });
    out.saved = !dryRun && out.summary.queriesSucceeded > 0;
    if (out.saved) writeStore(file, out.store);
    return out;
  } finally { release(); }
}

function printSummary(name, summary) {
  const labels = { queriesPlanned: 'Queries planned', queriesExecuted: 'Queries executed', apiRequests: 'HTTP requests',
    resultsReceived: 'Results received', newOpportunities: 'New opportunities', duplicatesSkipped: 'Duplicates skipped',
    nonThreadsSkipped: 'Non-thread results skipped', errors: 'Errors', invalidResults: 'Invalid results', cacheHits: 'Cache hits' };
  console.log(`\n[${name}]`);
  for (const [key, label] of Object.entries(labels)) console.log(`${label}: ${summary[key]}`);
  if (summary.limitReached) console.log(`Daily limit reached. Search paused until ${summary.resetsAt}. Run again after that time.`);
}

async function main() {
  const args = process.argv.slice(2);
  const usage = `Usage: node seeding/discover.mjs --project <${PROJECTS.join('|')}> [--dry-run] [--verbose]`;
  if (args.includes('--help')) { console.log(usage); return; }
  const projectIndex = args.indexOf('--project');
  const project = projectIndex >= 0 ? args[projectIndex + 1] : null;
  const rest = projectIndex >= 0 ? args.slice(0, projectIndex).concat(args.slice(projectIndex + 2)) : args;
  if (!PROJECTS.includes(project) || rest.some(a => a !== '--dry-run' && a !== '--verbose')) throw new Error(usage);
  const dryRun = args.includes('--dry-run');
  const config = JSON.parse(readFileSync(join(ROOT, `seeding/config/${project}.json`), 'utf8'));
  validateConfig(config);
  if (config.project !== project) throw new Error(`Config project mismatch: ${config.project}`);
  loadEnv();
  const file = join(ROOT, `data/seeding/${project}.json`);
  const onError = message => console.error(`[seeding] ${message}`);
  console.log(`${project} seeding discovery${dryRun ? ' (dry run — opportunities not saved; budget is recorded)' : ''}`);
  const serper = createSerperProvider();
  console.log(`Daily Serper request limit: ${serper.dailyLimit} (UTC, shared across projects)`);
  const previews = [];
  let errors = 0, saved = false;
  const out = await runDiscovery({ config, provider: serper, file, dryRun, onError });
  printSummary('serper', out.summary);
  errors += out.summary.errors; saved ||= out.saved; previews.push(...out.preview);
  if (config.reddit) {
    const reddit = createRedditRssProvider({ keywords: config.reddit.keywords });
    const sweep = await runDiscovery({ config, provider: reddit, file, dryRun, onError,
      makePlan: () => planRedditSweep(config), rotationKey: 'redditRotation' });
    printSummary('reddit-rss', sweep.summary);
    errors += sweep.summary.errors; saved ||= sweep.saved; previews.push(...sweep.preview);
  }
  if (args.includes('--verbose')) console.log('\nResults:\n' + JSON.stringify(previews, null, 2));
  if (saved) console.log(`\nStored: ${file}`);
  else if (!dryRun) console.log('\nNothing stored (no successful queries).');
  if (errors) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => { console.error(`[seeding] ${e.message}`); process.exitCode = 1; });
}

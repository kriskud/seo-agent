import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib.mjs';
import { acquireLock, writeStore } from './storage.mjs';

// The Google Custom Search JSON API free tier is 100 requests/day per project;
// the default limit keeps a safety margin. One budget file is shared by every
// seeding config using the same API key.
export function createDailyBudget({ env = process.env,
  file = join(ROOT, 'data/seeding/google-budget.json'), clock = () => new Date() } = {}) {
  const value = env.GOOGLE_SEARCH_DAILY_LIMIT ?? '90';
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('GOOGLE_SEARCH_DAILY_LIMIT must be a non-negative integer');
  }
  const limit = Number(value);
  return {
    limit,
    reserve() {
      let release;
      try {
        release = acquireLock(file);
        const day = clock().toISOString().slice(0, 10);
        let state;
        try { state = JSON.parse(readFileSync(file, 'utf8')); }
        catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (state && (state.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(state.day)
          || !Number.isSafeInteger(state.used) || state.used < 0 || state.day > day)) {
          throw new Error('Invalid budget state');
        }
        if (!state || state.day < day) state = { version: 1, day, used: 0 };
        if (state.used >= limit) {
          const e = new Error(`Daily Google request limit reached (${state.used}/${limit}, UTC). No HTTP request sent.`);
          e.code = 'SEARCH_BUDGET_EXHAUSTED';
          e.resetsAt = new Date(Date.parse(day) + 864e5).toISOString();
          throw e;
        }
        // Reserve BEFORE sending. Failed/uncertain requests and crashes consume
        // the reservation; never refund a potentially billable HTTP attempt.
        state.used++;
        writeStore(file, state);
      } catch (cause) {
        const e = cause.code === 'SEARCH_BUDGET_EXHAUSTED' ? cause
          : new Error('Cannot safely reserve Google daily budget; no HTTP request sent. Check budget file and lock.');
        e.fatal = true;
        throw e;
      } finally { release?.(); }
    },
  };
}

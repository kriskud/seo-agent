import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib.mjs';
import { writeStore } from './storage.mjs';

export function createSearchCache({ directory = join(ROOT, 'data/seeding/yandex-cache'),
  clock = () => Date.now(), ttlMs = 6 * 3600e3 } = {}) {
  const path = body => join(directory, createHash('sha256').update(body).digest('hex') + '.json');
  return {
    get(body) {
      try {
        const entry = JSON.parse(readFileSync(path(body), 'utf8'));
        const age = clock() - entry.savedAt;
        if (entry.version !== 1 || !Number.isFinite(age) || age < 0 || age >= ttlMs
          || !Array.isArray(entry.results) || !entry.results.every(r => r && typeof r.url === 'string')) return null;
        return entry.results;
      } catch { return null; } // Cache failure is a miss; the budget still applies.
    },
    set(body, results) {
      mkdirSync(directory, { recursive: true });
      writeStore(path(body), { version: 1, savedAt: clock(), results });
    },
  };
}

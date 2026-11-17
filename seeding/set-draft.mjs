// Кладёт готовый черновик ответа в строку реестра — вызывается драфтером
// (seeding/draft.mjs) по ssh: JSON на stdin, обновление под локом.
//
//   echo '{"project":"drill","id":"<id или префикс ≥12>","draft":"...","model":"sonnet"}' \
//     | node seeding/set-draft.mjs
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../lib.mjs';
import { PROJECTS } from './discover.mjs';
import { readStore, writeStore, acquireLock } from './storage.mjs';

export function applyDraft(store, id, draft, model, now = new Date()) {
  if (typeof id !== 'string' || id.length < 12) throw new Error('Draft id must be at least 12 characters');
  if (typeof draft !== 'string' || !draft.trim()) throw new Error('Empty draft');
  const matches = store.opportunities.filter(r => r.id === id || r.id.startsWith(id));
  if (matches.length !== 1) throw new Error(`Draft id matches ${matches.length} rows`);
  const row = matches[0];
  row.draft = draft.trim();
  row.draftedAt = now.toISOString();
  row.draftModel = model ?? null;
  return row;
}

function main() {
  const { project, id, draft, model } = JSON.parse(readFileSync(0, 'utf8'));
  if (!PROJECTS.includes(project)) throw new Error(`Unknown project: ${project}`);
  const file = join(ROOT, `data/seeding/${project}.json`);
  const release = acquireLock(file);
  try {
    const store = readStore(file);
    const row = applyDraft(store, id, draft, model);
    writeStore(file, store);
    console.log(`ok ${row.id.slice(0, 12)}`);
  } finally { release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}

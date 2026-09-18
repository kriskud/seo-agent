import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function readStore(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return { version: 1, rotation: 0, opportunities: [] }; throw e; }
  const data = JSON.parse(text);
  if (data.version !== 1 || !Number.isSafeInteger(data.rotation) || data.rotation < 0 || !Array.isArray(data.opportunities)) {
    throw new Error('Invalid seeding store; refusing to overwrite');
  }
  const seen = new Set();
  for (const row of data.opportunities) {
    if (typeof row.canonicalUrl !== 'string' || !Array.isArray(row.matchedQueries) || seen.has(row.canonicalUrl)) {
      throw new Error('Invalid or duplicate stored opportunity; refusing to overwrite');
    }
    seen.add(row.canonicalUrl);
  }
  return data;
}

export function acquireLock(file) {
  mkdirSync(dirname(file), { recursive: true });
  const lock = file + '.lock';
  try { mkdirSync(lock); }
  catch (e) {
    if (e.code === 'EEXIST') throw new Error('Seeding is already running (or stale .lock directory; see README)');
    throw e;
  }
  return () => rmSync(lock, { recursive: true, force: true });
}

export function writeStore(file, store) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temp, JSON.stringify(store, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
}

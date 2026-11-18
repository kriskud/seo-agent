// Состояние прогонов между запусками cron: когда источник опрашивали последний
// раз (троттлинг) и на каком месте остановилась ротация запросов.
// Один файл data/leads/state.json, запись атомарная.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib.mjs';
import { writeStore } from './store.mjs';

export function createState({ file = join(ROOT, 'data/leads/state.json'), clock = () => Date.now() } = {}) {
  let data = { version: 1, lastRun: {}, cursors: {} };
  try {
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    if (stored.version === 1 && stored.lastRun && stored.cursors) data = stored;
  } catch { /* Нет файла или он повреждён — начинаем с чистого состояния. */ }
  let dirty = false;
  return {
    /** Пора ли опрашивать источник (минимальный интервал в минутах). */
    due(name, minutes) {
      if (!minutes) return true;
      const last = Date.parse(data.lastRun[name] ?? '');
      // Метка из будущего (переставили часы) — считаем, что пора.
      if (!Number.isFinite(last) || last > clock()) return true;
      return clock() - last >= minutes * 60e3;
    },
    mark(name) {
      data.lastRun[name] = new Date(clock()).toISOString();
      dirty = true;
    },
    /** Следующие `count` индексов из списка длины `length` по кругу. */
    nextIndexes(name, length, count) {
      if (!length) return [];
      const start = Number.isSafeInteger(data.cursors[name]) ? data.cursors[name] : 0;
      const take = Math.min(count, length);
      const out = Array.from({ length: take }, (_, i) => (start + i) % length);
      data.cursors[name] = (start + take) % length;
      dirty = true;
      return out;
    },
    save() {
      if (dirty) writeStore(file, data);
      dirty = false;
    },
  };
}

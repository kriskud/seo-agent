// Дневной лимит запросов к Яндекс Поиск API (платный). Резерв ДО отправки:
// неудачный или неясный запрос всё равно съедает квоту — возврат не делаем.
// Восстановлено из seeding/budget.mjs коммита 7c089c1 (CosmoDesk-посев).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../lib.mjs';
import { acquireLock, writeStore } from '../store.mjs';

export function createDailyBudget({ env = process.env,
  file = join(ROOT, 'data/leads/yandex-budget.json'), clock = () => new Date() } = {}) {
  const value = env.YANDEX_SEARCH_DAILY_LIMIT ?? '20';
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('YANDEX_SEARCH_DAILY_LIMIT должен быть целым неотрицательным числом');
  }
  const limit = Number(value);
  return {
    limit,
    /** Сколько запросов уже потрачено сегодня (UTC). Без блокировки — только для отчёта. */
    used(now = clock()) {
      try {
        const state = JSON.parse(readFileSync(file, 'utf8'));
        return state.day === now.toISOString().slice(0, 10) ? state.used : 0;
      } catch { return 0; }
    },
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
          throw new Error('Повреждённый файл бюджета');
        }
        if (!state || state.day < day) state = { version: 1, day, used: 0 };
        if (state.used >= limit) {
          const e = new Error(`Дневной лимит Яндекс Поиска исчерпан (${state.used}/${limit}, UTC). HTTP-запрос не отправлен.`);
          e.code = 'SEARCH_BUDGET_EXHAUSTED';
          e.resetsAt = new Date(Date.parse(day) + 864e5).toISOString();
          throw e;
        }
        state.used++;
        writeStore(file, state);
      } catch (cause) {
        const e = cause.code === 'SEARCH_BUDGET_EXHAUSTED' ? cause
          : new Error(`Не могу надёжно зарезервировать дневной бюджет Яндекса, запрос не отправлен: ${cause.message}`);
        e.fatal = true;
        throw e;
      } finally { release?.(); }
    },
  };
}

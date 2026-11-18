// Атомарная запись и блокировка для состояния leads (бюджет, кэш, троттлинг).
// Намеренно не переиспользуем seeding/storage.mjs: leads не должен зависеть от
// модуля посева (он живёт своей жизнью и имеет свои сообщения об ошибках).
import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function writeStore(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
}

/** Блокировка через mkdir: атомарна и не зависит от флоков файловой системы. */
export function acquireLock(file) {
  mkdirSync(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  try { mkdirSync(lock); }
  catch (e) {
    if (e.code === 'EEXIST') throw new Error(`Занято другим прогоном (или остался каталог ${lock} — удалить вручную)`);
    throw e;
  }
  return () => rmSync(lock, { recursive: true, force: true });
}

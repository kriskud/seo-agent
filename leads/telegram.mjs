// Публичные Telegram-каналы через веб-превью https://t.me/s/<канал>:
// без логина, без API, отдаются последние ~20 сообщений канала.
// Чаты (группы) превью не имеют — там t.me/s отвечает 302, такие в конфиг не берём.
import { UA } from '../lib.mjs';

const TEXT = /<div class="[^"]*\bjs-message_text\b[^"]*"[^>]*>([\s\S]*?)<\/div>/;
const TIME = /<time datetime="([^"]+)"/;

/** HTML → текст: <br> в перевод строки, остальные теги долой, сущности назад. */
export function messageText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))) // &#33; = «!», &#8381; = «₽»
    .replace(/&amp;/g, '&')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n') // Пробелы от вырезанных тегов по краям строк.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function parseTelegram(html, channel) {
  const chunks = html.split('data-post="').slice(1);
  const out = [];
  for (const chunk of chunks) {
    const post = chunk.slice(0, chunk.indexOf('"'));
    const [, name, num] = /^([\w\d_]+)\/(\d+)$/.exec(post) ?? [];
    if (!name || (channel && name.toLowerCase() !== channel.toLowerCase())) continue;
    const body = TEXT.exec(chunk);
    if (!body) continue; // Фото без подписи, сервисные сообщения.
    const text = messageText(body[1]);
    if (!text) continue;
    const iso = TIME.exec(chunk)?.[1];
    out.push({
      id: `tg:${name}/${num}`,
      source: `TG @${name}`,
      url: `https://t.me/${name}/${num}`,
      // В канале нет заголовков — первая строка и есть заголовок.
      title: text.split('\n')[0].slice(0, 160),
      text,
      budget: null,
      createdAt: iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toISOString() : null,
      kind: 'post',
    });
  }
  return out;
}

/**
 * Канал-спамер виден по повторам: один и тот же рекламный пост 20 раз подряд.
 * Доля уникальных начал сообщений ниже порога — канал целиком отбрасываем.
 */
export function uniqueRatio(items) {
  if (!items.length) return 1;
  const heads = new Set(items.map((i) => i.text.slice(0, 120)));
  return heads.size / items.length;
}

export async function telegram({ channels, minUniqueRatio = 0.5, warn = console.warn }) {
  const out = [];
  for (const channel of channels) {
    let html;
    try {
      const res = await fetch(`https://t.me/s/${channel}`, {
        headers: { 'user-agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(20000),
      });
      // 302 — канал приватный, удалён или это группа: превью нет.
      if (res.status !== 200) { warn(`[leads] t.me/s/${channel}: HTTP ${res.status} — превью нет`); continue; }
      html = await res.text();
    } catch (e) {
      warn(`[leads] t.me/s/${channel}: ${e.message}`);
      continue;
    }
    const items = parseTelegram(html, channel);
    if (uniqueRatio(items) < minUniqueRatio) {
      warn(`[leads] t.me/s/${channel}: повторяющиеся посты — похоже на спам-канал, пропускаю`);
      continue;
    }
    out.push(...items);
  }
  return out;
}

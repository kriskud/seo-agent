// Поиск заказов для iamonline: биржи (Kwork, FL.ru) и Reddit r/forhire →
// фильтр под услуги и бюджет → новые заказы в Telegram и в reports/leads-latest.md.
// Запуск: node leads/run.mjs [--dry-run] [--verbose]. По расписанию — leads/cron.sh.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadEnv, today } from '../lib.mjs';
import { SOURCES } from './sources.mjs';
import { qualify } from './match.mjs';

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const VERBOSE = args.has('--verbose');
const DIR = join(ROOT, 'data', 'leads');
const SEEN = join(DIR, 'seen.json');
const SEEN_TTL_DAYS = 60;

const SERVICE_LABEL = { bot: 'бот', miniApp: 'Mini App', crm: 'CRM', saas: 'SaaS', site: 'лендинг' };

export function formatLead(l) {
  const money = l.budget ? `${l.budget.amount.toLocaleString('ru-RU')} ${l.budget.currency === 'USD' ? '$' : '₽'}` : 'бюджет не указан';
  const what = l.services.map((s) => SERVICE_LABEL[s]).join(', ');
  const text = l.text.length > 280 ? `${l.text.slice(0, 280)}…` : l.text;
  return `${l.source} · ${what} · ${money}\n${l.title}\n${text}\n${l.url}`;
}

async function notify(env, leads, max) {
  if (!env.LEADS_TG_BOT_TOKEN || !env.LEADS_TG_CHAT_ID || !leads.length) return false;
  const chunks = [];
  for (let i = 0; i < Math.min(leads.length, max); i++) chunks.push(formatLead(leads[i]));
  if (leads.length > max) chunks.push(`…и ещё ${leads.length - max} — см. reports/leads-latest.md`);
  for (const text of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${env.LEADS_TG_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: env.LEADS_TG_CHAT_ID, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Telegram: HTTP ${res.status} ${await res.text()}`);
  }
  return true;
}

function writeDigest() {
  // Последние 7 дней найденного — для просмотра без Telegram.
  const days = readdirSync(DIR).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-7).reverse();
  const lines = ['# Заказы для iamonline (последние 7 дней)', '', `Обновлено: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`, ''];
  for (const d of days) {
    const leads = readFileSync(join(DIR, d), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    lines.push(`## ${d.slice(0, 10)} — ${leads.length}`, '');
    for (const l of leads) lines.push(`- ${formatLead(l).split('\n').join(' — ')}`);
    lines.push('');
  }
  mkdirSync(join(ROOT, 'reports'), { recursive: true });
  writeFileSync(join(ROOT, 'reports', 'leads-latest.md'), lines.join('\n'));
}

export async function main() {
  const env = { ...loadEnv(), ...process.env };
  const config = JSON.parse(readFileSync(join(ROOT, 'leads', 'config.json'), 'utf8'));
  mkdirSync(DIR, { recursive: true });
  const firstRun = !existsSync(SEEN);
  const seen = firstRun ? {} : JSON.parse(readFileSync(SEEN, 'utf8'));
  const since = Date.now() - config.freshnessDays * 864e5;

  const found = [];
  const summary = [];
  for (const [name, opts] of Object.entries(config.sources)) {
    try {
      const items = await SOURCES[name](opts);
      summary.push(`${name}: ${items.length}`);
      found.push(...items);
    } catch (e) {
      summary.push(`${name}: ошибка (${e.message})`);
    }
  }

  const fresh = found.filter((l) => !l.createdAt || Date.parse(l.createdAt) >= since);
  const qualified = fresh.map((l) => qualify(l, config)).filter(Boolean);
  const fresh_new = qualified.filter((l) => !seen[l.id]);
  if (VERBOSE) for (const l of qualified) console.log(`${seen[l.id] ? '  (было)' : '  NEW'} ${l.source} ${l.services.join(',')} ${l.title}`);

  const now = today();
  let sent = false;
  if (!DRY) {
    for (const l of fresh_new) seen[l.id] = now;
    const cutoff = new Date(Date.now() - SEEN_TTL_DAYS * 864e5).toISOString().slice(0, 10);
    for (const [id, d] of Object.entries(seen)) if (d < cutoff) delete seen[id];
    writeFileSync(SEEN, JSON.stringify(seen));
    if (fresh_new.length) appendFileSync(join(DIR, `${now}.jsonl`), fresh_new.map((l) => JSON.stringify(l)).join('\n') + '\n');
    writeDigest();
    // Первый прогон только запоминает уже висящие заказы, чтобы не завалить чат.
    if (!firstRun) sent = await notify(env, fresh_new, config.maxPerNotification);
  }
  console.log(`[leads] ${summary.join(', ')}; свежих ${fresh.length}, подходят ${qualified.length}, новых ${fresh_new.length}${sent ? ', отправлено в Telegram' : ''}${firstRun ? ' (первый прогон — без уведомлений)' : ''}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

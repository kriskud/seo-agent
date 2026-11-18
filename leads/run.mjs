// Поиск заказов для iamonline: биржи (Kwork, FL.ru), Reddit, публичные
// Telegram-каналы, Hacker News и вопросы с намерением в поисковой выдаче →
// фильтр под услуги, бюджет и намерение → новые заказы в Telegram
// и в reports/leads-latest.md.
// Запуск: node leads/run.mjs [--dry-run] [--verbose] [--force] [--only=источник].
// --force игнорирует minIntervalMinutes (дневной бюджет Яндекса всё равно действует).
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadEnv, today } from '../lib.mjs';
import { SOURCES } from './sources.mjs';
import { qualify } from './match.mjs';
import { createState } from './state.mjs';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => !a.startsWith('--only=')));
const ONLY = args.find((a) => a.startsWith('--only='))?.slice(7).split(',').filter(Boolean);
const DRY = flags.has('--dry-run');
const VERBOSE = flags.has('--verbose');
const FORCE = flags.has('--force');
const DIR = join(ROOT, 'data', 'leads');
const SEEN = join(DIR, 'seen.json');
const SEEN_TTL_DAYS = 60;

const SERVICE_LABEL = { bot: 'бот', miniApp: 'Mini App', crm: 'CRM', saas: 'SaaS', site: 'лендинг' };

export function formatLead(l) {
  const money = l.budget ? `${l.budget.amount.toLocaleString('ru-RU')} ${l.budget.currency === 'USD' ? '$' : '₽'}` : 'бюджет не указан';
  const what = l.services.map((s) => SERVICE_LABEL[s]).join(', ');
  const text = l.text.length > 280 ? `${l.text.slice(0, 280)}…` : l.text;
  const head = [l.source, what, money, l.context].filter(Boolean).join(' · ');
  return `${head}\n${l.title}\n${text}\n${l.url}`;
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
  // Окно свежести можно переопределить для источника: в ежемесячном треде HN
  // заказы висят неделями, а на бирже заказ старше трёх дней уже разобрали.
  const sinceFor = (origin) => Date.now() - (config.sources[origin]?.freshnessDays ?? config.freshnessDays) * 864e5;
  const state = createState();
  const warn = (m) => { if (VERBOSE) console.warn(m); };

  const found = [];
  const summary = [];
  // Источники, уведомления от которых уходят в Telegram. Биржи (Kwork, FL.ru)
  // шумят и демпингуют — они собираются в отчёт, но в чат не пишут.
  const notifyFrom = new Set();
  for (const [name, opts] of Object.entries(config.sources)) {
    if (ONLY && !ONLY.includes(name)) continue;
    if (opts.enabled === false) { summary.push(`${name}: выключен`); continue; }
    if (opts.notify !== false) notifyFrom.add(name);
    // Минимальный интервал: Reddit отдаёт 429, Яндекс Поиск стоит денег.
    if (!FORCE && !state.due(name, opts.minIntervalMinutes)) { summary.push(`${name}: пауза`); continue; }
    if (!DRY) state.mark(name); // Отмечаем попытку, а не успех: иначе ошибка = опрос каждые 20 минут.
    try {
      const items = await SOURCES[name]({ ...opts, warn }, { state, warn });
      summary.push(`${name}: ${items.length}`);
      for (const item of items) found.push({ ...item, origin: name });
    } catch (e) {
      summary.push(`${name}: ошибка (${e.message})`);
    }
  }

  const fresh = found.filter((l) => !l.createdAt || Date.parse(l.createdAt) >= sinceFor(l.origin));
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
    state.save();
    // Первый прогон только запоминает уже висящие заказы, чтобы не завалить чат.
    if (!firstRun) sent = await notify(env, fresh_new.filter((l) => notifyFrom.has(l.origin)), config.maxPerNotification);
  }
  console.log(`[leads] ${summary.join(', ')}; свежих ${fresh.length}, подходят ${qualified.length}, новых ${fresh_new.length}${sent ? ', отправлено в Telegram' : ''}${firstRun ? ' (первый прогон — без уведомлений)' : ''}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

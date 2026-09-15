// AI-видимость по логам nginx: визиты AI-краулеров (GPTBot, ClaudeBot, …)
// и переходы людей из AI-сервисов (ChatGPT, Perplexity, …) по referer.
// Сайту в sites.json нужен "accessLog": путь к access-логу (плюс ротации
// <путь>.1 и <путь>.N.gz); опционально "logHost" — фильтр по host="…" для
// логов в формате с host. Логи читаются через sudo -n. Окно — 7 дней.
// Результат — data/aibots/<site>-<date>.json.
import { spawnSync } from 'node:child_process';
import { loadSites, saveData } from './lib.mjs';

const WINDOW_DAYS = 7;
const since = Date.now() - WINDOW_DAYS * 864e5;

// [имя, регэксп по User-Agent]
const BOTS = [
  ['GPTBot', /gptbot/i],
  ['OAI-SearchBot', /oai-searchbot/i],
  ['ChatGPT-User', /chatgpt-user/i],
  ['ClaudeBot', /claudebot/i],
  ['Claude-User', /claude-user/i],
  ['Claude-SearchBot', /claude-searchbot/i],
  ['PerplexityBot', /perplexitybot/i],
  ['Perplexity-User', /perplexity-user/i],
  ['Google-Extended', /google-extended/i],
  ['GoogleOther', /googleother/i],
  ['Bytespider', /bytespider/i],
  ['CCBot', /ccbot/i],
  ['Meta-External', /meta-external/i],
  ['Amazonbot', /amazonbot/i],
  ['Applebot', /applebot/i],
  ['DuckAssistBot', /duckassistbot/i],
  ['MistralAI', /mistralai/i],
  ['Cohere', /cohere/i],
  ['YouBot', /youbot/i],
];

// [источник, регэксп по referer]
const AI_REFERRERS = [
  ['ChatGPT', /https?:\/\/(chatgpt\.com|chat\.openai\.com)/i],
  ['Perplexity', /https?:\/\/([a-z.]*\.)?perplexity\.ai/i],
  ['Gemini', /https?:\/\/(gemini|bard)\.google\.com/i],
  ['Copilot', /https?:\/\/copilot\.microsoft\.com|bing\.com\/chat/i],
  ['Claude', /https?:\/\/claude\.ai/i],
  ['You.com', /https?:\/\/you\.com/i],
  ['Phind', /https?:\/\/(www\.)?phind\.com/i],
  ['Poe', /https?:\/\/(www\.)?poe\.com/i],
];

function readLog(file) {
  const zip = file.endsWith('.gz');
  const res = spawnSync('sudo', ['-n', zip ? 'zcat' : 'cat', file], { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' });
  return res.status === 0 ? res.stdout : null;
}

function* logLines(base) {
  for (let i = 0; i <= WINDOW_DAYS + 1; i++) {
    const file = i === 0 ? base : i === 1 ? `${base}.1` : `${base}.${i}.gz`;
    const text = readLog(file);
    if (text == null) continue;
    yield* text.split('\n');
  }
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// Понимает оба наших формата: стандартный combined ("req" st sz "ref" "ua")
// и infra_main (host="…" request="…" referer="…" ua="…").
function parseLine(line) {
  const dm = /\[(\d+)\/(\w+)\/(\d+):(\d+):(\d+):(\d+) ([+-]\d{4})\]/.exec(line);
  if (!dm) return null;
  const ts = Date.UTC(+dm[3], MONTHS[dm[2]] ?? 0, +dm[1], +dm[4], +dm[5], +dm[6]) - (+dm[7].slice(0, 3)) * 3600e3;
  let host = null, request, referer, ua;
  if (line.includes('ua="')) {
    host = /host="([^"]*)"/.exec(line)?.[1] ?? null;
    request = /request="([^"]*)"/.exec(line)?.[1] ?? '';
    referer = /referer="([^"]*)"/.exec(line)?.[1] ?? '';
    ua = /ua="([^"]*)"/.exec(line)?.[1] ?? '';
  } else {
    const q = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    if (q.length < 3) return null;
    [request, referer, ua] = q;
  }
  const path = request.split(' ')[1] ?? '';
  return { ts, host, path, referer, ua };
}

const bump = (map, key, path, ts) => {
  const e = map.get(key) ?? { hits: 0, last: 0, pages: new Map() };
  e.hits++;
  e.last = Math.max(e.last, ts);
  e.pages.set(path, (e.pages.get(path) ?? 0) + 1);
  map.set(key, e);
};
const finalize = (map) =>
  Object.fromEntries(
    [...map.entries()].sort((a, b) => b[1].hits - a[1].hits).map(([k, e]) => [k, {
      hits: e.hits,
      lastDate: new Date(e.last).toISOString().slice(0, 10),
      topPages: [...e.pages.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([p, n]) => `${p} (${n})`),
    }])
  );

for (const site of loadSites()) {
  if (!site.accessLog) continue;
  const bots = new Map();
  const refs = new Map();
  let scanned = 0;
  for (const line of logLines(site.accessLog)) {
    const p = line && parseLine(line);
    if (!p || p.ts < since) continue;
    if (site.logHost && p.host && p.host !== site.logHost && p.host !== `www.${site.logHost}`) continue;
    scanned++;
    const bot = BOTS.find(([, rx]) => rx.test(p.ua));
    if (bot) { bump(bots, bot[0], p.path, p.ts); continue; }
    const ref = AI_REFERRERS.find(([, rx]) => rx.test(p.referer));
    if (ref) bump(refs, ref[0], p.path, p.ts);
  }
  const out = {
    windowDays: WINDOW_DAYS,
    requests: scanned,
    bots: finalize(bots),
    referrals: finalize(refs),
  };
  const file = saveData('aibots', site.name, out);
  console.log(
    `[aibots] ${site.name}: ${scanned} запросов за ${WINDOW_DAYS}д, AI-краулеров=${Object.values(out.bots).reduce((s, b) => s + b.hits, 0)}, AI-переходов=${Object.values(out.referrals).reduce((s, b) => s + b.hits, 0)} → ${file}`
  );
}

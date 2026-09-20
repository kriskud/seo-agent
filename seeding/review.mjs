import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../lib.mjs';
import { readStore, writeStore, acquireLock } from './storage.mjs';

export const REVIEW_STATUSES = ['relevant', 'maybe', 'noise', 'discovered'];

// Deterministic display heuristic for manual triage ordering only. It is not a
// classifier and is never stored: matched queries, competitor mentions and
// query-word hits in title/snippet, plus a known-platform bonus.
export function scoreRow(row, config) {
  const text = (row.title + ' ' + row.snippet).toLowerCase();
  let score = row.matchedQueries.length * 2;
  for (const c of config.competitors ?? []) if (text.includes(c.toLowerCase())) score += 2;
  const words = new Set(config.queries.flatMap(q => q.toLowerCase().split(/\s+/)).filter(w => w.length >= 4));
  for (const w of words) if (text.includes(w)) score += 1;
  if (row.platform !== 'web') score += 1;
  return score;
}

export function applyStatus(store, id, status, now = new Date()) {
  if (!REVIEW_STATUSES.includes(status)) throw new Error('Invalid review status');
  const row = store.opportunities.find(r => r.id === id);
  if (!row) throw new Error('Unknown opportunity id');
  row.status = status;
  if (status === 'discovered') delete row.reviewedAt;
  else row.reviewedAt = now.toISOString();
  return row;
}

// Localhost-only guard against DNS rebinding: the Host header must be the
// loopback name this server was started on.
export function hostAllowed(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function rowView(row, config) {
  return {
    id: row.id, score: scoreRow(row, config), platform: row.platform, title: row.title,
    snippet: row.snippet, matchedQueries: row.matchedQueries, domain: row.domain,
    url: row.canonicalUrl, status: row.status, publishedAt: row.publishedAt, discoveredAt: row.discoveredAt,
  };
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Seeding review</title>
<style>
  body { font: 14px/1.45 system-ui, sans-serif; margin: 16px; color: #1a1a1a; }
  .counters { display: flex; gap: 16px; margin-bottom: 12px; flex-wrap: wrap; }
  .counters b { font-size: 18px; }
  .filters { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .filters input, .filters select { padding: 4px 6px; }
  #q { width: 260px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid #ddd; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { position: sticky; top: 0; background: #fff; }
  td.snippet div { max-width: 420px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; cursor: pointer; }
  td.snippet div.open { -webkit-line-clamp: unset; }
  td.actions { white-space: nowrap; }
  td.actions button { margin-right: 4px; padding: 2px 8px; border: 1px solid #bbb; background: #f6f6f6; border-radius: 4px; cursor: pointer; }
  tr.relevant td.actions .b-relevant, tr.relevant td.status { background: #d3f2d3; }
  tr.maybe td.actions .b-maybe, tr.maybe td.status { background: #fdf0c2; }
  tr.noise td.actions .b-noise, tr.noise td.status { background: #f6d3d3; }
  .muted { color: #777; }
</style>
<h2>Seeding review</h2>
<div class="counters" id="counters"></div>
<div class="filters">
  <input id="q" placeholder="Поиск: title / snippet / domain" type="search">
  <select id="platform"></select>
  <select id="query"></select>
  <select id="status">
    <option value="">Статус: все</option>
    <option value="discovered">Unreviewed</option>
    <option value="relevant">Relevant</option>
    <option value="maybe">Maybe</option>
    <option value="noise">Noise</option>
  </select>
  <select id="sort">
    <option value="desc">Score: по убыванию</option>
    <option value="asc">Score: по возрастанию</option>
  </select>
</div>
<table>
  <thead><tr><th>Score</th><th>Platform</th><th>Title</th><th>Snippet</th><th>Matched query</th><th>Domain</th><th>URL</th><th>Status</th><th></th></tr></thead>
  <tbody id="rows"></tbody>
</table>
<p class="muted">Score — эвристика только для сортировки при ручном разборе (совпавшие запросы, слова запросов и конкуренты в тексте). Клик по snippet раскрывает его. Повторный клик по активному статусу возвращает Unreviewed.</p>
<script>
  var all = [];
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function counters() {
    var c = { total: all.length, relevant: 0, maybe: 0, noise: 0, unreviewed: 0 };
    all.forEach(function (r) { if (c[r.status] !== undefined) c[r.status]++; else c.unreviewed++; });
    var box = document.getElementById('counters');
    box.textContent = '';
    [['total', c.total], ['relevant', c.relevant], ['maybe', c.maybe], ['noise', c.noise], ['unreviewed', c.unreviewed]].forEach(function (p) {
      var d = el('div', null, p[0] + ': ');
      d.appendChild(el('b', null, String(p[1])));
      box.appendChild(d);
    });
  }
  function fillSelect(id, label, values) {
    var s = document.getElementById(id);
    var current = s.value;
    s.textContent = '';
    s.appendChild(new Option(label, ''));
    values.forEach(function (v) { s.appendChild(new Option(v, v)); });
    s.value = values.indexOf(current) >= 0 ? current : '';
  }
  function setStatus(row, status, tr) {
    var next = row.status === status ? 'discovered' : status;
    fetch('api/status', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: row.id, status: next }) })
      .then(function (r) { if (!r.ok) return r.text().then(function (t) { throw new Error(t); }); row.status = next; render(); })
      .catch(function (e) { alert('Не сохранено: ' + e.message); });
  }
  function render() {
    counters();
    var q = document.getElementById('q').value.toLowerCase();
    var platform = document.getElementById('platform').value;
    var query = document.getElementById('query').value;
    var status = document.getElementById('status').value;
    var order = document.getElementById('sort').value === 'asc' ? 1 : -1;
    var rows = all.filter(function (r) {
      if (platform && r.platform !== platform) return false;
      if (query && r.matchedQueries.indexOf(query) < 0) return false;
      if (status && r.status !== status) return false;
      if (q && (r.title + ' ' + r.snippet + ' ' + r.domain).toLowerCase().indexOf(q) < 0) return false;
      return true;
    }).sort(function (a, b) { return (a.score - b.score) * order || a.url.localeCompare(b.url); });
    var body = document.getElementById('rows');
    body.textContent = '';
    rows.forEach(function (r) {
      var tr = el('tr', r.status);
      tr.appendChild(el('td', null, String(r.score)));
      tr.appendChild(el('td', null, r.platform));
      tr.appendChild(el('td', null, r.title || '—'));
      var snip = el('td', 'snippet');
      var d = el('div', null, r.snippet || '—');
      d.onclick = function () { d.classList.toggle('open'); };
      snip.appendChild(d);
      tr.appendChild(snip);
      tr.appendChild(el('td', null, r.matchedQueries.join('; ')));
      tr.appendChild(el('td', null, r.domain));
      var link = el('a', null, 'открыть ↗');
      link.href = r.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      var tdUrl = el('td'); tdUrl.appendChild(link); tr.appendChild(tdUrl);
      tr.appendChild(el('td', 'status', r.status === 'discovered' ? 'unreviewed' : r.status));
      var actions = el('td', 'actions');
      [['relevant', 'Relevant'], ['maybe', 'Maybe'], ['noise', 'Noise']].forEach(function (p) {
        var b = el('button', 'b-' + p[0], p[1]);
        b.onclick = function () { setStatus(r, p[0], tr); };
        actions.appendChild(b);
      });
      tr.appendChild(actions);
      body.appendChild(tr);
    });
    if (!rows.length) {
      var tr = el('tr'); var td = el('td', 'muted', all.length ? 'Ничего не подходит под фильтры.' : 'Реестр пуст — запустите discovery.');
      td.colSpan = 9; tr.appendChild(td); body.appendChild(tr);
    }
  }
  function load() {
    fetch('api/opportunities').then(function (r) { return r.json(); }).then(function (data) {
      all = data.opportunities;
      fillSelect('platform', 'Платформа: все', Array.from(new Set(all.map(function (r) { return r.platform; }))).sort());
      var queries = Array.from(new Set([].concat.apply([], all.map(function (r) { return r.matchedQueries; })))).sort();
      fillSelect('query', 'Запрос: все', queries);
      render();
    });
  }
  ['q', 'platform', 'query', 'status', 'sort'].forEach(function (id) {
    document.getElementById(id).addEventListener('input', render);
  });
  load();
</script>
`;

function readBody(request, limit = 4096) {
  return new Promise((done, fail) => {
    let size = 0;
    const chunks = [];
    request.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { fail(new Error('Body too large')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    request.on('error', fail);
  });
}

export function createReviewServer({ file, config }) {
  const server = createServer(async (request, response) => {
    const fail = (code, message) => { response.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end(message); };
    try {
      const port = server.address().port;
      if (!hostAllowed(request.headers.host, port)) return fail(403, 'Forbidden host');
      const path = new URL(request.url, `http://127.0.0.1:${port}`).pathname;
      if (request.method === 'GET' && path === '/') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return response.end(PAGE);
      }
      if (request.method === 'GET' && path === '/api/opportunities') {
        const store = readStore(file);
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return response.end(JSON.stringify({ opportunities: store.opportunities.map(row => rowView(row, config)) }));
      }
      if (request.method === 'POST' && path === '/api/status') {
        // application/json is not a CORS-safelisted content type, so cross-site
        // pages cannot send it here without a preflight (which we never allow).
        if (!/^application\/json\b/.test(request.headers['content-type'] ?? '')) return fail(415, 'Expected application/json');
        const { id, status } = JSON.parse(await readBody(request));
        if (typeof id !== 'string' || typeof status !== 'string') return fail(400, 'Expected {id, status}');
        let release;
        try { release = acquireLock(file); }
        catch { return fail(409, 'Store is locked (discovery running?) — retry shortly'); }
        try {
          const store = readStore(file);
          applyStatus(store, id, status);
          writeStore(file, store);
        } finally { release(); }
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return response.end('{"ok":true}');
      }
      fail(404, 'Not found');
    } catch (e) {
      fail(400, e.message);
    }
  });
  return server;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) { console.log('Usage: node seeding/review.mjs [--port N]'); return; }
  const portIndex = args.indexOf('--port');
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 8787;
  const known = portIndex >= 0 ? args.slice(0, portIndex).concat(args.slice(portIndex + 2)) : args;
  if (known.length || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Unknown argument. Use --help.');
  const config = JSON.parse(readFileSync(join(ROOT, 'seeding/config/cosmodesk.json'), 'utf8'));
  const file = join(ROOT, 'data/seeding/cosmodesk.json');
  const server = createReviewServer({ file, config });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Seeding review: http://127.0.0.1:${port}/ (localhost only)`);
    console.log(`С другой машины: ssh -L ${port}:127.0.0.1:${port} <host>, затем открыть тот же URL локально.`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}

// Недельный markdown-отчёт по каждому сайту: аудит + GSC + Вебмастер,
// дельты к прошлому снимку, SEO-возможности. reports/<site>-<date>.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, loadSites, loadLastTwo, today } from './lib.mjs';

// Ожидаемый CTR по позиции — для поиска страниц с недобором кликов.
const expectedCtr = (pos) =>
  pos <= 1 ? 0.28 : pos <= 2 ? 0.15 : pos <= 3 ? 0.1 : pos <= 5 ? 0.06 : pos <= 7 ? 0.04 : pos <= 10 ? 0.03 : 0.015;

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('ru-RU') : '—');
const delta = (cur, prev) => {
  if (prev == null || cur == null) return '';
  const d = cur - prev;
  return d === 0 ? ' (=)' : ` (${d > 0 ? '+' : ''}${Math.round(d * 100) / 100})`;
};

for (const site of loadSites()) {
  const [audit, prevAudit] = loadLastTwo('audit', site.name);
  const [gsc, prevGsc] = loadLastTwo('gsc', site.name);
  const [ywm, prevYwm] = loadLastTwo('ywm', site.name);
  const lines = [`# SEO-отчёт: ${site.name} (${site.url})`, '', `Дата: ${today()}`, ''];

  if (audit) {
    lines.push('## Технический аудит', '');
    lines.push(
      `Страниц проверено: ${audit.pagesChecked}, ошибок: ${audit.errors}${delta(audit.errors, prevAudit?.errors)}, предупреждений: ${audit.warnings}${delta(audit.warnings, prevAudit?.warnings)}`,
      ''
    );
    const important = audit.issues.filter((i) => i.severity !== 'info');
    for (const issue of important.slice(0, 40)) {
      lines.push(`- ${issue.severity === 'error' ? '❌' : '⚠️'} \`${issue.type}\` ${issue.page} — ${issue.detail}`);
    }
    if (important.length > 40) lines.push(`- … и ещё ${important.length - 40}`);
    if (important.length === 0) lines.push('Ошибок и предупреждений нет.');
    lines.push('');
  }

  if (gsc) {
    lines.push('## Google Search Console (28 дней)', '');
    lines.push(
      `Клики: ${fmt(gsc.totals.clicks)}${delta(gsc.totals.clicks, prevGsc?.totals?.clicks)}, показы: ${fmt(gsc.totals.impressions)}${delta(gsc.totals.impressions, prevGsc?.totals?.impressions)}`,
      ''
    );
    const opps = gsc.rows
      .filter((r) => r.position >= 4 && r.position <= 20 && r.impressions >= 20)
      .map((r) => ({ ...r, gap: (expectedCtr(r.position) - r.ctr) * r.impressions }))
      .sort((a, b) => b.gap - a.gap)
      .slice(0, 10);
    if (opps.length) {
      lines.push('### Возможности (позиция 4–20, есть показы)', '');
      lines.push('| Запрос | Страница | Позиция | Показы | CTR |', '|---|---|---|---|---|');
      for (const o of opps) {
        lines.push(`| ${o.query} | ${o.page.replace(site.url, '') || '/'} | ${o.position.toFixed(1)} | ${fmt(o.impressions)} | ${(o.ctr * 100).toFixed(1)}% |`);
      }
      lines.push('');
    } else {
      lines.push('Возможностей с заметными показами пока нет (мало данных).', '');
    }
  } else if (site.gsc) {
    lines.push('## Google Search Console', '', '_Нет данных — коллектор не настроен или не отработал._', '');
  }

  if (ywm) {
    lines.push('## Яндекс.Вебмастер', '');
    const s = ywm.summary ?? {};
    lines.push(
      `ИКС: ${fmt(s.sqi)}${delta(s.sqi, prevYwm?.summary?.sqi)}, страниц в поиске: ${fmt(s.searchable_pages_count)}${delta(s.searchable_pages_count, prevYwm?.summary?.searchable_pages_count)}, исключено: ${fmt(s.excluded_pages_count)}${delta(s.excluded_pages_count, prevYwm?.summary?.excluded_pages_count)}`,
      ''
    );
    if (s.site_problems && Object.keys(s.site_problems).length) {
      lines.push(`Проблемы сайта: ${JSON.stringify(s.site_problems)}`, '');
    }
    if (ywm.queries?.length) {
      lines.push('### Популярные запросы (Яндекс)', '', '| Запрос | Показы | Клики | Ср. позиция |', '|---|---|---|---|');
      for (const q of ywm.queries.slice(0, 15)) {
        lines.push(`| ${q.query} | ${fmt(q.shows)} | ${fmt(q.clicks)} | ${q.position ?? '—'} |`);
      }
      lines.push('');
    }
  } else if (site.yandex) {
    lines.push('## Яндекс.Вебмастер', '', '_Нет данных — коллектор не настроен или не отработал._', '');
  }

  const dir = join(ROOT, 'reports');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${site.name}-${today()}.md`);
  const text = lines.join('\n') + '\n';
  writeFileSync(file, text);
  writeFileSync(join(dir, `${site.name}-latest.md`), text);
  console.log(`[report] ${site.name} → ${file}`);
}

# seo-agent

Лёгкий SEO-агент: набор zero-dependency Node-скриптов + systemd-таймер.
Каждый сервер несёт свою копию со своим `sites.json` и `.env`.

## Модули

| Скрипт | Что делает |
|---|---|
| `audit.mjs` | Технический аудит по sitemap: title/meta/canonical/H1/noindex, битые внутренние ссылки, orphan-страницы |
| `collect-gsc.mjs` | Search Console API → клики/показы/позиции по query+page |
| `collect-ywm.mjs` | Яндекс.Вебмастер API → ИКС, страницы в поиске, популярные запросы, диагностика (проблемы/рекомендации), статистика обхода (сайты с `yandex: true`) |
| `collect-aibots.mjs` | Логи nginx → визиты AI-краулеров (GPTBot, ClaudeBot, PerplexityBot…) и переходы из AI-сервисов по referer (сайты с `accessLog`) |
| `indexnow.mjs` | Пинг IndexNow (Яндекс/Bing) списком URL или всем sitemap (сайты с `indexnow: true`) |
| `report.mjs` | Markdown-отчёт с дельтами к прошлой неделе и SEO-возможностями → `reports/` |
| `run-weekly.sh` | Полный прогон (его дёргает `seo-agent.timer`) |

## Конфигурация

`sites.json`:

```json
{ "sites": [ { "name": "cosmodesk", "url": "https://cosmodesk.ru",
               "gsc": "sc-domain:cosmodesk.ru", "yandex": true, "indexnow": true } ] }
```

Если на сервере несколько проектов, которые не должны пересекаться одним
Google-аккаунтом, у каждого сайта укажите свой сервис-аккаунт полем
`"gscKey": "/etc/seo-agent/gsc-<site>.json"` — общий `GSC_SERVICE_ACCOUNT`
из `.env` остаётся фолбэком.

`.env` (chmod 600, не в git):

```
YANDEX_WEBMASTER_ACCESS_TOKEN=…   # + CLIENT_ID/SECRET/REFRESH_TOKEN для автообновления
GSC_SERVICE_ACCOUNT=/path/key.json  # или GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN
INDEXNOW_KEY=…                      # файл <key>.txt должен лежать в корне сайта
```

## Данные

`data/<kind>/<site>-<date>.json` — история снимков; отчёт сравнивает два
последних. `reports/<site>-latest.md` — всегда свежий отчёт.

## Ручной запуск

```sh
./run-weekly.sh                 # полный прогон
node audit.mjs                  # только аудит
node indexnow.mjs cosmodesk     # пингануть весь sitemap
node indexnow.mjs cosmodesk https://cosmodesk.ru/guides  # конкретные URL
```

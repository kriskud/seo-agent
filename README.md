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

## Заказы для iamonline (leads)

Cron каждые 20 минут ищет людей, которым нужна разработка (боты, Mini Apps,
CRM, лендинги): точные фразы «ищу разработчика бота…» в Яндекс Поиске
(только UGC-площадки), Hacker News, Reddit. Биржи и «заказные» Telegram-каналы
выключены. Подробности и включение уведомлений: [leads/README.md](leads/README.md),
идеи привлечения клиентов: [leads/IDEAS.md](leads/IDEAS.md).

```sh
node leads/run.mjs --dry-run --verbose --force
node --test leads/*.test.mjs
```

## Посев (seeding)

В `main` — покерная версия (floprooms, drill): Serper + Reddit RSS, только
поиск тредов, ответы вручную. См. [seeding/POKER.md](seeding/POKER.md).

CosmoDesk-версия (Яндекс Поиск, VK, Telegram-источники) из `main` удалена,
код в истории: `git show 7c089c1` (Яндекс-discovery), состояние до
удаления — `git show fb23093^:seeding/` (VK и Phase 2). Клиент Яндекс Поиска из неё
переиспользован в `leads/search/`.

## Threads-агент

Посты по расписанию через официальный Threads API и черновики ответов в
Telegram (публикация ответов — только вручную). Код готов, вживую не
запускался. [threads/README.md](threads/README.md), настройка Meta —
[threads/SETUP_META.md](threads/SETUP_META.md).

## Состояние частей

[ROADMAP.md](ROADMAP.md) — что работает, что ждёт настройки.

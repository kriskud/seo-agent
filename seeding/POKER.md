# Seeding для floprooms и drill (vps2)

Ветка `feat/poker-seeding`: discovery свежих обсуждений под ручной посев для
двух покерных проектов. Яндекс-, VK- и Telegram-части ветки cosmodesk сюда
сознательно не входят: провайдеры — только Serper.dev (выдача Google по API) и
публичные Atom-ленты Reddit. Никакого автопостинга: модуль только находит
треды; ответы пишутся и публикуются вручную.

История: изначально основным провайдером был Google Custom Search JSON API,
но он закрыт для новых клиентов и полностью отключается к 2027-01-01 —
2026-09-26 заменён на Serper (тот же интерфейс провайдера, те же банки
запросов).

## Источники

- **Serper.dev** (основной): настоящая выдача Google через
  `POST https://google.serper.dev/search` — и русские площадки (gipsyteam.ru,
  pokeroff.ru, dzen.ru — с vps2 GipsyTeam напрямую недоступен, но выдача его
  покрывает), и английские (forumserver.twoplustwo.com, reddit.com) через
  `site:`-запросы из банков в `seeding/config/<project>.json`. Свежесть —
  `tbs=qdr:dN` по `freshnessDays`; локаль банка задаёт `gl`/`hl` (ru→ru/ru,
  en→us/en).
- **Reddit RSS** (дополнительный, бесключевой): `reddit.com/r/<sub>/new.rss`,
  фильтрация по `reddit.keywords` конфига. Один HTTP-запрос на сабреддит.

Дзен исключён из банков 2026-09-26 (приоритет — англоязычная аудитория и
ЛатАм); тогда же добавлены es/pt-банки (Serper gl=mx/hl=es и gl=br/hl=pt-br;
площадки: poker-red.com, codigopoker.com, maisev.com — первый набор, уточнять
по результатам). Результаты, куда физически нельзя написать ответ (магазины приложений,
статьи без форума, лендинги, видео), отсеиваются автоматически ещё на
discovery — `isSeedableThread` в `normalize.mjs` (счётчик «Non-thread results
skipped» в сводке): reddit — только `/comments/`, GipsyTeam — только форум,
прочий веб — только URL с форумными сегментами (`/forum/`, `/topic/`, `/t/`,
`viewtopic`, …).

## Настройка (один раз)

1. Зарегистрироваться на [serper.dev](https://serper.dev/) и взять API-ключ
   с дашборда (2500 бесплатных запросов на старте, дальше от $50 за 50k).
2. На vps2 в `~/projects/seo-agent/.env` (chmod 600, не в git):

   ```
   SERPER_API_KEY=...
   ```

Serper списывает предоплаченные кредиты по запросу, поэтому локальный дневной
лимит — чистый контроль расходов: по умолчанию 90
(`SERPER_SEARCH_DAILY_LIMIT`), общий для обоих проектов: файл
`data/seeding/serper-budget.json`, кэш выдачи 6 часов в
`data/seeding/serper-cache/`. Оба конфига с `maxQueries: 20` тратят максимум
40 запросов/день без учёта кэша.

## Запуск

```
node seeding/discover.mjs --project floprooms [--dry-run] [--verbose]
node seeding/discover.mjs --project drill    [--dry-run] [--verbose]
```

Реестры раздельные: `data/seeding/floprooms.json` и `data/seeding/drill.json`.

Разбор находок (relevant / maybe / noise):

```
node seeding/review.mjs --project floprooms            # 127.0.0.1:8787
node seeding/review.mjs --project drill --port 8788
```

Вьюер слушает только localhost; с ноутбука:
`ssh -L 8787:127.0.0.1:8787 vps2` и открыть тот же URL локально.

## Драфтер (локально, не на vps2)

По помеченным relevant тредам `claude -p` пишет черновики ответов:

```
node seeding/draft.mjs --project drill [--limit N] [--model sonnet] [--dry-run]
```

Реестр забирается с vps2 по ssh; тред скачивается локальным curl с DoH
(местная сеть режет reddit на уровне DNS), reddit — Atom-фидом треда через
vps2 (JSON закрыт login-wall'ом и 403 для датацентров; между reddit-фетчами
пауза 65 с). Черновики — `data/seeding/drafts/<project>/<id>.md`, повторный
запуск дописывает только новые. В промпте зашиты ассеты обоих проектов и
правила: максимум одна ссылка, без бонус-кодов (CoinPoker!), язык треда,
сначала польза; неподходящий тред → `SKIP: причина`. Публикация — только
вручную. forumserver.twoplustwo.com не скачивается ни локально, ни с vps2
(Cloudflare) — такие треды читать руками.

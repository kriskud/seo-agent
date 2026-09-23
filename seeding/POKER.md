# Seeding для floprooms и drill (vps2)

Ветка `feat/poker-seeding`: discovery свежих обсуждений под ручной посев для
двух покерных проектов. Яндекс-, VK- и Telegram-части ветки cosmodesk сюда
сознательно не входят: провайдеры — только Google Custom Search JSON API и
публичные Atom-ленты Reddit. Никакого автопостинга: модуль только находит
треды; ответы пишутся и публикуются вручную.

## Источники

- **Google CSE** (основной): и русские (gipsyteam.ru, pokeroff.ru, dzen.ru — с
  vps2 GipsyTeam напрямую недоступен, но выдача Google его покрывает), и
  английские (forumserver.twoplustwo.com, reddit.com) площадки через
  `site:`-запросы из банков в `seeding/config/<project>.json`. Свежесть —
  `dateRestrict` по `freshnessDays`.
- **Reddit RSS** (дополнительный, бесключевой): `reddit.com/r/<sub>/new.rss`,
  фильтрация по `reddit.keywords` конфига. Один HTTP-запрос на сабреддит.

## Настройка (один раз)

1. В [Google Cloud Console](https://console.cloud.google.com/) включить
   «Custom Search API» и создать API key.
2. На [programmablesearchengine.google.com](https://programmablesearchengine.google.com/)
   создать движок с поиском по всему вебу («Search the entire web») и взять его
   идентификатор (cx).
3. На vps2 в `~/projects/seo-agent/.env` (chmod 600, не в git):

   ```
   GOOGLE_CSE_KEY=...
   GOOGLE_CSE_CX=...
   ```

Бесплатная квота — 100 запросов/день на проект Google Cloud. Локальный дневной
лимит по умолчанию 90 (`GOOGLE_SEARCH_DAILY_LIMIT`), общий для обоих проектов:
файл `data/seeding/google-budget.json`, кэш выдачи 6 часов в
`data/seeding/google-cache/`. Оба конфига с `maxQueries: 20` тратят максимум
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

## Что дальше по конвейеру

Следующий этап (не в этой ветке): по помеченным relevant тредам локальный
драфтер готовит черновики ответов (одна ссылка на подходящий ассет — тренажёр,
чарт, /withdrawal-gates, гайд; без бонус-кодов CoinPoker в тексте), публикация —
только вручную.

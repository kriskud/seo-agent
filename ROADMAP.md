# ROADMAP — состояние seo-agent

Обновлено: 2026-11-18. Приоритет — заказчики для iamonline; SEO — фоном.

| Часть | Состояние | Где |
|---|---|---|
| Еженедельный SEO-отчёт (cosmodesk, bodytime, iamonline) | работает: `seo-agent.timer`, понедельник 05:40 UTC. Отчёт пока есть только для cosmodesk; bodytime и iamonline добавлены недавно, первые отчёты ожидаются 2026-11-23 | [README](README.md) |
| leads — заказы для iamonline | работает, cron каждые 20 мин. Источники: Яндекс Поиск (UGC-площадки), HN, Reddit. Kwork/FL.ru и Telegram-каналы выключены. Уведомлений нет, пока не задан бот | [leads/README.md](leads/README.md), [идеи](leads/IDEAS.md) |
| seeding — посев | в `main` покерная версия (Serper + Reddit) для floprooms/drill — на этом сервере ключа Serper нет. CosmoDesk-версия (Яндекс/VK) удалена из `main`, есть в истории (`7c089c1`, удалена в `fb23093`) | [seeding/POKER.md](seeding/POKER.md) |
| threads — Threads-агент | код готов, тесты есть, вживую не запускался. Аккаунты: `cosmodesk_en` (active), `cosmodesk_ru` (draft) | [threads/README.md](threads/README.md) |

## Дальше (код)

- leads: если за 1–2 недели поиск даст <1 живого лида в неделю — сократить
  фразы до лучших.
- leads: виджет «Нужна доработка?» в CosmoDesk/BodyTime (IDEAS п. 2) — в
  репозиториях продуктов, не здесь.

## Что сделать Кристине

- [ ] **Telegram-бот для заказов**: @BotFather → `/newbot` → токен в `.env` как
      `LEADS_TG_BOT_TOKEN`; написать боту, открыть
      `https://api.telegram.org/bot<токен>/getUpdates`, взять `chat.id` →
      `LEADS_TG_CHAT_ID`. Подробно: [leads/README.md](leads/README.md#telegram-уведомления).
- [ ] **Прочитать [leads/IDEAS.md](leads/IDEAS.md)** и выбрать 2–3 пункта без кода
      (футер-ссылки, раздел «доработка» в продуктах, агентства).
- [ ] **Threads**: настройка Meta по [threads/SETUP_META.md](threads/SETUP_META.md);
      в `/etc/seo-agent/threads.env` — `ANTHROPIC_API_KEY`, `SERPER_API_KEY`,
      `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`; затем запуск по
      [threads/README.md](threads/README.md).
- [ ] **Решить по RU-аккаунту Threads** (`cosmodesk_ru` в статусе draft): заводить ли
      отдельный аккаунт или вести только EN.
- [ ] **Удалить слитые ветки на GitHub** (уже в `main`): `feat/cosmodesk-seeding-phase1`,
      `feat/poker-seeding`, `feat/threads-agent`, `chore/new-sites-ywm-skip`.
      Все четыре проверены: слиты в `main`. VK/Яндекс-код CosmoDesk останется
      в истории `main` (удалён коммитом `fb23093`, смотреть `git show fb23093^:seeding/discover-vk.mjs`).
- [ ] По желанию: `YANDEX_SEARCH_DAILY_LIMIT` в `.env` — сейчас 20 запросов в сутки.

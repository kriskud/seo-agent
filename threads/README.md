# Threads-агент

Один процесс на все аккаунты: пишет посты голосом основателя, публикует их по
расписанию через официальный Threads API, раз в день ищет чужие обсуждения и
присылает в Telegram черновики ответов. Свои посты выходят без подтверждения;
ответы в чужих тредах публикуются только вручную.

## Что где

- `accounts/<id>/` — всё, чем аккаунты отличаются: `account.json` (язык, сайт,
  расписание, поисковые запросы, UTM, статус), `voice.md`, `facts.md`,
  `examples.md` (эталонные посты через `---`, минимум 5), `banned.txt`.
- `/etc/seo-agent/threads.env` — ключи (образец: `threads.env.example`).
- `data/threads.db` — очередь, история, токены, обсуждения, метрики, расходы.

## Запуск на сервере

    python3 -m venv venv && venv/bin/pip install -r threads/requirements.txt
    sudo install -m 600 -o kris threads/threads.env.example /etc/seo-agent/threads.env   # и заполнить
    venv/bin/python -m threads.auth_bootstrap cosmodesk_en                               # SETUP_META.md
    venv/bin/python -m threads.cli gen cosmodesk_en 5                                    # посмотреть посты
    sudo cp threads/deploy/threads-agent.service /etc/systemd/system/ && sudo systemctl enable --now threads-agent

Проверка без Telegram: `venv/bin/python -m threads.cli` (список команд).
Тесты: `venv/bin/python -m unittest threads.tests.test_threads`.

## Управление (Telegram)

`/status`, `/queue`, `/leads`, `/stats`, `/gen <аккаунт>`, `/pause [аккаунт]`,
`/resume [аккаунт]`. `/pause` без аргумента останавливает всё сразу. Ответ на
сообщение с постом из `/queue` заменяет его текст; кнопка под постом отменяет.

## Новый аккаунт

1. Скопировать каталог существующего аккаунта в `accounts/<новый_id>/`, поправить
   все пять файлов. Пока продукт не готов — `"status": "draft"`: посты можно
   смотреть через `cli gen`, но ничего не публикуется и не ищется.
2. Токен: `SETUP_META.md`, раздел «Второй и следующие аккаунты».
3. Ссылку для био взять из `python -m threads.cli accounts` — в ней UTM аккаунта.
4. `"status": "active"` и `sudo systemctl restart threads-agent`.

## Статусы

Посты: `scheduled → publishing → published`, а также `cancelled`, `failed`
(после 3 попыток, с уведомлением). Обсуждения: `discovered → drafted →
published` (кнопка «Ответила») или `rejected` (низкий балл либо «Пропустить»).

## Если что-то сломалось

- Сервер перезагрузился — сервис поднимется сам; опоздавшие больше чем на 3 часа
  посты переносятся в следующие слоты, а не выходят пачкой.
- Процесс упал посреди публикации — при старте пост ищется среди последних
  постов аккаунта: найден — отмечается опубликованным, нет — возвращается в очередь.
- Токен отозван — бот пришлёт предупреждение; новый токен и `auth_bootstrap <аккаунт>`.
- База: `data/threads.db` — обычный SQLite, достаточно копии файла.
  Логи: `journalctl -u threads-agent`.

## Ограничения

- Поиск по ключевым словам в Threads API закрыт до App Review, поэтому обсуждения
  ищутся через Serper (выдача Google по threads.net/threads.com). Модель видит
  только сниппет из выдачи, сами страницы Threads не скачиваются.
- Метрика `views` у Meta помечена как «в разработке».

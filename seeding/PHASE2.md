# Phase 2: VK foundation and Telegram deployment review

Продолжение экспериментальной ветки `feat/cosmodesk-seeding-phase1`, без PR/merge
в `main`. VK реализован в отключённом состоянии. Telegram listener не реализован
и не подключён: сначала проверяется приведённое ниже предложение. Качество реальной
выдачи и доступность API ещё не проверены; Phase 3 classifier пока не добавляется.

## VK: ограниченный поиск по выбранным сообществам

`node seeding/discover-vk.mjs [--dry-run]` — отдельный ручной запуск. По умолчанию
`seeding/config/vk.json` содержит `enabled: false` и пустой `communityIds`.
В таком состоянии завершение успешное, API-запросов 0, token не загружается.
Для запуска нужны список **публичных** сообществ, их положительные числовые ID,
`enabled: true` и разрешённый для приложения `VK_ACCESS_TOKEN` в окружении процесса.
Не передавать token через CLI. Не помещать его в git. Предпочтителен service token
для публичных сообществ, без подключения личного аккаунта. Общий `.env` с доступом
других пользователей не подходит для секретов; не добавляйте туда VK token.

Используется `wall.search`, версия 5.199: `domain=club<ID>`, `extended=0`,
`owners_only=0`, одна страница с 20 результатами. Запросы из CosmoDesk-банка.
До 12 HTTP-попыток за запуск, последовательно, пауза 1.1 секунды; пагинации
и retry нет. При ошибке/429/captcha запуск останавливается, обхода нет.
Токен передаётся в POST body, ответы ошибок не логируются: VK может возвращать
в них request_params с токеном. В логе только HTTP/API code.

Фильтруются фактическая дата публикации (7 дней), владелец сообщества, пустые,
удалённые и помеченные рекламными записи. Сохраняются URL, текст записи в snippet,
короткий title и publishedAt; профили, вложения и содержимое repost payload не
сохраняются. Это поиск записей, **не комментариев и не всей сети VK**. На одной
странице можно не найти все свежие записи; гарантии полного покрытия нет.

Общий JSON-реестр с Yandex: `source` остаётся первым источником, `sources` содержит
все обнаружившие источники; `matchedQueries` объединяется. Из VK можно заполнить
ранее неизвестную publishedAt. Старые записи без sources поддерживаются.
Отдельный vkRotation не меняет Yandex rotation. Отбор не является LLM-классификацией.

Метод и типы access token проверены по
[официальной схеме VKCOM](https://github.com/VKCOM/vk-api-schema/blob/master/wall/methods.json).
Схема указывает user/service tokens, но не гарантирует доступ конкретного приложения:
это остаётся проверить с разрешённым token позже. Сообщества не выбраны автоматически.

## Telegram: конкретное предложение для проверки пользователем

На сервере обнаружены systemd 249 и `/usr/bin/node`. Пользователя `seoagent` пока
нет. Checkout `/home/kris/projects/seo-agent` принадлежит `kris`, родительский
projects имеет mode 0775. Он годится для разработки, но не для runtime с личной
Telegram-сессией: писатель кода мог бы выполнять его с правами listener.

| Объект | Предлагаемый путь | Owner | Mode |
|---|---|---|---|
| Runtime и закреплённые зависимости | `/opt/seo-agent-telegram/` | root:root | dirs 0755, code 0644 |
| Родитель конфигурации | `/etc/seo-agent/` | root:root | 0755 |
| Secrets directory | `/etc/seo-agent/secrets/` | seoagent:seoagent | 0700 |
| API credentials | `/etc/seo-agent/secrets/telegram.json` | seoagent:seoagent | 0600 |
| Родитель состояния | `/var/lib/seo-agent/` | root:root | 0755 |
| Session directory | `/var/lib/seo-agent/telegram/` | seoagent:seoagent | 0700 |
| Session file (формат зависит от библиотеки) | внутри session directory | seoagent:seoagent | 0600 |
| Приватные opportunities | `/var/lib/seo-agent/opportunities/` | seoagent:seoagent | dirs 0700, files 0600 |
| Allowlist | `/etc/seo-agent/telegram-sources.json` | root:seoagent | 0640 |
| Unit | `/etc/systemd/system/seo-agent-telegram.service` | root:root | 0644 |

`seoagent` — отдельный system user/group, без интерактивного shell, без SSH login,
без дополнительных групп; обычным пользователям не предоставляется sudo/run-as
этот UID. Deployment runtime выполняет доверенный администратор, не auto-pull
из изменяемого общего checkout. Никаких secrets/session в repository, runtime,
общем `.env`, CLI, debug или резервных копиях в общих каталогах.

Файл credentials содержит только api_id/api_hash; телефон, login code и 2FA
password не сохраняются. Конкретный формат существующей session **не исследовался**:
до review не читаем и не копируем её. Нужны только сведения о библиотеке/формате,
не значение session. Если библиотеке нужны постоянные auth artifacts, они находятся
только в session directory с указанными правами. Не создаём login flow сейчас.

Полный проект unit: [telegram-listener.service.proposed](deploy/telegram-listener.service.proposed).
В нём нет secrets, только пути; он не установлен. Проверка совместимости directives
выполняется на systemd 249, однако функциональный sandbox-тест будущего listener
ещё потребуется. Скрипты в ExecStartPre/ExecStart пока отсутствуют. Дополнительный
root-owned approval marker `/etc/seo-agent/telegram-approved` создаётся только
после проверки пользователем и завершения preflight-тестов. Сейчас marker не создан.

Preflight обязан до чтения secrets и подключения проверить effective UID, owner,
точные modes 0700/0600, родительские каталоги, ACL, symlinks/hardlinks и открытые
дескрипторы против подмены. Проверка недоступна — отказ. Session с 0644, чужой owner,
небезопасный путь или пустой allowlist — отказ без исправления прав и без сети.
Безопасные коды отказа показываются отдельной проверкой; production stdout/stderr
listener выключены, core dumps запрещены. До включения logs нужна отдельная проверка
редактирования ошибок сторонней библиотеки. Содержимое сообщений не логируется.

Пользователь выбрал 10 usernames в `config/telegram-sources.json`, только для
мониторинга/discovery. Файл содержит `enabled: false`, `peerId: null`, `type: null`:
реальные идентификаторы и типы не выдумываются. После проверки схемы безопасности
нужно разрешить только эти usernames, сверить тип group/channel, закрепить numeric
IDs и проверить соответствие выбранным источникам перед включением. Нельзя читать
историю с неразрешённым ID. Рабочую проверенную копию allowlist администратор
размещает в `/etc/seo-agent/telegram-sources.json` с mode 0640 root:seoagent.
Никаких wildcard и расширения списка по рекомендациям Telegram.
Username служит подсказкой, не устойчивой идентичностью. Личные диалоги и Saved
Messages запрещены даже при случайном добавлении в список. Listener опрашивает
только явные источники, без getDialogs, автоматического вступления и глобального
архивирования updates; возможность отключить глобальные updates нужно проверить
для выбранной библиотеки до подключения. Реализация, которая сначала получает
все личные сообщения, а потом фильтрует их, не соответствует требованиям.

Первоначальное окно — последние 7 дней, ограниченное число сообщений/источников
за проход; новые проходы используют cursor. В постоянное хранилище попадают только
совпадения по ручным CosmoDesk-ключевым словам, без LLM до следующей фазы. Хранятся
chat ID, message ID, ссылка при наличии, текст и timestamp; никаких авторских профилей,
телефонов или вложений. Несовпавшие сообщения отбрасываются, архив не создаётся.

Закрытые Telegram-источники не пишут в общий repo `data/`. До отдельного решения
об экспорте их opportunities остаются в приватном хранилище пользователя seoagent;
перенос в общий реестр автоматически не выполняется. Тот же URL-dedupe можно
переиспользовать, не ослабляя изоляцию приватных данных.

Root/unrestricted sudo могут прочитать сессию. Этот дизайн от них не защищает.
Если такой доступ есть у недоверенного человека, для личной сессии нужен другой сервер.

## Что требуется до подключения Telegram

1. Проверка пользователем storage/user/modes и полного unit выше.
2. Проверка numeric ID/type выбранных Telegram-источников и указание формата сессии
   без её содержимого. VK allowlist остаётся пустым: сообщества сначала обнаруживаются
   через Yandex discovery, потом добавляются только после ручной проверки.
3. Реализация и тесты preflight (0644, wrong owner, ACL, symlink, path substitution),
   проверки отсутствия чтения private dialogs и утечек в errors/logs.
4. Развёртывание доверенного runtime администратором и только затем подключение
   сессии. Никакие реальные credentials в текущем шаге не запрашиваются.

Наличие источника в allowlist не даёт permission на posting/replying. Все write
permissions явно false. Для любой отправки сообщений нужно отдельное разрешение
пользователя; текущая фаза такой возможности не содержит.

Справка по sandbox directives: [systemd v249](https://github.com/systemd/systemd/blob/v249/man/systemd.exec.xml).

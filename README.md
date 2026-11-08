# Service Desk для интеграции студентов

Стенд предоставляет две системы: **Identity** проверяет учётные данные и выдаёт токены, **Service Desk** хранит обращения и отправляет события в сервис студентов. Их приложение находится в отдельном репозитории.

В портале Artsofte заявитель создаёт обращение, следит за статусом, переписывается с поддержкой и закрывает обращение. Новое обращение назначается руководителю поддержки (`support-lead`). В портале исполнитель показан только для просмотра; распределение между сотрудниками студенты реализуют в своём сервисе. При закрытии исполнитель снимается.

## Запуск

Нужны Docker Engine с Compose v2 и Node.js из `.nvmrc`. Команды запускаются из корня репозитория:

```sh
node tools/setup-env.mjs
node tools/bootstrap.mjs --mode docker
node tools/bootstrap.mjs --mode docker --apply
```

Первая команда создаёт `.env` с локальными секретами. Если файл уже существует, используется `node tools/setup-env.mjs --extend`: он добавляет недостающие ключи и сохраняет прежние значения. Команда без `--apply` показывает план; с `--apply` — запускает контур и настраивает Identity.

| Раздел                             | Адрес                                   |
| ---------------------------------- | --------------------------------------- |
| Новое обращение                    | <http://localhost:8080/>                |
| Обращения и статусы                | <http://localhost:8080/requests>        |
| Управление пользователями Keycloak | <http://localhost:8081/admin/>          |
| Swagger                            | <http://localhost:8080/docs/>           |
| OpenAPI                            | <http://localhost:8080/docs/json>       |
| Issuer Identity                    | `http://localhost:8081/realms/training` |

Пять сервисов: `postgres`, `ldap`, `identity`, `migrate`, `service-desk`. Один PostgreSQL хранит БД `training`: таблицы Service Desk — в схеме `public`, Keycloak — в `identity`. `migrate` завершается с кодом `0`; остальные сервисы работают постоянно. API и Angular-портал собраны в одном контейнере.

```sh
docker compose ps --all
docker compose logs --tail=100 service-desk identity
docker compose down
```

Остановка без `--volumes` сохраняет данные. Отдельные приложения запускаются командами `pnpm identity:start` и `pnpm service-desk:start` в том же Compose-проекте. Порты, тома и перенос прежней БД Identity описаны в [запуске через Docker](docs/docker.md). `/health` проверяет работу процесса; вход и отправка уведомлений проверяются отдельно.

## Учётные записи

Пароли хранятся в локальной `.env`, их значений в репозитории нет.

| Логин           | Назначение                                   | Переменная пароля         |
| --------------- | -------------------------------------------- | ------------------------- |
| `alice`         | Алиса Иванова, заявитель                     | `LDAP_ALICE_PASSWORD`     |
| `support`       | Сергей Петров, сотрудник поддержки           | `LDAP_SUPPORT_PASSWORD`   |
| `support-lead`  | Руководитель поддержки, исходный исполнитель | `SUPPORT_LEAD_PASSWORD`   |
| `desk-admin`    | Администратор службы поддержки               | `DESK_ADMIN_PASSWORD`     |
| `denied`        | Проверка отказа в доступе                    | `LDAP_DENIED_PASSWORD`    |
| `administrator` | Администратор Keycloak, realm `master`       | `IDENTITY_ADMIN_PASSWORD` |

`GET /api/me` показывает текущего пользователя и роль. Пользователи, пароли и права меняются в Keycloak. Для каждого Service Desk нужен ровно один активный руководитель поддержки; без него или при нескольких руководителях создание обращения возвращает `503`. Пароль вводится только на странице Identity, API Service Desk проверяет JWT через JWKS.

## Подключение сервиса студентов

Параметры входа: публичный клиент `student-service`, Authorization Code + PKCE S256, callback `http://localhost:4300/auth/callback`, audience API `service-desk`. Роли передаются в `resource_access["service-desk"].roles`, раздел поддержки — в `team_slug`. Учётная запись LDAP без роли Service Desk не даёт доступ к API. Полный набор параметров — в [инструкции Identity](docs/identity.md).

При создании обращения Service Desk сохраняет историю и событие `jira:issue_created` в одной транзакции. Изменение статуса, комментарий или исполнитель создают `jira:issue_updated`. Получатель проверяет HMAC-подпись и исключает повторы по ID события. Адрес уведомлений задаёт администратор через `GET/PUT/PATCH /api/settings`; обработчик применяет его на следующем цикле. Успех создания обращения не подтверждает доставку уведомления: для проверки нужен доступный публичный HTTPS-получатель.

Поддерживаются 14 операций выбранного подмножества **Jira Service Management Data Center 10.3**. Формат запросов и отличия стенда — в [контракте API](docs/api-compatibility.md), вход и выход в Swagger — в [проверке API](docs/swagger.md).

## Настройки

`config/backend.json` — шаблон. Рабочий документ хранится в `SETTINGS_FILE` и создаётся только при отсутствии файла. `GET /api/settings` возвращает весь JSON, `PUT /api/settings` заменяет его целиком, а `PATCH /api/settings` меняет отдельные поля. Доступ есть только у администратора службы поддержки. Ответ PUT — `200`; заголовок `X-Restart-Required` сообщает, нужен ли перезапуск.

Секреты остаются в переменных окружения; JSON содержит только разрешённые имена этих переменных. Формат документа — в [настройках](docs/settings.md), управление доступом — в [инструкции администратора](docs/administration.md). `.env`, пароли администраторов и мастер-ключ подписи студентам не передаются.

## Подключение студентов

Студенты администрируют выданный стенд и подключают собственный проект. Три инструкции:

1. [Keycloak: пользователи и роли](docs/students/01-keycloak-and-roles.md).
2. [OpenID Connect и форма входа](docs/students/02-openid-connect.md).
3. [Интеграция с Service Desk: proxy, webhook и обращения](docs/students/03-service-desk.md).

Общий порядок работы — в [оглавлении интеграции](docs/student-integration.md).

## Разработка

Nx-приложения: `identity` и `service-desk`. Сервер — `apps/service-desk/src`, портал — `apps/service-desk/ui`, готовые контролы PrimeNG/Aura — `libs/ui`, общие SCSS-токены — `libs/theme`. Сервер использует строгий TypeScript, Fastify, Drizzle/PostgreSQL и слои `api → logic → dal`.

```sh
corepack enable
pnpm install --frozen-lockfile
node tools/bootstrap.mjs --mode dev --apply
pnpm start
```

Проверки выбираются по [матрице проверок](docs/agents/verification.md). Архитектура описана в [обзоре](docs/architecture/README.md), правила работы — в [AGENTS.md](AGENTS.md). HTTP-проверка закрытия: `node --env-file=.env tools/identity-smoke.mjs --close-request`. Она создаёт и закрывает одно обращение.

## Ограничения

Стенд воспроизводит выбранные методы Jira Data Center 10.3. Полной совместимости с Jira и Cloud API нет. Тип `10001` — учебная форма замены оборудования; формы `183` и `194` исследованы отдельно. Не реализованы вложения, участники, SLA, 1С, массовая генерация и сброс данных, автоматическое создание раздела Service Desk при добавлении пользователя Identity.

Корпоративные учётные записи и сервисы не используются. Локальный запуск не публикует стенд на VPS. Для внешнего доступа нужны HTTPS для Identity и API, защищённое подключение LDAP, хранение секретов и резервное копирование; их настройка выполняется отдельно.

Тексты интерфейса отредактированы по [ux-copy](https://github.com/N1arko/redaktura-skills/blob/main/ux-copy/SKILL.md), документация — по [redaktura](https://github.com/N1arko/redaktura-skills/blob/main/redaktura/SKILL.md). Технические имена полей, ролей и маршрутов сохраняются; пользовательские формулировки используют единый словарь службы поддержки.
